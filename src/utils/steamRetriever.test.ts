import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRetrieverApp } from '../../services/steam-retriever/src/app.mjs';
import { createDailyQuota } from '../../services/steam-retriever/src/quota.mjs';
import { readTokens, tokenExpiry, tokenProblem, writeToken } from '../../services/steam-retriever/src/tokens.mjs';
import * as codec from '../../services/steam-retriever/src/codec.mjs';
import { createSteamGcClient, mapGcHistory, mapGcMatch } from '../../lib/upstream/steamGc.js';
import { buildCoachReport } from '../../lib/coach/analyze.js';

// Built at run time: a literal here reads as a leaked key to the secret scanner.
const SECRET = `retriever-test-${'k'.repeat(24)}`;
const od = JSON.parse(readFileSync(new URL('../fixtures/coach/match9091400302.unparsed.json', import.meta.url), 'utf8'));
const ID = String(od.match_id);

/** The fixture game as CMsgDOTAMatch fields (what the GC puts on the wire). */
const gcMatch = (m: any) => ({
  match_id: String(m.match_id), duration: m.duration, starttime: m.start_time, cluster: m.cluster, replay_salt: m.replay_salt,
  game_mode: m.game_mode, lobby_type: m.lobby_type, match_outcome: m.radiant_win ? 2 : 3,
  radiant_team_score: m.radiant_score, dire_team_score: m.dire_score,
  players: m.players.map((p: any) => ({
    account_id: p.account_id ?? 4294967295, player_slot: p.player_slot, hero_id: p.hero_id,
    team_number: p.player_slot < 128 ? 0 : 1, team_slot: p.player_slot % 128,
    kills: p.kills, deaths: p.deaths, assists: p.assists, last_hits: p.last_hits, denies: p.denies,
    gold_per_min: p.gold_per_min, xp_per_min: p.xp_per_min, net_worth: p.net_worth, level: p.level,
    hero_damage: p.hero_damage, tower_damage: p.tower_damage, hero_healing: p.hero_healing,
    // An empty slot is simply not sent; the proto default for it is -1.
    ...Object.fromEntries([0, 1, 2, 3, 4, 5].filter((k) => p[`item_${k}`]).map((k) => [`item_${k}`, p[`item_${k}`]])),
  })),
});

type Gc = { size(): number; ready(): string[]; matchDetails: any; history: any; calls: any[] };
function fakeGc(over: Partial<Gc> = {}, accounts = ['a1']): Gc {
  const calls: any[] = [];
  return {
    calls,
    size: () => accounts.length,
    ready: () => accounts,
    matchDetails: async (account: string, matchId: string) => { calls.push({ account, matchId }); return { result: 1, match: { match_id: matchId } }; },
    history: async (account: string, accountId: number, limit: number) => { calls.push({ account, accountId, limit }); return { matches: [] }; },
    ...over,
  };
}

let servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.map((s) => new Promise((r) => s.close(r)))); servers = []; });
async function serve(o: any = {}) {
  const gc = o.gc ?? fakeGc();
  const quota = o.quota ?? createDailyQuota();
  const logs: string[] = [];
  const { gc: _gc, quota: _quota, ...rest } = o;
  const app = createRetrieverApp({ secret: SECRET, minIntervalMs: 0, log: (l: string) => logs.push(l), ...rest, gc, quota } as any);
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const get = (path: string, token: string | null = SECRET) => fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { base, get, gc, quota, logs };
}

