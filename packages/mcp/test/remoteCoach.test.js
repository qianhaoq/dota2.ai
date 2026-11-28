import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { readFileSync } from 'node:fs';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createV1Router } from '../../../routes/v1/index.js';
import { createCoachRouter } from '../../../lib/coach/router.js';
import { createCoachService } from '../../../lib/coach/service.js';
import { createSlidingWindowLimiter } from '../../../lib/rateLimiter.js';

const coachMatch = JSON.parse(readFileSync(new URL('../../../src/fixtures/coach/match9091400302.parsed.json', import.meta.url), 'utf8'));
const unparsedMatch = JSON.parse(readFileSync(new URL('../../../src/fixtures/coach/match9091400302.unparsed.json', import.meta.url), 'utf8'));
const ALL = ['review_match', 'get_evidence', 'recent_matches', 'coach_report', 'coach_cases', 'coach_ask', 'goal_check', 'hero_matchup'];

const servers = [];
const clients = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
});

/** One server: web coach routes + remote /mcp on one coach service. Caller IP comes from x-test-ip. */
async function start({ limit = 100, recentCalls = [], matchData = coachMatch, replayAvailability } = {}) {
  let upstream = 0;
  const getMatchDetail = async (id) => {
    upstream++;
    if (Number(id) !== 9091400302) throw Object.assign(new Error('HTTP 404'), { status: 404 });
    return structuredClone(matchData);
  };
  const resolveClientIp = (req) => String(req.headers['x-test-ip'] ?? '127.0.0.1');
  const mapError = (e) => ({ status: e?.status === 404 ? 404 : 502, body: { error: 'x' } });
  const service = createCoachService({
    getMatchDetail,
    resolveClientIp,
    mapError,
    ...(replayAvailability ? { replayAvailability } : {}),
    recent: { get: async (accountId) => { recentCalls.push(accountId); return { account_id: accountId, matches: [] }; } },
    limiter: createSlidingWindowLimiter({ limit, globalLimit: 10_000, windowMs: 60_000 }),
  });
  const app = express();
  app.use(express.json());
  app.use(createCoachRouter({ getMatchDetail, resolveClientIp, mapError, limiter: service.limiter }));
  app.use(createV1Router({ fetchMatch: async () => { throw new Error('unused'); }, coachForRequest: service.forRequest }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, upstream: () => upstream };
}

async function connect(base, ip = '127.0.0.1') {
  const client = new Client({ name: 'remote-coach-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: { 'x-test-ip': ip } } }));
  clients.push(client);
  return client;
}

describe('remote /mcp with an in-process coach', () => {
  it('lists all 8 tools and the coach tools return real coach data', async () => {
    const { base } = await start();
    const client = await connect(base);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(ALL);

    const roster = await client.callTool({ name: 'coach_report', arguments: { match_id: 9091400302 } });
    expect(roster.isError).toBeFalsy();
    expect(JSON.stringify(roster.structuredContent)).toContain('9091400302');

    const tide = await client.callTool({ name: 'coach_report', arguments: { match_id: 9091400302, hero: 'tidehunter', section: 'all' } });
    expect(tide.isError).toBeFalsy();
    // The same seat JSON the CLI and stdio MCP return, built from the same engine.
    expect(tide.structuredContent.player.hero.slug).toBe('tidehunter');
    expect(tide.structuredContent.match.id).toBe(9091400302);
    expect(tide.structuredContent.url).toBe(`https://dota2.ai/r/9091400302?p=${tide.structuredContent.player.slot}`);
    expect(tide.structuredContent.review.findings.length).toBeGreaterThan(0);

    const mu = await client.callTool({ name: 'hero_matchup', arguments: { hero: 'tidehunter', vs: 'ursa', rank: 'di' } });
    expect(mu.isError).toBeFalsy();
    expect(mu.structuredContent.lines.en.join('\n')).toContain('Divine–Immortal public games');
  });

  it('coach_ask answers from the report when no model is configured: { text, fallback, notice }', async () => {
    const { base } = await start();
    const client = await connect(base);
    const r = await client.callTool({ name: 'coach_ask', arguments: { match_id: 9091400302, hero: 'tidehunter', question: 'Why did I die so much?' } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.fallback).toBe(true);
    expect(r.structuredContent.text.length).toBeGreaterThan(20);
    expect(typeof r.structuredContent.notice).toBe('string');
  });

  it('recent_matches takes the same inputs as the CLI (profile link → friend code)', async () => {
    const recentCalls = [];
    const { base } = await start({ recentCalls });
    const client = await connect(base);
    const r = await client.callTool({ name: 'recent_matches', arguments: { account: 'https://steamcommunity.com/profiles/76561198047011640' } });
    expect(r.isError).toBeFalsy();
    expect(recentCalls).toEqual([86745912]);
    const bad = await client.callTool({ name: 'recent_matches', arguments: { account: 'https://steamcommunity.com/id/someone' } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/custom URL/i);
  });
});

describe('remote /mcp rate limits per caller, shared with the web coach', () => {
  it('a caller over budget is refused with the wait and Retry-After; another caller is not', async () => {
    const { base } = await start({ limit: 2 });
    // One web request and one MCP call use caller A's whole budget: one bucket for both surfaces.
    expect((await fetch(`${base}/api/coach/9091400302`, { headers: { 'x-test-ip': '203.0.113.7' } })).status).toBe(200);
    const a = await connect(base, '203.0.113.7');
    expect((await a.callTool({ name: 'coach_report', arguments: { match_id: 9091400302 } })).isError).toBeFalsy();
    const limited = await a.callTool({ name: 'coach_report', arguments: { match_id: 9091400302 } });
    expect(limited.isError).toBe(true);
    expect(limited.content[0].text).toMatch(/^Rate limited: try again in \d+s$/);
    // The HTTP response carries Retry-After too.
    const raw = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-test-ip': '203.0.113.7' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'coach_report', arguments: { match_id: 9091400302 } } }),
    });
    expect(Number(raw.headers.get('retry-after'))).toBeGreaterThan(0);
    // Caller B still has its own budget.
    const b = await connect(base, '198.51.100.9');
    expect((await b.callTool({ name: 'coach_report', arguments: { match_id: 9091400302 } })).isError).toBeFalsy();
  });

  it('IPv6 callers share one bucket per /64 (rotating addresses buys nothing)', async () => {
    const { base } = await start({ limit: 1 });
    const one = await connect(base, '2001:db8:1:2::1');
    expect((await one.callTool({ name: 'coach_report', arguments: { match_id: 9091400302 } })).isError).toBeFalsy();
    const sameBlock = await connect(base, '2001:db8:1:2:ffff:ffff:ffff:fffe');
    expect((await sameBlock.callTool({ name: 'coach_report', arguments: { match_id: 9091400302 } })).isError).toBe(true);
    const otherBlock = await connect(base, '2001:db8:1:3::1');
    expect((await otherBlock.callTool({ name: 'coach_report', arguments: { match_id: 9091400302 } })).isError).toBeFalsy();
    // The web routes key the same way.
    expect((await fetch(`${base}/api/coach/9091400302`, { headers: { 'x-test-ip': '2001:db8:1:2::abcd' } })).status).toBe(429);
  });

  it('hero_matchup (snapshot only, no upstream) is not charged against the budget', async () => {
    const { base, upstream } = await start({ limit: 1 });
    const c = await connect(base, '192.0.2.1');
    for (let i = 0; i < 3; i++) expect((await c.callTool({ name: 'hero_matchup', arguments: { hero: 'tidehunter', vs: 'ursa' } })).isError).toBeFalsy();
    expect(upstream()).toBe(0);
    expect((await c.callTool({ name: 'coach_report', arguments: { match_id: 9091400302 } })).isError).toBeFalsy();
  });
});

describe('coach_ask never spends the LLM budget for a caller who left (review #215 P1)', () => {
  const { EventEmitter } = require('node:events');
  /** A service whose match load can be paused, with an LLM that records whether it was touched. */
  function setup() {
    const touched = { acquire: 0, providers: 0, stream: 0 };
    // Every match load waits here until the test releases it.
    const pending = [];
    const service = createCoachService({
      getMatchDetail: async () => { await new Promise((r) => pending.push(r)); return structuredClone(coachMatch); },
      resolveClientIp: () => '192.0.2.50',
      ask: {
        llm: { acquire: () => { touched.acquire++; return { ok: true }; } },
        providers: () => { touched.providers++; return [{ name: 'fake', create: async () => [] }]; },
        stream: async () => { touched.stream++; return { status: 'done', forwarded: true }; },
        attemptMs: 1000,
      },
    });
    const req = new EventEmitter();
    const res = Object.assign(new EventEmitter(), { writableEnded: false, headersSent: false, set() {} });
    /** Resolves with the release function of the next match load once it has started. */
    const nextLoad = async () => { while (!pending.length) await new Promise((r) => setTimeout(r, 1)); return pending.shift(); };
    return { service, req, res, touched, nextLoad };
  }

  it('gone during the hero lookup (the report load before ask): no budget, no completion', async () => {
    const t = setup();
    const coach = t.service.forRequest(t.req, t.res);
    const lookup = coach.report(9091400302);
    const release = await t.nextLoad();
    t.res.emit('close'); // the caller disconnects while the match loads
    release();
    await lookup;
    const ask = coach.ask(9091400302, 0, 'Why?', { lang: 'en' });
    await expect(ask).rejects.toMatchObject({ code: 'UPSTREAM', message: 'Caller disconnected' });
    expect(t.touched).toEqual({ acquire: 0, providers: 0, stream: 0 });
  });

  it('gone during ask’s own match load: no budget, no completion', async () => {
    const t = setup();
    const coach = t.service.forRequest(t.req, t.res);
    const ask = coach.ask(9091400302, 0, 'Why?', { lang: 'en' });
    const release = await t.nextLoad();
    t.res.emit('close');
    release();
    await expect(ask).rejects.toMatchObject({ code: 'UPSTREAM', message: 'Caller disconnected' });
    expect(t.touched).toEqual({ acquire: 0, providers: 0, stream: 0 });
  });

  it('a caller who stays gets the answer (the LLM is used)', async () => {
    const t = setup();
    const coach = t.service.forRequest(t.req, t.res);
    const ask = coach.ask(9091400302, 0, 'Why?', { lang: 'en' });
    (await t.nextLoad())();
    await ask;
    expect(t.touched.acquire).toBe(1);
    expect(t.touched.stream).toBe(1);
  });
});

describe('coach tool errors tell the agent what to do', () => {
  it('an upstream outage says it is temporary (not a bare "Coach request failed")', async () => {
    const service = createCoachService({
      getMatchDetail: async () => { throw Object.assign(new Error('HTTP 520'), { status: 520 }); },
      resolveClientIp: () => '192.0.2.70',
      mapError: () => ({ status: 502, body: {} }),
      recent: { get: async () => { throw Object.assign(new Error('HTTP 520'), { status: 520 }); } },
    });
    const app = express();
    app.use(express.json());
    app.use(createV1Router({ fetchMatch: async () => { throw new Error('unused'); }, coachForRequest: service.forRequest }));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    servers.push(server);
    const client = await connect(`http://127.0.0.1:${server.address().port}`);
    const recent = await client.callTool({ name: 'recent_matches', arguments: { account: '86745912' } });
    expect(recent.isError).toBe(true);
    expect(recent.content[0].text).toBe('Could not load recent games right now (temporary; retry later)');
    const report = await client.callTool({ name: 'coach_report', arguments: { match_id: 9091400302 } });
    expect(report.content[0].text).toBe('Could not load the match right now (temporary; retry later)');
  });

  it('distinguishes unparsed OpenDota matches with replay_trace_available guidance, URL match IDs, and Chinese hero aliases (#485)', async () => {
    const { base } = await start({
      matchData: unparsedMatch,
      replayAvailability: async () => ({ trace: true, can_parse: true }),
    });
    const client = await connect(base);

    // `coach_cases` does not fail opaquely on unparsed OpenDota matches: returns structured `no_parsed_match` with `surface: 'remote_mcp'`.
    const cases = await client.callTool({
      name: 'coach_cases',
      arguments: { match_id: 'https://dota2.ai/r/9091400302?lang=zh', hero: '潮汐', lang: 'zh' },
    });
    expect(cases.isError).toBeFalsy();
    expect(cases.structuredContent).toMatchObject({
      status: 'no_parsed_match',
      reason: 'needs_parse',
      surface: 'remote_mcp',
      match_id: '9091400302',
      hero: 'tidehunter',
      match_parsed: false,
      basic_report_available: true,
      replay_trace_available: true,
      replay_review_available: true,
      next_tool: 'replay_review',
    });
    expect(cases.structuredContent.message).toContain('replay_review');

    // `coach_report` marks `report_scope: 'basic_scoreboard_only'` and points to `replay_review`.
    const why = await client.callTool({
      name: 'coach_report',
      arguments: { match_id: 'https://www.opendota.com/matches/9091400302', hero: '拍拍熊', section: 'why' },
    });
    expect(why.isError).toBeFalsy();
    expect(why.structuredContent).toMatchObject({
      section: 'why',
      surface: 'remote_mcp',
      report_scope: 'basic_scoreboard_only',
      parsed: false,
      next_tool: 'replay_review',
    });
    expect(why.structuredContent.data_gaps.length).toBeGreaterThan(0);

    // `hero_matchup` resolves CN aliases consistently with DSH and Web.
    const mu = await client.callTool({ name: 'hero_matchup', arguments: { hero: '小鹿', vs: '骷髅王' } });
    expect(mu.isError).toBeFalsy();
    expect(mu.structuredContent.hero.id).toBe(58);
    expect(mu.structuredContent.vs.id).toBe(42);
  });
});
