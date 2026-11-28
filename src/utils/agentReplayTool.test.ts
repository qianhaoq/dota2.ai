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
import { replayReview, resolveHero, shapeReview, ReplayToolError } from '../../lib/agent/replayTool.js';

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

  it('names a hero by key, English or Chinese name, scoreboard slug, CN/EN alias or id', () => {
    const extended = [
      ...heroes,
      { hero: 'enchantress', team: 'radiant', hero_id: 58, en: 'Enchantress', zh: '魅惑魔女' },
      { hero: 'skeleton_king', team: 'dire', hero_id: 42, en: 'Wraith King', zh: '冥魂大帝' },
      { hero: 'sand_king', team: 'radiant', hero_id: 16, en: 'Sand King', zh: '沙王' },
      { hero: 'storm_spirit', team: 'dire', hero_id: 17, en: 'Storm Spirit', zh: '风暴之灵' },
      { hero: 'razor', team: 'radiant', hero_id: 15, en: 'Razor', zh: '剃刀' },
      { hero: 'obsidian_destroyer', team: 'dire', hero_id: 76, en: 'Outworld Devourer', zh: '殁境神蚀者' },
    ];
    for (const v of ['queen_of_pain', 'Queen of Pain', '痛苦女王', '女王', 'QOP', 'queenofpain', 'npc_dota_hero_queenofpain', 39, '39']) expect(resolveHero(extended, v)?.hero).toBe('queen_of_pain');
    for (const v of ['小鹿', '魅惑魔女', 'Enchantress', 58]) expect(resolveHero(extended, v)?.hero).toBe('enchantress');
    for (const v of ['骷髅王', '冥魂大帝', 'WK', 'Wraith King', 'skeleton_king']) expect(resolveHero(extended, v)?.hero).toBe('skeleton_king');
    for (const v of ['沙王', 'SK', 'Sand King']) expect(resolveHero(extended, v)?.hero).toBe('sand_king');
    for (const v of ['蓝猫', '风暴之灵', 'Storm Spirit']) expect(resolveHero(extended, v)?.hero).toBe('storm_spirit');
    // Reconciles static-heroes.json vs names.json translations (雷泽/剃刀, Outworld Destroyer/Devourer).
    for (const v of ['雷泽', '剃刀', '电棍']) expect(resolveHero(extended, v)?.hero).toBe('razor');
    for (const v of ['Outworld Destroyer', 'Outworld Devourer', '黑鸟', 'OD']) expect(resolveHero(extended, v)?.hero).toBe('obsidian_destroyer');
    for (const v of ['pudge', '', null, undefined, 'queen']) expect(resolveHero(extended, v)).toBeNull();
  });

  it('normalizes dota2.ai / OpenDota / Dotabuff / STRATZ URLs and surfaces stage/surface diagnostics across states (#485)', async () => {
    for (const rawId of [
      `  ${MATCH}  `,
      `#${MATCH}`,
      `https://dota2.ai/r/${MATCH}?hero=beastmaster&lang=zh`,
      `https://www.opendota.com/matches/${MATCH}`,
      `https://www.dotabuff.com/matches/${MATCH}/builds`,
      `https://stratz.com/matches/${MATCH}`,
    ]) {
      const { api } = fake();
      const picked = await replayReview(api, { match_id: rawId });
      expect(picked).toMatchObject({ status: 'pick_hero', surface: 'remote_mcp', match_id: MATCH });
    }
    for (const badId of ['https://evil.test/matches/9100904020', 'https://evildota2.ai/r/9100904020', 'javascript:1']) {
      const { api } = fake();
      await expect(replayReview(api, { match_id: badId })).rejects.toBeInstanceOf(ReplayToolError);
    }

    // Parsing reports exact remote stage (`extracting`) and surface; prepare returning `ready` skips the extra poll.
    const extracting = fake({
      availability: async () => ({ trace: false, can_parse: true, model_configured: true, heroes: [], parse: { status: 'running', stage: 'extracting' } }),
    });
    expect(await replayReview(extracting.api, { match_id: MATCH, hero: 'beastmaster' })).toMatchObject({
      status: 'parsing',
      surface: 'remote_mcp',
      stage: 'extracting',
      poll_after_sec: 20,
    });

    let availChecks = 0;
    const readyRace = fake({
      availability: async () => {
        availChecks += 1;
        return availChecks === 1
          ? { trace: false, can_parse: true, model_configured: true, heroes: [], parse: { status: 'none' } }
          : { trace: true, can_parse: true, model_configured: true, heroes };
      },
      prepare: async () => ({ status: 200, body: { status: 'ready' } }),
    });
    expect(await replayReview(readyRace.api, { match_id: MATCH, hero: '兽王', lang: 'zh' })).toMatchObject({
      status: 'reviewing',
      surface: 'remote_mcp',
      stage: 'review',
      hero: 'beastmaster',
    });

    // Review failure carries stage: 'review' and retryable: true, distinct from parse failure (`stage: 'parse'`).
    const reviewFail = fake({ status: async () => ({ status: 'failed', reason: 'timeout' }) });
    expect(await replayReview(reviewFail.api, { match_id: MATCH, hero: 'beastmaster' })).toMatchObject({
      status: 'failed',
      surface: 'remote_mcp',
      stage: 'review',
      reason: 'timeout',
      retryable: true,
    });

    // Native DSH surface labels unavailable model errors for DSH settings instead of blaming a remote server.
    const dshNoModel = fake({
      surface: 'native_dsh',
      availability: async () => ({ trace: true, can_parse: true, model_configured: false, heroes }),
    });
    const unavailOut = await replayReview(dshNoModel.api, { match_id: MATCH, hero: 'beastmaster' });
    expect(unavailOut).toMatchObject({
      status: 'unavailable',
      surface: 'native_dsh',
      stage: 'review',
      reason: 'model_not_configured',
    });
    expect((unavailOut as any).message).toContain('DSH');
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

  it('a failure the service no longer reports as "failed" (another instance, a minute on) is still not restarted by a poll', async () => {
    const { api, calls } = fake({ lastFailure: async () => ({ reason: 'unverified', at: 1 }) });
    expect(await replayReview(api, { match_id: MATCH, hero: 'beastmaster' })).toMatchObject({ status: 'failed', reason: 'unverified' });
    expect(calls).toEqual([]);
    expect((await replayReview(api, { match_id: MATCH, hero: 'beastmaster', retry: true })).status).toBe('reviewing');
    expect(calls).toEqual(['start beastmaster en']);
  });

  it('the page link always names the review\'s language and shapes clean non-templated fields without legacy KPIs', () => {
    expect(shapeReview(MATCH, 'beastmaster', 'en', { review: {} }).url).toBe(`https://dota2.ai/r/${MATCH}?hero=beastmaster&lang=en`);
    expect(shapeReview(MATCH, 'beastmaster', 'zh', { review: {} }).url).toBe(`https://dota2.ai/r/${MATCH}?hero=beastmaster&lang=zh`);
    const shaped: any = shapeReview(MATCH, 'beastmaster', 'zh', {
      review: {
        verdict: '总评',
        highlights: [{ title: '27:27 关键吼', detail: '定住 3.4 秒', evidence: [{ refs: ['cast:x:1'], clock: '27:27', fact: '定住 3.4 秒' }] }],
        findings: [{ title: 'f', claim: 'c', fix: 'x', evidence: [] }],
        chapters: [{ topic: 'midgame', title: '中期打架', analysis: '到场率高', evidence: [{ refs: ['fights:x:12'], clock: '33:23', fact: '零死' }] }],
        game_plan: { main_reason: 'team_play', why: '队伍未转化推塔', evidence: [{ refs: ['tempo:x'], clock: '20:00', fact: '6 波赢团 1 座塔' }] },
        blind_spots: ['录像无视野'],
      },
    });
    expect(shaped).not.toHaveProperty('opening_note');
    expect(shaped).not.toHaveProperty('encouragement');
    expect(shaped).not.toHaveProperty('goal');
    expect(shaped.highlights).toEqual([{ title: '27:27 关键吼', detail: '定住 3.4 秒', evidence: [{ clock: '27:27', fact: '定住 3.4 秒' }] }]);
    expect(shaped.chapters).toEqual([{ topic: 'midgame', title: '中期打架', analysis: '到场率高', evidence: [{ clock: '33:23', fact: '零死' }] }]);
    expect(shaped.game_plan).toEqual({ main_reason: 'team_play', why: '队伍未转化推塔', evidence: [{ clock: '20:00', fact: '6 波赢团 1 座塔' }] });
    expect(shaped.note).toContain('mechanical next-game numeric quotas');
  });

  it('a non-final parse failure (e.g. Steam GC 429 / no_replay_url) is reported as failed instead of looping as parsing', async () => {
    const failedPoll = fake({
      availability: async () => ({ trace: false, can_parse: true, heroes: [], parse: { status: 'failed', final: false, reason: 'no_replay_url', retry_in_sec: 45 } }),
    });
    expect(await replayReview(failedPoll.api, { match_id: MATCH, hero: 'beastmaster' })).toMatchObject({
      status: 'failed',
      stage: 'parse',
      reason: 'no_replay_url',
      retry_in_sec: 45,
      message: expect.stringContaining('retry: true'),
    });
    expect(failedPoll.calls).toEqual([]);

    // Passing retry: true during backoff still gets the honest failed response with retry_in_sec.
    const duringBackoff = fake({
      availability: async () => ({ trace: false, can_parse: true, heroes: [], parse: { status: 'failed', final: false, reason: 'no_replay_url', retry_in_sec: 30 } }),
      prepare: async () => { duringBackoff.calls.push('prepare'); return { status: 200, body: { status: 'failed', final: false, reason: 'no_replay_url', retry_in_sec: 30 } }; },
    });
    expect(await replayReview(duringBackoff.api, { match_id: MATCH, hero: 'beastmaster', retry: true })).toMatchObject({
      status: 'failed',
      stage: 'parse',
      reason: 'no_replay_url',
      retry_in_sec: 30,
    });
    expect(duringBackoff.calls).toEqual(['prepare']);

    // Passing retry: true after backoff starts a new parse cleanly.
    const afterBackoff = fake({
      availability: async () => ({ trace: false, can_parse: true, heroes: [], parse: { status: 'failed', final: false, reason: 'no_replay_url', retry_in_sec: 0 } }),
    });
    expect(await replayReview(afterBackoff.api, { match_id: MATCH, hero: 'beastmaster', retry: true })).toMatchObject({ status: 'parsing' });
    expect(afterBackoff.calls).toEqual(['prepare']);
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
  const chapters = [
    { topic: 'midgame', title: '黑皇杖窗口', analysis: '幻影刺客开了 7 次黑皇杖，27:27 吼进黑皇杖。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 吼进黑皇杖，定住 3.4 秒' }] },
    { topic: 'skills_and_items', title: '大招留给核心', analysis: '对面幻影刺客 7 次黑皇杖需要针对性大招。', evidence: [{ refs: ['immunity:phantom_assassin'], fact: '幻影刺客开了 7 次黑皇杖。' }] },
  ];
  const submit = { verdict: '咆哮没有留给幻影刺客。', findings: [finding], chapters, blind_spots: ['视野'] };
  let starts = 0;
  const complete = async (o: any) => {
    if (!o.tools?.length && String(o.system ?? '').includes('Dota 2 coaching translator')) {
      return { text: JSON.stringify({ en: { verdict: 'Primal Roar was not saved.', mainline: [], findings: [{ title: 'Roar', claim: 'PA used BKB 7 times.', evidence: ['27:27 stunned 3.4s'], fix: 'Hold it.' }], blind_spots: ['Vision'] }, ru: { verdict: 'Primal Roar не приберегли.', mainline: [], findings: [{ title: 'Рёв', claim: 'PA нажала BKB 7 раз.', evidence: ['27:27 оглушение 3.4 с'], fix: 'Берегите.' }], blind_spots: ['Обзор'] } }) };
    }
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

  it('a review that failed on one instance is not started again by a poll that reaches another, minutes later', async () => {
    const reviewDir = mkdtempSync(join(tmpdir(), 'replay-tool-shared-'));
    const clock = { t: 1_000_000 };
    let runs = 0;
    // A model whose review never verifies: the job fails (reason unverified).
    const bad = async (o: any) => { if (o.messages.at(-1).role === 'user') { runs++; return { toolCalls: [call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'a')] }; } return { toolCalls: [call('submit_review', submit, 's')] }; };
    const instance = () => {
      const service: any = createAgentService({ traces: createFileTraceStore(dir), complete: bad, model: 'm', reviewDir, now: () => clock.t });
      const router: any = createAgentRouter({ service, resolveClientIp: () => '5.5.5.5' });
      return router.forRequest({ headers: {} });
    };
    const a = instance();
    expect((await replayReview(a, { match_id: MATCH, hero: 'beastmaster' })).status).toBe('reviewing');
    for (let i = 0; i < 50; i++) { if ((await a.status(MATCH, 'beastmaster', 'en')).status === 'failed') break; await new Promise((r) => setTimeout(r, 20)); }
    expect(runs).toBe(1);
    // Another instance, after the minute in which status() still calls the shared marker "failed".
    clock.t += 61_000;
    const b = instance();
    expect((await b.status(MATCH, 'beastmaster', 'en')).status).toBe('none');
    expect(await replayReview(b, { match_id: MATCH, hero: 'beastmaster' })).toMatchObject({ status: 'failed' });
    await new Promise((r) => setTimeout(r, 50));
    expect(runs).toBe(1);
    // Asked for: one new start.
    expect((await replayReview(b, { match_id: MATCH, hero: 'beastmaster', retry: true })).status).toBe('reviewing');
    for (let i = 0; i < 50 && runs < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(runs).toBe(2);
    // The second job is still writing its marker: removing the directory under it fails (ENOTEMPTY) on a fast runner.
    for (let i = 0; i < 100; i++) { if ((await b.status(MATCH, 'beastmaster', 'en')).status === 'failed') break; await new Promise((r) => setTimeout(r, 20)); }
    await new Promise((r) => setTimeout(r, 50));
    rmSync(reviewDir, { recursive: true, force: true });
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