describe('retriever: who may call', () => {
  it('refuses to exist without a real secret', () => {
    for (const secret of [undefined, '', 'short']) {
      expect(() => createRetrieverApp({ secret, gc: fakeGc(), quota: createDailyQuota() } as any)).toThrow(/SECRET/);
    }
  });

  it('answers 401 to a missing, wrong or differently sized token, and never reaches the GC', async () => {
    const { get, gc, base } = await serve();
    for (const token of [null, 'nope', `${SECRET}x`, SECRET.slice(0, -1), SECRET.toUpperCase()]) {
      const res = await get(`/match/${ID}`, token);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ code: 'unauthorized' });
    }
    // The secret in the query string (odota's way) is not accepted: it would land in access logs.
    expect((await fetch(`${base}/match/${ID}?key=${SECRET}`)).status).toBe(401);
    expect((await fetch(`${base}/match/${ID}`, { headers: { authorization: `Basic ${SECRET}` } })).status).toBe(401);
    expect(gc.calls).toEqual([]);
  });

  it('/healthz needs no token and gives counts only', async () => {
    const quota = createDailyQuota();
    quota.take('match', 'a1');
    const { get } = await serve({ gc: fakeGc({}, ['a1', 'a2']), quota });
    const res = await get('/healthz', null);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, accounts: 2, readyAccounts: 2, matchUsed: 1, matchCap: 190, historyUsed: 0 });
    expect(JSON.stringify(body)).not.toMatch(/a1|a2|secret/i);
  });

  it('rejects bad ids, limits, methods and unknown routes before spending anything', async () => {
    const { get, gc, base } = await serve();
    for (const path of ['/match/0', '/match/abc', '/match/1e5', '/match/1234567890123456', '/match/', '/match/12/extra',
      '/history/0', '/history/4294967295', '/history/12345678901', '/history/5?limit=0', '/history/5?limit=51', '/history/5?limit=x']) {
      expect((await get(path)).status, path).toBe(400);
    }
    // Not 404: the caller reads 404 as "Valve has no such match".
    expect((await get('/nothing')).status).toBe(400);
    expect((await fetch(`${base}/match/${ID}`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } })).status).toBe(405);
    expect(gc.calls).toEqual([]);
  });
});

describe('retriever: match details', () => {
  it('maps GC results to statuses: ok, not found, withheld by Valve, anything else', async () => {
    const results: Record<string, any> = {
      '11': { result: 1, match: { match_id: '11' } },
      '12': { result: 2 },
      '13': { result: 15 },
      '14': { result: 8 },
      '15': { result: 1, match: { match_id: '999' } }, // answered another match
      '16': {},
    };
    const { get } = await serve({ gc: fakeGc({ matchDetails: async (_a: string, id: string) => results[id] }) });
    const ok = await get('/match/11');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ match: { match_id: '11' } });
    const miss = await get('/match/12');
    expect([miss.status, await miss.json()]).toEqual([404, { code: 'not_found' }]);
    const blocked = await get('/match/13');
    expect([blocked.status, await blocked.json()]).toEqual([451, { code: 'valve_blocked' }]);
    const odd = await get('/match/14');
    expect([odd.status, await odd.json()]).toEqual([502, { code: 'gc_result', result: 8 }]);
    expect((await get('/match/15')).status).toBe(502);
    expect((await get('/match/16')).status).toBe(502);
  });

  it('a GC that does not answer is 504, a broken request 502, and both still cost budget', async () => {
    const quota = createDailyQuota();
    const timeout = Object.assign(new Error('x'), { code: 'gc_timeout' });
    const { get, logs } = await serve({ quota, gc: fakeGc({ matchDetails: async (_a: string, id: string) => { throw id === '21' ? timeout : new Error('boom secret-ish detail'); } }) });
    const t = await get('/match/21');
    expect([t.status, await t.json()]).toEqual([504, { code: 'gc_timeout' }]);
    const e = await get('/match/22');
    expect([e.status, await e.json()]).toEqual([502, { code: 'gc_error' }]);
    expect(quota.snapshot(1).matchUsed).toBe(2);
    expect(logs.join('\n')).not.toMatch(/secret-ish/); // error text is not echoed
  });

  it('503 with Retry-After when no account is online, and nothing is counted', async () => {
    const quota = createDailyQuota();
    const { get } = await serve({ quota, gc: fakeGc({ ready: () => [] }) });
    const res = await get(`/match/${ID}`);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(await res.json()).toEqual({ code: 'no_account_online' });
    expect(quota.snapshot(1).matchUsed).toBe(0);
    expect((await (await get('/healthz', null)).json()).ok).toBe(false);
  });

  it('asks the GC once for concurrent and repeated requests for the same match', async () => {
    let release: (v: any) => void = () => {};
    const gate = new Promise((r) => { release = r; });
    const gc = fakeGc({});
    gc.matchDetails = async (account: string, matchId: string) => { gc.calls.push({ account, matchId }); await gate; return { result: 1, match: { match_id: matchId } }; };
    const { get, quota } = await serve({ gc });
    const both = Promise.all([get('/match/31'), get('/match/31'), get('/match/31')]);
    await new Promise((r) => setTimeout(r, 30));
    release(null);
    expect((await both).map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await get('/match/31')).status).toBe(200); // cached
    expect(gc.calls).toHaveLength(1);
    expect(quota.snapshot(1).matchUsed).toBe(1);
  });

  it('keeps a "not found" only briefly, a found match longer; failures are not cached', async () => {
    let t = 1_700_000_000_000;
    let found = false;
    let fail = true;
    const gc = fakeGc({});
    gc.matchDetails = async (_a: string, id: string) => {
      gc.calls.push(id);
      if (id === '42') { if (fail) { fail = false; throw new Error('x'); } return { result: 1, match: { match_id: id } }; }
      return found ? { result: 1, match: { match_id: id } } : { result: 2 };
    };
    const { get } = await serve({ gc, now: () => t, quota: createDailyQuota({ now: () => t }), missTtlMs: 60_000, okTtlMs: 600_000 });
    expect((await get('/match/41')).status).toBe(404);
    found = true;
    t += 59_000;
    expect((await get('/match/41')).status).toBe(404); // still the cached miss
    t += 2_000;
    expect((await get('/match/41')).status).toBe(200); // asked again
    t += 599_000;
    expect((await get('/match/41')).status).toBe(200);
    expect(gc.calls.filter((c) => c === '41')).toHaveLength(2);
    expect((await get('/match/42')).status).toBe(502);
    expect((await get('/match/42')).status).toBe(200);
  });

  it('spaces GC requests at least minIntervalMs apart', async () => {
    const at: number[] = [];
    const gc = fakeGc({});
    gc.matchDetails = async (_a: string, id: string) => { at.push(Date.now()); return { result: 1, match: { match_id: id } }; };
    const { get } = await serve({ gc, minIntervalMs: 80 });
    await Promise.all([get('/match/51'), get('/match/52'), get('/match/53')]);
    expect(at).toHaveLength(3);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(75);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(75);
  });
});

