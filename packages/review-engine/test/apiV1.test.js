import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createV1Router } from '../../../routes/v1/index.js';
import { createCache, createIpKey, createLimiter, DAY, securityHeaders } from '../../../routes/v1/support.js';
import { scheduleShadow } from '../../../routes/v1/shadow.js';
import { lintOpenapi } from '../../../scripts/lint-openapi.mjs';
import { openapi } from '../../../routes/v1/openapi.js';
import { renderTemplate } from '../src/phrasing/templates.js';

const fixture = id => JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/gold/${id}.json.gz`, import.meta.url))));
const servers = [];
async function setup(options = {}) {
  const fetchMatch = vi.fn(async id => fixture(id));
  const app = express();
  app.use(securityHeaders, express.json());
  app.use(createV1Router({ fetchMatch, logger: { warn: vi.fn() }, ...options }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  return { fetchMatch, get: (path, init) => fetch(`http://127.0.0.1:${server.address().port}${path}`, init) };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map(s => new Promise(resolve => { s.closeAllConnections(); s.close(resolve); }))); });
const events = text => text.split('\n\n').filter(frame => frame.includes('event:')).map(frame => ({ id: Number(frame.match(/id: (\d+)/)[1]), event: frame.match(/event: (\w+)/)[1], data: JSON.parse(frame.match(/data: (.*)/)[1]) }));
const base = '/api/v1/review/9035042364';
const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('API v1 contract', () => {
  for (const id of [8985182860, 9035042364]) for (const lang of ['en', 'zh']) it(`JSON equals SSE ${id} ${lang}, ordered IDs and cached resume`, async () => {
    const raw = fixture(id);
    const hero = raw.players[0].hero_id;
    const { get, fetchMatch } = await setup();
    const url = `/api/v1/review/${id}`;
    const json = await (await get(`${url}?hero=${hero}&lang=${lang}`)).json();
    const response = await get(`${url}/stream?hero=${hero}&lang=${lang}`);
    const text = await response.text();
    expect(text.startsWith('retry: 3000\n\n')).toBe(true);
    const frames = events(text);
    expect(frames.map(e => e.id)).toEqual(frames.map((_, i) => i + 1));
    expect(frames.slice(0, 5).map(e => e.data.step)).toEqual(['fetch_match', 'parse_check', 'facts', 'insights', 'phrasing']);
    expect(frames.at(-1).event).toBe('done');
    expect(frames.at(-1).data.state).toBe(json.state);
    expect(frames.at(-1).data.review).toEqual(json);
    expect(frames.find(e => e.data.kind === 'result_header').data.payload).toEqual({ match: json.match, player: json.player, series_ref: 'series' });
    const resumed = events(await (await get(`${url}/stream?hero=${hero}&lang=${lang}`, { headers: { 'Last-Event-ID': '5' } })).text());
    expect(resumed).toEqual(frames.slice(5));
    expect(fetchMatch).toHaveBeenCalledTimes(1);
  });
  it('no hero exposes roster and ends needs_hero; only parsed JSON is public', async () => {
    const { get } = await setup();
    const response = await get(base);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300, stale-while-revalidate=86400');
    const review = await response.json();
    expect(review.player).toBeNull(); expect(review.insights).toEqual([]); expect(review.roster).toHaveLength(10);
    const frames = events(await (await get(`${base}/stream`)).text());
    expect(frames.find(e => e.event === 'hero_pick').data.roster).toEqual(review.roster);
    expect(frames.at(-1).data.state).toBe('needs_hero');
    const unparsed = await setup({ fetchMatch: async () => ({ match_id: 9035042364, od_data: { has_parsed: false }, players: [] }) });
    expect((await unparsed.get(base)).headers.get('cache-control')).toBe('no-store');
  });
  it('review misses are limited, cache hits are free, refill returns Retry-After', async () => {
    let time = Date.now();
    const { get } = await setup({ now: () => time, fetchMatch: async id => ({ match_id: id, players: [] }) });
    for (let i = 1; i <= 30; i++) expect((await get(`/api/v1/review/${i}`)).status).toBe(200);
    expect((await get('/api/v1/review/1')).status).toBe(200);
    const response = await get('/api/v1/review/31');
    expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('20');
    expect(await response.json()).toEqual({ code: 'RATE_LIMITED', retryable: true, message_key: 'err.rate_limited' });
    const stream = await get('/api/v1/review/31/stream');
    expect(stream.status).toBe(429); expect(stream.headers.get('retry-after')).toBe('20');
    expect(events(await stream.text()).map(e => e.event)).toEqual(['error']);
    time += 20000;
    expect((await get('/api/v1/review/31')).status).toBe(200);
  });
  it.each([[404, 'MATCH_NOT_FOUND'], [503, 'UPSTREAM_TIMEOUT'], [undefined, 'INTERNAL']])('sanitizes upstream errors %s', async (status, code) => {
    const { get } = await setup({ fetchMatch: async () => { throw Object.assign(new Error('secret api_key=123 upstream stack'), { status }); } });
    expect(await (await get(base)).json()).toMatchObject({ code });
    const text = await (await get(`${base}/stream`)).text();
    expect(text).not.toMatch(/secret|api_key|upstream stack/);
    const frames = events(text); expect(frames).toHaveLength(1); expect(frames[0]).toMatchObject({ event: 'error', data: { code } });
  });
  it.each(['0', '-1', '1.2', '1099511627777', 'abc', '1?hero=unknown', '1?lang=fr', '1?hero[]=14'])('rejects invalid input %s', async suffix => {
    const { get, fetchMatch } = await setup();
    const response = await get(`/api/v1/review/${suffix}`);
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: 'INVALID_INPUT' }); expect(fetchMatch).not.toHaveBeenCalled();
  });
  it('security headers apply to failures and documents; GET-only CORS', async () => {
    const { get } = await setup();
    for (const path of [base, '/openapi.json', '/llms.txt', '/api/v1/config', '/missing']) {
      const response = await get(path);
      expect(response.headers.get('content-security-policy-report-only')).toContain("frame-ancestors 'none'; base-uri 'none'");
      expect(response.headers.get('strict-transport-security')).toContain('max-age=');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
      expect(response.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
    }
    expect((await get(base)).headers.get('access-control-allow-origin')).toBe('*');
    expect((await get(`${base}/ask`, post({ hero: 14, question: 'why?' }))).headers.get('access-control-allow-origin')).toBeNull();
  });
  it('preset answers use PR3, reject hallucinations, and cache by language', async () => {
    const complete = vi.fn(async () => ({ text: '{"slots":"Invented 999999 gold."}' }));
    const { get } = await setup({ phrasingCompletion: complete });
    for (const lang of ['en', 'zh']) for (const followup_id of ['death_list', 'laning_0_10']) {
      const review = await (await get(`${base}?hero=pudge&lang=${lang}`)).json();
      const preset = review.followups.find(f => f.id === followup_id);
      const expected = renderTemplate(preset, review.facts, lang).text;
      const frames = events(await (await get(`${base}/ask`, post({ hero: 'pudge', lang, followup_id }))).text());
      expect(frames.map(e => e.event)).toEqual(['token', 'done']);
      expect(frames.at(-1).data.answer).toBe(expected);
      const calls = complete.mock.calls.length;
      expect(events(await (await get(`${base}/ask`, post({ hero: 14, lang, followup_id }))).text()).at(-1).data.answer).toBe(expected);
      expect(complete).toHaveBeenCalledTimes(calls);
    }
    expect(complete).toHaveBeenCalled();
  });
  it('provider failure falls back; valid slots succeed without exposing nicknames', async () => {
    const complete = vi.fn(async input => { expect(JSON.stringify(input)).not.toContain('personaname'); return { text: JSON.stringify({ slots: input.approved_clauses }) }; });
    const { get } = await setup({ phrasingCompletion: complete });
    const answer = events(await (await get(`${base}/ask`, post({ hero: 14, followup_id: 'death_list' }))).text()).at(-1).data;
    expect(answer.phrasing).toBe('llm');
    const broken = await setup({ phrasingCompletion: async () => { throw new Error('provider secret'); } });
    const text = await (await broken.get(`${base}/ask`, post({ hero: 14, followup_id: 'death_list' }))).text();
    expect(events(text).at(-1).data.phrasing).toBe('template'); expect(text).not.toContain('provider secret');
  });
  it('ask validates question and applies its separate hourly bucket', async () => {
    const { get } = await setup();
    expect(events(await (await get(`${base}/ask`, post({ hero: 14, question: 'x'.repeat(301) }))).text())[0].data.code).toBe('INVALID_INPUT');
    for (let i = 0; i < 20; i++) {
      const frames = events(await (await get(`${base}/ask`, post({ hero: 14, question: '\u0000where?\u0001' }))).text());
      expect(frames.at(-1).event).toBe('done');
    }
    const response = await get(`${base}/ask`, post({ hero: 14, question: 'why?' }));
    expect(response.status).toBe(429); expect(response.headers.get('retry-after')).toBe('180');
    expect(events(await response.text())[0].data.code).toBe('RATE_LIMITED');
  });
  it('free evidence questions use validated phrasing without caching; gap questions refuse', async () => {
    const complete = vi.fn(async input => ({ text: JSON.stringify({ slots: input.approved_clauses }) }));
    const { get } = await setup({ phrasingCompletion: complete });
    for (let i = 0; i < 2; i++) {
      const frames = events(await (await get(`${base}/ask`, post({ hero: 14, question: 'Show my deaths' }))).text());
      expect(frames.at(-1).data.phrasing).toBe('llm');
    }
    expect(complete).toHaveBeenCalledTimes(2);
    const frames = events(await (await get(`${base}/ask`, post({ hero: 14, question: 'Was my death position bad?' }))).text());
    expect(frames.at(-1).data.answer).toContain('not in this match');
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it('answers complete laning evidence through the validator', async () => {
    const raw = fixture(9035042364);
    raw.players.find(p => p.hero_id === 14).lane = 2;
    const complete = vi.fn(async input => ({ text: JSON.stringify({ slots: input.approved_clauses }) }));
    const { get } = await setup({ fetchMatch: async () => raw, phrasingCompletion: complete });
    const review = await (await get(`${base}?hero=14`)).json();
    const followup = review.followups.find(f => f.id === 'laning_0_10');
    expect(followup.answerable).toBe(true);
    const answer = events(await (await get(`${base}/ask`, post({ hero: 14, followup_id: 'laning_0_10' }))).text()).at(-1).data;
    expect(answer.answer).toBe(renderTemplate(followup, review.facts, 'en').text);
    expect(answer.phrasing).toBe('llm');
    expect(complete).toHaveBeenCalledOnce();
  });
  it('JSON Accept on stream returns the same review and unparsed streams finish unparsed', async () => {
    const { get } = await setup();
    const json = await (await get(`${base}?hero=14`)).json();
    expect(await (await get(`${base}/stream?hero=14`, { headers: { Accept: 'application/json' } })).json()).toEqual(json);
    const raw = fixture(9035042364); raw.od_data = { has_parsed: false };
    const unparsed = await setup({ fetchMatch: async () => raw });
    const frames = events(await (await unparsed.get(`${base}/stream?hero=14`)).text());
    expect(frames.at(-1).data.state).toBe('unparsed');
  });
  it('mounting v1 leaves legacy routes and response shapes intact', async () => {
    const app = express();
    const fetchMatch = vi.fn();
    app.use(createV1Router({ fetchMatch }));
    const legacy = { matchFact: { matchId: 42 }, grounded: true, threeConclusions: {} };
    app.get('/api/review/:matchId', (req, res) => res.json(legacy));
    app.post('/api/review/:matchId', (req, res) => res.json({ ...legacy, text: 'legacy' }));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); servers.push(server);
    const url = `http://127.0.0.1:${server.address().port}/api/review/42`;
    expect(await (await fetch(url)).json()).toEqual(legacy);
    expect(await (await fetch(url, { method: 'POST' })).json()).toEqual({ ...legacy, text: 'legacy' });
    expect(fetchMatch).not.toHaveBeenCalled();
  });
  it('heartbeats while upstream waits and cleans the interval on completion', async () => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const interval = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const { get } = await setup({ fetchMatch: () => pending });
    const response = await get(`${base}/stream`);
    const entry = interval.mock.calls.find(c => c[1] === 15000);
    expect(entry).toBeDefined(); entry[0]();
    finish(fixture(9035042364));
    expect(await response.text()).toContain(': ping\n\n'); expect(clear).toHaveBeenCalled();
  });
  it('OpenAPI 3.1 structure and references lint, including broken ref detection', async () => {
    expect(await lintOpenapi()).toBe(true);
    const broken = structuredClone(openapi); broken.components.schemas.Broken = { $ref: '#/missing' };
    await expect(lintOpenapi(broken)).rejects.toThrow('Unresolved reference');
  });
});

