import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { attachMcp, createMcpServer } from '../../packages/mcp/src/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MCP_TOOLS } from '../coach/accessSnippets';
import { createAgentRouter } from '../../lib/agent/router.js';
import { createAgentService, createFileTraceStore } from '../../lib/agent/service.js';
import { replayReview, resolveHero, ReplayToolError } from '../../lib/agent/replayTool.js';

const express = createRequire(import.meta.url)('express');
const MATCH = '9100904020';
const dir = mkdtempSync(join(tmpdir(), 'replay-tool-'));
copyFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url), join(dir, `${MATCH}.trace.json.gz`));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const heroes = [
  { hero: 'beastmaster', team: 'dire', hero_id: 38, en: 'Beastmaster', zh: '兽王' },
  { hero: 'queen_of_pain', team: 'radiant', hero_id: 39, en: 'Queen of Pain', zh: '痛苦女王' },
];

describe('replay_review: one call at a time, never blocking', () => {
  /** A scripted api (lib/agent/router.js forRequest), recording what it was asked. */
  const fake = (over: Partial<Record<string, any>> = {}) => {
    const calls: string[] = [];
    const api = {
      read: () => ({ ok: true }),
      validMatch: (id: string) => /^[1-9]\d{0,12}$/.test(id),
      availability: async () => ({ trace: true, can_parse: true, model_configured: true, heroes }),
      status: async () => ({ status: 'none' }),
      prepare: async () => { calls.push('prepare'); return { status: 202, body: { status: 'running', stage: 'locating' } }; },
      start: async (_id: string, hero: string, lang: string) => { calls.push(`start ${hero} ${lang}`); return { status: 202, body: { status: 'running', steps: [] } }; },
      ...over,
    };
    return { api, calls };
  };

  it('names a hero by key, English or Chinese name, scoreboard slug or id', () => {
    for (const v of ['queen_of_pain', 'Queen of Pain', '痛苦女王', 'queenofpain', 'npc_dota_hero_queenofpain', 39, '39']) expect(resolveHero(heroes, v)?.hero).toBe('queen_of_pain');
    for (const v of ['pudge', '', null, undefined, 'queen']) expect(resolveHero(heroes, v)).toBeNull();
  });

  it('no replay yet: starts the parse and says to come back, asking for the hero meanwhile', async () => {
    const { api, calls } = fake({ availability: async () => ({ trace: false, can_parse: true, model_configured: true, heroes: [], parse: { status: 'none' } }) });
    const out = await replayReview(api, { match_id: MATCH });
    expect(out).toMatchObject({ status: 'parsing', poll_after_sec: 20, ask_user: expect.stringContaining('Which hero') });
    expect(calls).toEqual(['prepare']);
    // Already running: nothing more is started.
    const running = fake({ availability: async () => ({ trace: false, can_parse: true, model_configured: true, heroes: [], parse: { status: 'running' } }) });
    expect((await replayReview(running.api, { match_id: MATCH, hero: 'beastmaster' })).status).toBe('parsing');
    expect(running.calls).toEqual([]);
  });

  it('parsed: without a hero (or with one not in the game) it lists the game\'s heroes and starts nothing', async () => {
    const { api, calls } = fake();
    expect(await replayReview(api, { match_id: MATCH })).toMatchObject({ status: 'pick_hero', heroes: [{ hero: 'beastmaster', team: 'dire', en: 'Beastmaster', zh: '兽王' }, { hero: 'queen_of_pain' }] });
    expect(((await replayReview(api, { match_id: MATCH, hero: 'pudge' })) as any).message).toContain('"pudge" is not in this game');
    expect(calls).toEqual([]);
  });

  it('starts the review once and reports it running; a refused start is an error that says when to come back', async () => {
    const { api, calls } = fake();
    expect(await replayReview(api, { match_id: MATCH, hero: '兽王', lang: 'zh' })).toMatchObject({ status: 'reviewing', hero: 'beastmaster', lang: 'zh', poll_after_sec: 20 });
    expect(calls).toEqual(['start beastmaster zh']);
    const refused = fake({ start: async () => ({ status: 429, body: { code: 'rate_limited', retryAfterSec: 240 } }) });
    await expect(replayReview(refused.api, { match_id: MATCH, hero: 'beastmaster' })).rejects.toMatchObject({ code: 'RATE_LIMITED', message: expect.stringContaining('240 s') });
    const busy = fake({ start: async () => ({ status: 503, body: { code: 'busy', retryAfterSec: 60 } }) });
    await expect(replayReview(busy.api, { match_id: MATCH, hero: 'beastmaster' })).rejects.toMatchObject({ code: 'RATE_LIMITED', message: expect.stringContaining('capacity') });
  });

  it('a review that failed is said, and started again only when the agent asks (retry), never by a poll', async () => {
    const { api, calls } = fake({ status: async () => ({ status: 'failed', reason: 'unverified' }) });
    expect(await replayReview(api, { match_id: MATCH, hero: 'beastmaster' })).toMatchObject({ status: 'failed', reason: 'unverified', message: expect.stringContaining('retry: true') });
    expect(calls).toEqual([]);
    expect((await replayReview(api, { match_id: MATCH, hero: 'beastmaster', retry: true })).status).toBe('reviewing');
    expect(calls).toEqual(['start beastmaster en']);
  });

  it('a gone replay, a bad id and the read limit are said plainly', async () => {
    const gone = fake({ availability: async () => ({ trace: false, can_parse: true, heroes: [], parse: { status: 'failed', final: true, reason: 'replay_gone' } }) });
    expect(await replayReview(gone.api, { match_id: MATCH, hero: 'beastmaster' })).toMatchObject({ status: 'replay_unavailable', reason: 'replay_gone' });
    expect(gone.calls).toEqual([]);
    const reads: string[] = [];
    const bad = fake({ read: () => { reads.push('r'); return { ok: true }; } });
    await expect(replayReview(bad.api, { match_id: '../1' })).rejects.toBeInstanceOf(ReplayToolError);
    expect(reads).toEqual([]);
    const limited = fake({ read: () => ({ ok: false, retryAfterSec: 9 }) });
    await expect(replayReview(limited.api, { match_id: MATCH, hero: 'beastmaster' })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('replay_review over MCP, on the real agent service and router', () => {
  it('the hosted server lists exactly the tools the home page names, in that order', async () => {
    const server = createMcpServer({ coachTools: true, coach: {}, replay: { review: async () => ({}) } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([...MCP_TOOLS]);
    await client.close();
  });

  const call = (name: string, args: any, id: string) => ({ id, name, args });
  const finding = { title: '咆哮', claim: '幻影刺客开了 7 次黑皇杖。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 吼进黑皇杖，定住 3.4 秒' }], fix: '留给她。' };
  const submit = { verdict: '咆哮没有留给幻影刺客。', mainline: [], findings: [finding], next_game: ['留咆哮'], blind_spots: ['视野'] };
  let starts = 0;
  const complete = async (o: any) => {
    const last = o.messages.at(-1);
    if (last.role === 'user') { starts++; return { toolCalls: [call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'a'), call('immunity_windows', { hero: 'phantom_assassin' }, 'b')] }; }
    return { toolCalls: [call('submit_review', submit, 's')] };
  };
  const servers: Server[] = [];
  const clients: Client[] = [];
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
  });
  async function start() {
    const reviewDir = mkdtempSync(join(tmpdir(), 'replay-tool-reviews-'));
    const service: any = createAgentService({ traces: createFileTraceStore(dir), complete, model: 'm', reviewDir});
    const router: any = createAgentRouter({ service, resolveClientIp: (req: any) => String(req.headers['x-test-ip'] ?? '1.1.1.1') });
    const app = express();
    app.use(express.json());
    app.use(router);
    (attachMcp as any)(app, { replayForRequest: (req: any) => { const api = router.forRequest(req); return { review: (args: any) => replayReview(api, args) }; } });
    const server: Server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      base,
      client: async (ip: string) => {
        const c = new Client({ name: 't', version: '0' });
        await c.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: { 'x-test-ip': ip } } }));
        clients.push(c);
        return c;
      },
    };
  }
  const json = (r: any) => JSON.parse(r.content[0].text);

  it('an agent starts the review, polls, and gets it with its checked evidence and the page to link', async () => {
    const s = await start();
    const c = await s.client('9.9.9.9');
    expect((await c.listTools()).tools.map((t) => t.name)).toContain('replay_review');
    const first = json(await c.callTool({ name: 'replay_review', arguments: { match_id: MATCH, hero: 'Beastmaster', lang: 'zh' } }));
    expect(['reviewing', 'ready']).toContain(first.status);
    let out = first;
    for (let i = 0; i < 50 && out.status !== 'ready'; i++) {
      await new Promise((r) => setTimeout(r, 40));
      const raw: any = await c.callTool({ name: 'replay_review', arguments: { match_id: MATCH, hero: 'beastmaster', lang: 'zh' } });
      if (raw.isError) throw new Error(`poll ${i} after ${JSON.stringify(out).slice(0, 200)}: ${raw.content[0].text}`);
      out = json(raw);
    }
    expect(out).toMatchObject({ status: 'ready', hero: 'beastmaster', lang: 'zh', url: `https://dota2.ai/r/${MATCH}?hero=beastmaster&lang=zh`, verdict: '咆哮没有留给幻影刺客。' });
    expect(out.findings[0]).toMatchObject({ title: '咆哮', fix: '留给她。' });
    expect(out.findings[0].evidence[0].fact).toContain('27:27');
    // Polling and asking again never started a second review.
    expect(starts).toBe(1);
  });

  it('starts count on the caller\'s review limit, like the page\'s: the sixth start from one caller is refused', async () => {
    const s = await start();
    const c = await s.client('7.7.7.7');
    const roster = json(await c.callTool({ name: 'replay_review', arguments: { match_id: MATCH } })).heroes.map((h: any) => h.hero);
    const six = roster.slice(0, 6);
    expect(six).toHaveLength(6);
    const results = [];
    for (const [i, hero] of six.entries()) results.push(await c.callTool({ name: 'replay_review', arguments: { match_id: MATCH, hero, lang: i % 2 ? 'en' : 'zh' } }));
    expect(results.slice(0, 5).every((r: any) => !r.isError)).toBe(true);
    expect(results[5]).toMatchObject({ isError: true });
    expect((results[5] as any).content[0].text).toMatch(/Too many reviews started by this caller; try again in \d+ s/);
    // Another caller is not charged for it.
    const other = await s.client('8.8.8.8');
    expect((await other.callTool({ name: 'replay_review', arguments: { match_id: MATCH, hero: six[5] } })).isError).toBeFalsy();
  });
});