describe('retriever: daily budget', () => {
  it('stops at the per-account cap with 429 + Retry-After until 00:00 UTC, then resets', async () => {
    let t = Date.parse('2026-11-22T23:00:00Z');
    const quota = createDailyQuota({ matchPerAccount: 2, now: () => t });
    const { get, gc } = await serve({ quota, now: () => t });
    expect((await get('/match/61')).status).toBe(200);
    expect((await get('/match/62')).status).toBe(200);
    const res = await get('/match/63');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
    expect(await res.json()).toEqual({ code: 'daily_quota' });
    expect(gc.calls).toHaveLength(2); // the third never reached the GC
    t = Date.parse('2026-11-23T00:00:01Z');
    expect((await get('/match/63')).status).toBe(200);
  });

  it('spreads requests over accounts and honours the per-IP cap across them', async () => {
    const quota = createDailyQuota({ matchPerAccount: 3, matchPerIp: 5 });
    const { get, gc } = await serve({ quota, gc: fakeGc({}, ['a1', 'a2']) });
    const statuses = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await get(`/match/${700 + i}`)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    const per = gc.calls.reduce((m: any, c: any) => ({ ...m, [c.account]: (m[c.account] ?? 0) + 1 }), {});
    expect(Math.abs(per.a1 - per.a2)).toBeLessThanOrEqual(1);
    expect(per.a1 + per.a2).toBe(5);
  });

  it('skips an account that is offline and one that is spent', async () => {
    const quota = createDailyQuota({ matchPerAccount: 1 });
    quota.take('match', 'a1');
    const { get, gc } = await serve({ quota, gc: fakeGc({ ready: () => ['a1', 'a3'], size: () => 3 }) });
    expect((await get('/match/81')).status).toBe(200);
    expect(gc.calls).toEqual([{ account: 'a3', matchId: '81' }]);
    expect((await get('/match/82')).status).toBe(429);
  });

  it('an account label that is also an Object property name still has a budget', async () => {
    for (const label of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const quota = createDailyQuota({ matchPerAccount: 2 });
      expect(quota.remaining('match', label), label).toBe(2);
      expect(quota.take('match', label)).toBe(true);
      expect(quota.remaining('match', label)).toBe(1);
      expect(quota.remaining('history', label)).toBe(300);
    }
    const { get } = await serve({ gc: fakeGc({}, ['constructor']) });
    expect((await get('/match/95')).status).toBe(200);
    // After the day rolls over too.
    let t = Date.parse('2026-11-22T23:59:59Z');
    const q = createDailyQuota({ matchPerAccount: 1, now: () => t });
    t += 2000;
    expect(q.remaining('match', 'constructor')).toBe(1);
  });

  it('a request whose caller left while it queued is dropped without spending budget', async () => {
    const quota = createDailyQuota();
    const gc = fakeGc({});
    const { base, get } = await serve({ gc, quota, minIntervalMs: 300 });
    const first = get('/match/101'); // sent at once; the next ones wait their turn
    const gone = new AbortController();
    const left = fetch(`${base}/match/102`, { headers: { authorization: `Bearer ${SECRET}` }, signal: gone.signal }).catch((e) => e.name);
    const stays = get('/match/103');
    await new Promise((r) => setTimeout(r, 40));
    gone.abort();
    expect(await left).toBe('AbortError');
    expect((await first).status).toBe(200);
    expect((await stays).status).toBe(200);
    expect(gc.calls.map((c: any) => c.matchId)).toEqual(['101', '103']);
    expect(quota.snapshot(1).matchUsed).toBe(2);
    // Nothing was cached for the dropped one: asking again works.
    expect((await get('/match/102')).status).toBe(200);
  });

  it('one caller leaving does not drop a request another caller still waits for', async () => {
    const gc = fakeGc({});
    const { base, get } = await serve({ gc, minIntervalMs: 300 });
    const first = get('/match/111');
    const gone = new AbortController();
    const left = fetch(`${base}/match/112`, { headers: { authorization: `Bearer ${SECRET}` }, signal: gone.signal }).catch((e) => e.name);
    const stays = get('/match/112');
    await new Promise((r) => setTimeout(r, 30));
    gone.abort();
    await left;
    expect((await stays).status).toBe(200);
    expect((await first).status).toBe(200);
    expect(gc.calls.map((c: any) => c.matchId)).toEqual(['111', '112']);
  });

  it('refuses up front (503 busy) when the line is longer than a caller would wait', async () => {
    const quota = createDailyQuota();
    const gc = fakeGc({});
    const { get } = await serve({ gc, quota, minIntervalMs: 400, maxQueueMs: 1000 });
    const res = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((i) => get(`/match/${120 + i}`)));
    const statuses = res.map((r) => r.status);
    expect(statuses.filter((s) => s === 200).length).toBe(4); // sent at 0, 400, 800, 1200 ms
    expect(statuses.filter((s) => s === 503).length).toBe(4);
    const busy = res.find((r) => r.status === 503)!;
    expect(await busy.json()).toEqual({ code: 'busy' });
    expect(busy.headers.get('retry-after')).toBe('1');
    expect(gc.calls).toHaveLength(4);
    expect(quota.snapshot(1).matchUsed).toBe(4); // the refused ones cost nothing
  });

  it('survives a restart: saved counters for today are kept, yesterday\'s and garbage are not', () => {
    const t = Date.parse('2026-11-22T10:00:00Z');
    let saved: any = null;
    const q1 = createDailyQuota({ matchPerAccount: 2, now: () => t, save: (s: any) => { saved = JSON.parse(JSON.stringify(s)); } });
    expect(q1.take('match', 'a1')).toBe(true);
    expect(q1.take('match', 'a1')).toBe(true);
    expect(q1.take('match', 'a1')).toBe(false);
    const q2 = createDailyQuota({ matchPerAccount: 2, now: () => t, load: () => saved });
    expect(q2.remaining('match', 'a1')).toBe(0);
    const q3 = createDailyQuota({ matchPerAccount: 2, now: () => t + 86_400_000, load: () => saved });
    expect(q3.remaining('match', 'a1')).toBe(2);
    const q4 = createDailyQuota({ matchPerAccount: 2, now: () => t, load: () => { throw new Error('bad json'); } });
    expect(q4.remaining('match', 'a1')).toBe(2);
    const q5 = createDailyQuota({ matchPerAccount: 2, now: () => t, load: () => ({ day: '2026-11-22', match: { a1: -5, a2: 'x', a3: 1 } }) });
    expect([q5.remaining('match', 'a1'), q5.remaining('match', 'a2'), q5.remaining('match', 'a3')]).toEqual([2, 2, 1]);
  });

  it('history has its own budget and does not eat match requests', async () => {
    const quota = createDailyQuota({ historyPerAccount: 1 });
    const { get } = await serve({ quota, historyEnabled: true });
    expect((await get('/history/5')).status).toBe(200);
    expect((await get('/history/6')).status).toBe(429);
    expect(quota.snapshot(1)).toMatchObject({ matchUsed: 0, historyUsed: 1 });
    expect((await get('/match/91')).status).toBe(200);
  });
});