describe('cache, privacy and shadow support', () => {
  it('LRU capacity, TTL, and daily HMAC rotation', () => {
    let time = 0; const now = () => time;
    const cache = createCache({ max: 2, now });
    cache.set('a', 1, 100); cache.set('b', 2, 100); expect(cache.get('a')).toBe(1); cache.set('c', 3, 100); expect(cache.get('b')).toBeUndefined();
    time = 100; expect(cache.get('a')).toBeUndefined();
    const hash = createIpKey(now); const req = { socket: { remoteAddress: '1.2.3.4' }, headers: {} };
    const key = hash(req); expect(key).toMatch(/^[a-f0-9]{64}$/); expect(hash(req)).toBe(key); time += DAY; expect(hash(req)).not.toBe(key);
    const limit = createLimiter({ capacity: 1, windowMs: 1000, now }); expect(limit(key)).toBe(0); expect(limit(key)).toBe(1);
  });
  it('shadow runs only after finish, does not call LLM, and swallows errors', async () => {
    const { EventEmitter } = await import('node:events');
    const res = new EventEmitter(); const logger = { log: vi.fn() };
    const raw = fixture(9035042364); const before = JSON.stringify(raw);
    scheduleShadow(res, { raw, heroId: 14, lang: 'en', legacy: {}, logger });
    expect(logger.log).not.toHaveBeenCalled(); res.emit('finish'); await new Promise(setImmediate);
    expect(JSON.parse(logger.log.mock.calls[0][0])).toMatchObject({ event: 'shadow_diff', matchId: 9035042364 }); expect(JSON.stringify(raw)).toBe(before);
    scheduleShadow(res, { raw: null, legacy: {}, logger }); res.emit('finish'); await new Promise(setImmediate);
    scheduleShadow(res, { raw, legacy: {}, logger, enabled: false }); res.emit('finish'); await new Promise(setImmediate);
    expect(logger.log).toHaveBeenCalledTimes(1);
  });
});