describe('retriever: player history', () => {
  it('passes account and limit through, defaults to 20, and caches a repeat', async () => {
    const rows = [{ match_id: '9091400302', start_time: 1, hero_id: 14, winner: true, duration: 2000 }];
    const gc = fakeGc({});
    gc.history = async (account: string, accountId: number, limit: number) => { gc.calls.push({ account, accountId, limit }); return { matches: rows, request_id: 3 }; };
    const { get } = await serve({ gc, historyEnabled: true });
    const res = await get('/history/123456?limit=5');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ matches: rows });
    await get('/history/123456?limit=5');
    await get('/history/123456');
    expect(gc.calls).toEqual([{ account: 'a1', accountId: 123456, limit: 5 }, { account: 'a1', accountId: 123456, limit: 20 }]);
  });

  it('is off by default: 501 at once, no GC request, no budget (the live GC only answers for its own account)', async () => {
    const quota = createDailyQuota();
    const { get, gc, base } = await serve({ quota });
    const res = await get('/history/123456?limit=5');
    expect([res.status, await res.json()]).toEqual([501, { code: 'history_unsupported' }]);
    expect(gc.calls).toEqual([]);
    expect(quota.snapshot(1).historyUsed).toBe(0);
    expect((await get('/history/123456', null)).status).toBe(401); // still behind the secret
    // The site adapter reports it as not retryable.
    await expect((createSteamGcClient as any)({ baseUrl: base, secret: SECRET }).fetchRecent(123456)).rejects.toMatchObject({ status: 501, retryable: false });
  });

  it('a private profile (no matches in the answer) is an empty list, not an error', async () => {
    const { get } = await serve({ historyEnabled: true, gc: fakeGc({ history: async () => ({}) }) });
    const res = await get('/history/5');
    expect([res.status, await res.json()]).toEqual([200, { matches: [] }]);
  });
});

describe('retriever: wire format, end to end with the site adapter', () => {
  const T = (codec as any).types;
  const wire = (type: any, obj: any) => Buffer.from(type.encode(type.fromObject(obj)).finish());

  it('encodes the two requests as Valve defines them', () => {
    // field 1 varint (0x08) = match id
    expect(codec.encodeMatchDetailsRequest(ID).toString('hex')).toBe(wire(T.matchReq, { match_id: ID }).toString('hex'));
    expect(codec.encodeMatchDetailsRequest('5').toString('hex')).toBe('0805');
    // account_id = 1, matches_requested = 3, request_id = 5
    expect(codec.encodeHistoryRequest({ accountId: 5, limit: 20, requestId: 7 }).toString('hex')).toBe('080518142807');
    expect(codec.MSG).toMatchObject({ matchDetailsRequest: 7095, matchDetailsResponse: 7096, playerMatchHistory: 7408, playerMatchHistoryResponse: 7409, clientHello: 4006, clientWelcome: 4004 });
  });

  it('GC bytes → service → lib/upstream/steamGc → the same report as the OpenDota copy', async () => {
    const bytes = wire(T.matchRes, { result: 1, match: gcMatch(od) });
    const decoded = codec.decodeMatchDetailsResponse(bytes);
    expect(decoded.match.match_id).toBe(ID); // uint64 as a string: no precision loss
    expect(decoded.match.players[0]).not.toHaveProperty('item_9'); // unsent stays unsent
    // No buffs sent means the player has none: an empty list, so the flags read 0 as in OpenDota.
    expect(decoded.match.players.every((p: any) => Array.isArray(p.permanent_buffs) && p.permanent_buffs.length === 0)).toBe(true);
    expect((mapGcMatch(decoded.match) as any).players[0]).toMatchObject({ aghanims_scepter: 0, aghanims_shard: 0, moonshard: 0 });
    // Permanent buffs survive the wire (field 57) and reach the adapter's flags.
    const withBuff = gcMatch(od) as any;
    withBuff.players[0].permanent_buffs = [{ permanent_buff: 12, stack_count: 0, grant_time: 1846 }];
    const again = codec.decodeMatchDetailsResponse(wire(T.matchRes, { result: 1, match: withBuff }));
    expect(again.match.players[0].permanent_buffs).toEqual([{ permanent_buff: 12, stack_count: 0, grant_time: 1846 }]);
    expect((mapGcMatch(again.match) as any).players[0]).toMatchObject({ aghanims_shard: 1, aghanims_scepter: 0 });
    const { base, gc } = await serve({ gc: fakeGc({ matchDetails: async () => decoded }) });
    const client = (createSteamGcClient as any)({ baseUrl: base, secret: SECRET });
    const m = await client.fetchMatch(ID);
    expect(m).toMatchObject({ match_id: od.match_id, radiant_win: od.radiant_win, duration: od.duration, start_time: od.start_time, cluster: od.cluster, replay_salt: od.replay_salt, data_source: 'steam_gc' });
    expect(m.replay_url).toBe(`http://replay${od.cluster}.valve.net/570/${od.match_id}_${od.replay_salt}.dem.bz2`);
    for (const p of od.players) {
      const q = m.players.find((x: any) => x.player_slot === p.player_slot);
      for (const k of ['hero_id', 'kills', 'deaths', 'assists', 'last_hits', 'gold_per_min', 'xp_per_min', 'net_worth', 'item_0', 'item_5']) expect(q[k], `${p.player_slot}.${k}`).toBe(p[k]);
    }
    const mine = buildCoachReport(m) as any;
    const ref = buildCoachReport(od) as any;
    expect(mine.match.parsed).toBe(false);
    expect(mine.match.source).toBe('steam_gc');
    expect(mine.players.map((p: any) => p.kda)).toEqual(ref.players.map((p: any) => p.kda));
    expect(mine.reviews).toHaveLength(10);
    expect(gc.calls).toEqual([]);
  });

  it('the site adapter sees the service\'s statuses as it expects', async () => {
    const answers: Record<string, any> = { '12': { result: 2 }, '13': { result: 15 } };
    const quota = createDailyQuota({ matchPerAccount: 2 });
    const { base } = await serve({ quota, gc: fakeGc({ matchDetails: async (_a: string, id: string) => answers[id] }) });
    const client = (createSteamGcClient as any)({ baseUrl: base, secret: SECRET });
    await expect(client.fetchMatch('12')).rejects.toMatchObject({ status: 404, retryable: false });
    await expect(client.fetchMatch('13')).rejects.toMatchObject({ status: 451, retryable: false });
    const spent = await client.fetchMatch('14').catch((e: any) => e);
    expect(spent).toMatchObject({ status: 429, retryable: true });
    expect(spent.retryAfterSec).toBeGreaterThan(0);
    const wrong = (createSteamGcClient as any)({ baseUrl: base, secret: `wrong-${'w'.repeat(24)}` });
    await expect(wrong.fetchMatch('12')).rejects.toMatchObject({ status: 401, retryable: false });
  });

  it('history bytes → service → adapter rows: win/loss known, K/D/A absent, never 0/0/0', async () => {
    const bytes = wire(T.histRes, { request_id: 9, matches: [
      { match_id: ID, start_time: 1763800000, hero_id: 14, winner: true, game_mode: 22, lobby_type: 7, duration: 2400 },
      { match_id: '9091400301', start_time: 1763790000, hero_id: 2, winner: false, game_mode: 22, lobby_type: 0, duration: 1800, abandon: true },
    ] });
    const decoded = codec.decodeHistoryResponse(bytes);
    expect(decoded.request_id).toBe(9);
    const { base } = await serve({ historyEnabled: true, gc: fakeGc({ history: async () => decoded }) });
    const rows = await (createSteamGcClient as any)({ baseUrl: base, secret: SECRET }).fetchRecent(123456);
    expect(rows).toEqual(mapGcHistory(decoded));
    expect(rows.map((r: any) => [r.match_id, r.player_won, r.hero_id])).toEqual([[Number(ID), true, 14], [9091400301, false, 2]]);
    expect(rows[0]).not.toHaveProperty('kills');
    expect(mapGcMatch).toBeTypeOf('function');
  });
});

describe('retriever: tokens on disk', () => {
  it('writes 0600 files in a 0700 directory, reads them back sorted, ignores other files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'retriever-'));
    writeToken(dir, 'acct-2', 'tok-two');
    writeToken(dir, 'acct-1', 'tok-one');
    writeToken(dir, 'acct-1', 'tok-one-renewed');
    writeFileSync(join(dir, 'tokens', 'notes.txt'), 'x');
    writeFileSync(join(dir, 'tokens', 'Bad Name.token'), 'x');
    writeFileSync(join(dir, 'tokens', 'empty.token'), '\n');
    expect(readTokens(dir)).toEqual([{ label: 'acct-1', refreshToken: 'tok-one-renewed' }, { label: 'acct-2', refreshToken: 'tok-two' }]);
    expect(statSync(join(dir, 'tokens', 'acct-1.token')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'tokens')).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(dir, 'tokens')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(readTokens(join(dir, 'missing'))).toEqual([]);
  });

  it('refuses labels that could leave the directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'retriever-'));
    for (const label of ['../x', 'a/b', '', 'UPPER', '.hidden', 'a'.repeat(33)]) expect(() => writeToken(dir, label, 't')).toThrow(/label/);
  });

  it('reads a token\'s expiry without trusting its shape', () => {
    const jwt = (payload: any) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
    expect(tokenExpiry(jwt({ exp: 1800000000 }))).toBe(1800000000000);
    expect(tokenExpiry(jwt({}))).toBeNull();
    expect(tokenExpiry('garbage')).toBeNull();
    expect(tokenExpiry(undefined as any)).toBeNull();
  });

  it('says why a stored token cannot log on, so a bad file never reaches steam-user', () => {
    const jwt = (payload: any) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
    const good = { sub: '76561198000000001', iss: 'steam', aud: ['client', 'web'], exp: 1900000000 };
    const now = 1800000000000;
    expect(tokenProblem(jwt(good), now)).toBeNull();
    expect(tokenProblem(jwt({ ...good, exp: undefined }), now)).toBeNull();
    expect(tokenProblem('garbage', now)).toBe('not a token');
    expect(tokenProblem('a.b.c', now)).toBe('not a token');
    expect(tokenProblem(`h.${Buffer.from('null').toString('base64url')}.s`, now)).toBe('not a token');
    expect(tokenProblem(jwt({ ...good, sub: 'someone' }), now)).toBe('no Steam account in it');
    expect(tokenProblem(jwt({ ...good, iss: 'r:1234' }), now)).toBe('not a refresh token'); // an access token
    expect(tokenProblem(jwt({ ...good, aud: ['web'] }), now)).toBe('not valid for the Steam client');
    expect(tokenProblem(jwt({ ...good, aud: 'client' }), now)).toBe('not valid for the Steam client');
    expect(tokenProblem(jwt({ ...good, exp: 1700000000 }), now)).toBe('expired');
  });
});
