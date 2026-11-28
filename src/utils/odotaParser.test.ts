import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createIdTokenProvider, createOdotaParserClient as createClient, isAllowedValveReplayUrl, laneFromPositions, mergeGcAndParsed,
} from '../../lib/upstream/odotaParser.js';
import { buildValveReplayUrl, mapGcMatch } from '../../lib/upstream/steamGc.js';
import { chooseParseSubmitter, createSelfHostedParseSubmitter } from '../../lib/matchReview/selfHostedParse.js';
import { createMatchDetailCache } from '../../lib/matchReview/matchDetailCache.js';
import { createParseRequestBudget, createParseRequestTracker, isMatchParsed } from '../../lib/matchReview/matchParse.js';
import { buildCoachReport, dataGaps, heroInfo } from '../../lib/coach/analyze.js';
import { buildSurface, validateSurface } from '../../lib/coach/cards.js';

/**
 * A real game: `blob` is what odota/parser returned for the Valve replay,
 * `gc` the scoreboard as the GC sends it, `opendota` what OpenDota computed
 * for the same match (the reference our merge is checked against).
 */
const fx = JSON.parse(readFileSync(new URL('../fixtures/selfParse/match9100809044.json', import.meta.url), 'utf8'));
const ID = 9100809044;
const URL_OK = 'http://replay181.valve.net/570/9100809044_366089646.dem.bz2';
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const gc = () => mapGcMatch(clone(fx.gc), '2026-11-22T00:00:00.000Z') as any;
const npc = (id: number) => { const s = heroInfo(id).slug; return s ? `npc_dota_hero_${s}` : null; };
const merge = (g: any = gc(), b: any = clone(fx.blob), o: any = {}) => mergeGcAndParsed(g, b, { parsedAt: '2026-11-22T00:01:00.000Z', heroNpcName: npc, ...o }) as any;
const createOdotaParserClient = (o: any): any => createClient(o);

describe('isAllowedValveReplayUrl: only Valve replay addresses reach the parser', () => {
  it('accepts the address built from GC data', () => {
    expect(buildValveReplayUrl(gc())).toBe(URL_OK);
    expect(isAllowedValveReplayUrl(URL_OK)).toBe(true);
    expect(isAllowedValveReplayUrl('http://replay1.valve.net/570/1_0.dem.bz2')).toBe(true);
  });

  it.each([
    'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token',
    'http://metadata.google.internal/570/9100809044_366089646.dem.bz2',
    'file:///etc/passwd',
    'https://replay181.valve.net/570/9100809044_366089646.dem.bz2',
    'http://evil.com/570/9100809044_366089646.dem.bz2',
    'http://replay181.valve.net.evil.com/570/9100809044_366089646.dem.bz2',
    'http://evil.com/?http://replay181.valve.net/570/9100809044_366089646.dem.bz2',
    'http://user:pw@replay181.valve.net/570/9100809044_366089646.dem.bz2',
    'http://replay181.valve.net@evil.com/570/9100809044_366089646.dem.bz2',
    'http://replay181.valve.net:8080/570/9100809044_366089646.dem.bz2',
    'http://replay181.valve.net/570/9100809044_366089646.dem.bz2?x=1',
    'http://replay181.valve.net/570/9100809044_366089646.dem.bz2#x',
    'http://replay181.valve.net/570/../../9100809044_366089646.dem.bz2',
    'http://replay181.valve.net/730/9100809044_366089646.dem.bz2',
    'http://replay181.valve.net/570/9100809044_366089646.dem',
    'http://replay181.valve.net/570/0_366089646.dem.bz2',
    'http://replay181.valve.net/570/9100809044_366089646.dem.bz2\nHost: evil',
    ' http://replay181.valve.net/570/9100809044_366089646.dem.bz2',
    'http://replayX.valve.net/570/9100809044_366089646.dem.bz2',
    'http://replay.valve.net/570/9100809044_366089646.dem.bz2',
    'HTTP://REPLAY181.VALVE.NET/570/9100809044_366089646.dem.bz2',
    '',
  ])('rejects %j', (url) => { expect(isAllowedValveReplayUrl(url)).toBe(false); });

  it('rejects non-strings', () => {
    for (const v of [null, undefined, 5, {}, [URL_OK], new URL(URL_OK)]) expect(isAllowedValveReplayUrl(v as any)).toBe(false);
  });
});

describe('mergeGcAndParsed: a real replay parse, checked against OpenDota\'s own numbers', () => {
  const m = merge();

  it('reads as parsed and says where it came from', () => {
    expect(isMatchParsed(m)).toBe(true);
    expect(m).toMatchObject({ match_id: ID, od_data: { has_parsed: true }, data_source: 'steam_gc+odota_parser', parsed_at: '2026-11-22T00:01:00.000Z', version: 22 });
    expect(m.players.map((p: any) => p.player_slot)).toEqual([0, 1, 2, 3, 4, 128, 129, 130, 131, 132]);
    expect(m.radiant_gold_adv).toEqual(fx.blob.radiant_gold_adv);
    expect(m.objectives).toEqual(fx.blob.objectives);
  });

  it('computes lane, role, roaming, time dead, win and buybacks exactly as OpenDota did', () => {
    for (const ref of fx.opendota.players) {
      const p = m.players.find((x: any) => x.player_slot === ref.player_slot);
      for (const k of ['lane', 'lane_role', 'is_roaming', 'life_state_dead', 'win', 'lose', 'buyback_count']) expect(p[k], `${ref.player_slot}.${k}`).toEqual(ref[k]);
    }
  });

  it('keeps the purchase and kill logs as OpenDota stores them (no recipes, no ward dispensers)', () => {
    for (const ref of fx.opendota.players) {
      const p = m.players.find((x: any) => x.player_slot === ref.player_slot);
      expect(p.purchase_log).toEqual(ref.purchase_log);
      expect(p.kills_log).toEqual(ref.kills_log);
    }
    const raw = fx.blob.players.flatMap((p: any) => p.purchase_log);
    expect(raw.filter((x: any) => x.key === 'ward_dispenser').length).toBe(31); // the filter had something to do
    const withRecipe = clone(fx.blob);
    withRecipe.players[0].purchase_log.push({ time: 900, key: 'recipe_bracer' }, { time: 901, key: 'bracer' });
    expect(merge(gc(), withRecipe).players[0].purchase_log.slice(-1)).toEqual([{ time: 901, key: 'bracer' }]);
    expect(m.players.flatMap((p: any) => p.purchase_log).some((x: any) => x.key.startsWith('recipe_') || x.key === 'ward_dispenser')).toBe(false);
  });

  it('removes self-kills from the kill log when the hero is known', () => {
    const b = clone(fx.blob);
    const me = gc().players[0];
    b.players[0].kills_log = [{ time: 10, key: npc(me.hero_id) }, { time: 20, key: 'npc_dota_hero_someone_else' }];
    expect(merge(gc(), b).players[0].kills_log).toEqual([{ time: 20, key: 'npc_dota_hero_someone_else' }]);
    expect(merge(gc(), b, { heroNpcName: () => null }).players[0].kills_log).toHaveLength(2);
  });

  it('the scoreboard stays Valve\'s: the parse never overwrites K/D/A, items or net worth', () => {
    const b = clone(fx.blob);
    b.players.forEach((p: any) => Object.assign(p, { kills: 99, deaths: 99, net_worth: 1, item_0: 12345, hero_id: 1, account_id: 7 }));
    const out = merge(gc(), b);
    const g = gc();
    for (const p of out.players) {
      const ref = g.players.find((x: any) => x.player_slot === p.player_slot);
      for (const k of ['kills', 'deaths', 'assists', 'net_worth', 'item_0', 'hero_id', 'account_id', 'last_hits']) expect(p[k]).toEqual(ref[k]);
    }
  });

  it('matches players by slot, not by position: a shuffled parse gives the same match', () => {
    const b = clone(fx.blob);
    const order = [7, 2, 9, 0, 5, 3, 8, 1, 6, 4];
    b.players = order.map((i) => fx.blob.players[i]);
    b.teamfights = fx.blob.teamfights.map((f: any) => ({ ...f, players: order.map((i) => f.players[i]) }));
    expect(merge(gc(), b)).toEqual(m);
    const g = gc();
    g.players.reverse();
    expect(merge(g)).toEqual(m);
  });

  it('teamfight rows follow the players (each row belongs to the same slot as in the parse)', () => {
    expect(m.teamfights).toEqual(fx.blob.teamfights); // the parser's order was already slot order
    expect(m.teamfights.length).toBeGreaterThan(3);
    expect(m.teamfights.every((f: any) => f.players.length === 10)).toBe(true);
  });

  it('invents nothing: no benchmarks, no rank, no names, and the gap is listed', () => {
    for (const p of m.players) {
      expect(p.benchmarks).toBeUndefined();
      expect(p.rank_tier).toBeUndefined();
      expect(p.personaname).toBeUndefined();
      expect(p.account_id).toBeNull(); // anonymous in the scoreboard stays anonymous
    }
    const gaps = dataGaps(m).map((g: any) => g.en);
    expect(gaps).toEqual(['How your numbers rank against other players of the same hero (percentiles)']);
    expect(dataGaps({ ...m, players: m.players.map((p: any) => ({ ...p, benchmarks: { gold_per_min: { raw: 500, pct: 0.5 } } })) })).toEqual([]);
  });

  it.each([
    ['nine players in the parse', (g: any, b: any) => { b.players.pop(); }, /not ten players/],
    ['a slot missing from the parse', (g: any, b: any) => { b.players[3].player_slot = 0; }, /player slots/],
    ['a slot the parse does not know', (g: any, b: any) => { b.players[9].player_slot = 133; }, /player slots/],
    ['the parse of another match', (g: any, b: any) => { b.match_id = 123; }, /another match/],
    ['no gold advantage series', (g: any, b: any) => { b.radiant_gold_adv = []; }, /no timelines/],
    ['a player without a gold series', (g: any, b: any) => { b.players[4].gold_t = []; }, /no timelines/],
    ['no scoreboard', (g: any) => { g.players = g.players.slice(0, 9); }, /no scoreboard/],
    ['an empty parse', (g: any, b: any) => { for (const k of Object.keys(b)) delete b[k]; }, /not ten players/],
  ])('refuses %s rather than store a half-merged match', (_name, breakIt, message) => {
    const g = gc(); const b = clone(fx.blob);
    (breakIt as any)(g, b);
    let err: any;
    try { merge(g, b); } catch (e) { err = e; }
    expect(err?.message).toMatch(message);
    expect(err).toMatchObject({ status: 502, retryable: false, code: 'parse_unusable', upstream: 'odota_parser' });
  });

  it('refuses null and non-object input', () => {
    expect(() => mergeGcAndParsed(null as any, fx.blob)).toThrow(/no scoreboard/);
    expect(() => mergeGcAndParsed(gc(), null as any)).toThrow(/not ten players/);
    expect(() => mergeGcAndParsed(gc(), 'x' as any)).toThrow(/not ten players/);
  });

  it('does not change its inputs', () => {
    const g = gc(); const b = clone(fx.blob);
    const before = JSON.stringify([g, b]);
    merge(g, b);
    expect(JSON.stringify([g, b])).toBe(before);
  });
});

describe('the coach engine on a self-parsed match', () => {
  const m = merge();
  const report = buildCoachReport(m) as any;

  it('builds every chapter for all ten seats, with no NaN and nothing dropped by the card validator', () => {
    expect(report.match).toMatchObject({ id: ID, parsed: true, source: 'steam_gc' });
    expect(report.reviews).toHaveLength(10);
    for (let s = 0; s < 10; s += 1) {
      const r = report.reviews[s];
      expect(r.headline.en).toBeTruthy();
      for (const ch of ['story', 'laning', 'deaths', 'items', 'fights']) expect(r.chapters[ch], `seat ${s} ${ch}`).toBeTruthy();
      expect(r.chapters.story.why.length, `seat ${s} why`).toBeGreaterThan(0);
      expect(Array.isArray(r.chapters.plan)).toBe(true);
      const surface = buildSurface(report, s);
      expect(validateSurface(surface)).toEqual(surface);
      expect(surface!.cards.some((c: any) => c.component === 'GoldGraph')).toBe(true);
    }
    expect(JSON.stringify(report)).not.toMatch(/NaN|undefined/);
    expect(report.data_gaps.map((g: any) => g.en)).toEqual(['How your numbers rank against other players of the same hero (percentiles)']);
  });

  it('makes no percentile or rank-bracket claim', () => {
    for (const p of report.players) { expect(p.benchmarks).toBeNull(); expect(p.rank_tier).toBeNull(); }
    for (const r of report.reviews) expect(r.bracket).toBeNull();
    expect(JSON.stringify(report.reviews)).not.toMatch(/more than \d+% of|多于 \d+% 的/);
  });
});

describe('laneFromPositions', () => {
  it('reads the lane from where the time was spent', () => {
    // x, y are map cells (64..191); bottom-right is Radiant's safe lane.
    expect(laneFromPositions({ 170: { 80: 50 } }, true)).toEqual({ lane: 1, lane_role: 1, is_roaming: false });
    expect(laneFromPositions({ 170: { 80: 50 } }, false)).toEqual({ lane: 1, lane_role: 3, is_roaming: false });
    expect(laneFromPositions({ 80: { 170: 50 } }, true)).toEqual({ lane: 3, lane_role: 3, is_roaming: false });
    expect(laneFromPositions({ 128: { 128: 50 } }, false)).toEqual({ lane: 2, lane_role: 2, is_roaming: false });
  });

  it('under 45% in the main lane is roaming', () => {
    expect(laneFromPositions({ 170: { 80: 40 }, 80: { 170: 30 }, 128: { 128: 30 } }, true)).toMatchObject({ lane: 1, is_roaming: true });
    expect(laneFromPositions({ 170: { 80: 46 }, 80: { 170: 27 }, 128: { 128: 27 } }, true)).toMatchObject({ lane: 1, is_roaming: false });
  });

  it('no usable positions is null, never a guessed lane', () => {
    for (const v of [null, undefined, {}, { 170: {} }, { 9999: { 80: 5 } }, { x: { y: 5 } }, { 170: { 80: 0 } }, { 170: { 80: 'a' } }, { 170: null }]) {
      expect(laneFromPositions(v as any, true)).toBeNull();
    }
    const b = clone(fx.blob);
    b.players[2].lane_pos = {};
    const p = merge(gc(), b).players[2];
    expect(p.lane).toBeUndefined();
    expect(p.lane_role).toBeUndefined();
  });
});

describe('createOdotaParserClient', () => {
  const blobText = JSON.stringify({ players: [], version: 22 });
  const res = (status: number, body = '', headers: Record<string, string> = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers), text: async () => body });

  it('asks /blob with the replay address encoded, and returns the blob', async () => {
    const seen: any[] = [];
    const c = createOdotaParserClient({ baseUrl: 'http://parser.internal:5600/', fetchImpl: async (url: string, init: any) => { seen.push([url, init.headers]); return res(200, blobText); } });
    expect(await c.parse(URL_OK)).toEqual({ players: [], version: 22 });
    expect(seen[0][0]).toBe(`http://parser.internal:5600/blob?replay_url=${encodeURIComponent(URL_OK)}`);
    expect(seen[0][1].authorization).toBeUndefined();
    expect(c.snapshot()).toMatchObject({ configured: true, parses: 1, ok: 1, running: 0 });
  });

  it('never sends a URL that is not a Valve replay: no request at all', async () => {
    let calls = 0;
    const c = createOdotaParserClient({ baseUrl: 'http://p', fetchImpl: async () => { calls += 1; return res(200, blobText); } });
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'https://evil.com/x.dem.bz2', `${URL_OK}?a=b`, '', null]) {
      await expect(c.parse(url)).rejects.toMatchObject({ code: 'url_not_allowed', status: 400, retryable: false });
      await expect(c.replayAvailable(url)).rejects.toMatchObject({ code: 'url_not_allowed' });
    }
    expect(calls).toBe(0);
    expect(c.snapshot().rejectedUrls).toBe(10);
  });

  it('204 or an empty body means the replay is gone: not retryable', async () => {
    for (const answer of [res(204), res(200, '')]) {
      const c = createOdotaParserClient({ baseUrl: 'http://p', fetchImpl: async () => answer });
      await expect(c.parse(URL_OK)).rejects.toMatchObject({ code: 'replay_gone', status: 404, retryable: false });
      expect(c.snapshot()).toMatchObject({ gone: 1, failed: 0 });
    }
  });

  it('a parser error, a timeout, an unreadable or oversized answer are failures, never a blob', async () => {
    const cases: [any, any][] = [
      [async () => res(500), { code: 'parser_failed', status: 502, retryable: true }],
      [async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, { code: 'parser_failed', status: 503, retryable: true, message: 'replay parser timeout' }],
      [async () => { throw new Error('ECONNREFUSED'); }, { code: 'parser_failed', status: 503, message: 'replay parser unreachable' }],
      [async () => res(200, '<html>'), { code: 'parser_failed', retryable: true }],
      [async () => res(200, '{"version":22}'), { code: 'parser_failed' }],
      [async () => res(200, 'null'), { code: 'parser_failed' }],
      [async () => res(200, blobText, { 'content-length': '99999999' }), { code: 'parser_failed', retryable: false }],
    ];
    for (const [fetchImpl, want] of cases) {
      const c = createOdotaParserClient({ baseUrl: 'http://p', fetchImpl });
      await expect(c.parse(URL_OK)).rejects.toMatchObject(want);
      expect(c.snapshot()).toMatchObject({ failed: 1, ok: 0, running: 0 });
    }
    const small = createOdotaParserClient({ baseUrl: 'http://p', maxBytes: 10, fetchImpl: async () => res(200, blobText) });
    await expect(small.parse(URL_OK)).rejects.toMatchObject({ code: 'parser_failed', retryable: false });
  });

  it('parses of the same replay share one request; a later ask starts a new one', async () => {
    let calls = 0; let release: any;
    const c = createOdotaParserClient({ baseUrl: 'http://p', fetchImpl: async () => { calls += 1; await new Promise((r) => { release = r; }); return res(200, blobText); } });
    const a = c.parse(URL_OK); const b = c.parse(URL_OK);
    await new Promise((r) => setTimeout(r, 5));
    release();
    expect(await a).toBe(await b);
    expect(calls).toBe(1);
    const again = c.parse(URL_OK);
    await new Promise((r) => setTimeout(r, 5));
    release();
    await again;
    expect(calls).toBe(2);
  });

  it('runs at most maxConcurrent at once, queues up to maxQueued, then says busy', async () => {
    let running = 0; let peak = 0; const releases: any[] = [];
    const c = createOdotaParserClient({ baseUrl: 'http://p', maxConcurrent: 2, maxQueued: 1, fetchImpl: async () => {
      running += 1; peak = Math.max(peak, running);
      await new Promise((r) => releases.push(r));
      running -= 1;
      return res(200, blobText);
    } });
    const url = (i: number) => `http://replay181.valve.net/570/${9100809044 + i}_1.dem.bz2`;
    const jobs = [0, 1, 2].map((i) => c.parse(url(i)));
    await new Promise((r) => setTimeout(r, 5));
    expect(c.snapshot()).toMatchObject({ running: 2, queued: 1 });
    await expect(c.parse(url(3))).rejects.toMatchObject({ code: 'busy', status: 503, retryable: true });
    releases.shift()();
    await new Promise((r) => setTimeout(r, 5));
    expect(releases).toHaveLength(2); // the queued one started
    releases.forEach((r) => r());
    await Promise.all(jobs);
    expect(peak).toBe(2);
    expect(c.snapshot()).toMatchObject({ running: 0, queued: 0, ok: 3, busy: 1 });
    // A failure frees its slot too.
    const d = createOdotaParserClient({ baseUrl: 'http://p', maxConcurrent: 1, maxQueued: 0, fetchImpl: async () => res(500) });
    await expect(d.parse(url(0))).rejects.toMatchObject({ code: 'parser_failed' });
    await expect(d.parse(url(1))).rejects.toMatchObject({ code: 'parser_failed' });
  });

  it('sends the auth header it is given, and fails closed when the token cannot be had', async () => {
    const seen: any[] = [];
    const c = createOdotaParserClient({ baseUrl: 'https://parser.run.app', authHeader: async () => 'Bearer tok', fetchImpl: async (_u: string, init: any) => { seen.push(init.headers.authorization); return res(200, blobText); } });
    await c.parse(URL_OK);
    expect(seen).toEqual(['Bearer tok']);
    let calls = 0;
    const d = createOdotaParserClient({ baseUrl: 'https://parser.run.app', authHeader: async () => { throw Object.assign(new Error('identity token unavailable'), { code: 'parser_failed' }); }, fetchImpl: async () => { calls += 1; return res(200, blobText); } });
    await expect(d.parse(URL_OK)).rejects.toMatchObject({ code: 'parser_failed' });
    expect(calls).toBe(0);
    expect(d.snapshot().running).toBe(0);
  });

  it('replayAvailable: HEAD to Valve only, without following redirects', async () => {
    const seen: any[] = [];
    const answers = [200, 404, 403, 500, 302];
    const c = createOdotaParserClient({ baseUrl: 'http://p', fetchImpl: async (url: string, init: any) => { seen.push([url, init.method, init.redirect]); return res(answers.shift()!); } });
    expect(await c.replayAvailable(URL_OK)).toBe(true);
    expect(await c.replayAvailable(URL_OK)).toBe(false);
    expect(await c.replayAvailable(URL_OK)).toBe(false);
    expect(await c.replayAvailable(URL_OK)).toBeNull();
    expect(await c.replayAvailable(URL_OK)).toBeNull();
    expect(seen.every(([u, m, r]) => u === URL_OK && m === 'HEAD' && r === 'manual')).toBe(true);
    const down = createOdotaParserClient({ baseUrl: 'http://p', fetchImpl: async () => { throw new Error('net'); } });
    expect(await down.replayAvailable(URL_OK)).toBeNull();
  });

  it('refuses a base URL that is not http(s)', () => {
    for (const baseUrl of ['', 'parser:5600', 'file:///x', 'ftp://x']) expect(() => createOdotaParserClient({ baseUrl })).toThrow(/ODOTA_PARSER_URL/);
  });
});

describe('createIdTokenProvider', () => {
  const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;

  it('asks the metadata server for the configured audience and reuses the token until near expiry', async () => {
    let t = 1_800_000_000_000; const seen: any[] = [];
    const header = createIdTokenProvider({ audience: 'https://parser-abc.a.run.app/blob', now: () => t, fetchImpl: (async (url: string, init: any) => { seen.push([url, init.headers]); return { ok: true, text: async () => jwt(t / 1000 + 3600) }; }) as any });
    const first = await header();
    expect(first).toMatch(/^Bearer h\./);
    expect(seen[0][0]).toBe('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=https%3A%2F%2Fparser-abc.a.run.app');
    expect(seen[0][1]).toEqual({ 'Metadata-Flavor': 'Google' });
    t += 54 * 60_000;
    expect(await header()).toBe(first);
    t += 2 * 60_000; // inside the last five minutes
    await header();
    expect(seen).toHaveLength(2);
  });

  it('fails when the metadata server refuses, and rejects a bad audience up front', async () => {
    const header = createIdTokenProvider({ audience: 'https://p.run.app', fetchImpl: (async () => ({ ok: false, text: async () => '' })) as any });
    await expect(header()).rejects.toMatchObject({ code: 'parser_failed', retryable: true });
    for (const audience of ['', 'p.run.app', 'http://p.run.app']) expect(() => createIdTokenProvider({ audience })).toThrow(/ODOTA_PARSER_AUDIENCE/);
  });
});

describe('self-hosted parse request', () => {
  function setup(over: any = {}) {
    let t = 1_800_000_000_000;
    const calls = { gc: 0, head: 0, parse: [] as string[], stored: [] as any[] };
    const logs: string[] = [];
    const tracker = createParseRequestTracker({ now: () => t });
    const budget = createParseRequestBudget({ now: () => t, globalMax: over.globalMax ?? 10, perClientMax: over.perClientMax ?? 3 });
    const submit: any = createSelfHostedParseSubmitter({
      tracker, budget, now: () => t, isParsed: isMatchParsed, heroNpcName: npc,
      steamGc: { fetchMatch: over.fetchMatch ?? (async () => { calls.gc += 1; return gc(); }) },
      parser: {
        replayAvailable: over.replayAvailable ?? (async () => { calls.head += 1; return true; }),
        parse: over.parse ?? (async (url: string) => { calls.parse.push(url); return clone(fx.blob); }),
      },
      onParsed: over.onParsed ?? ((id: number, m: any) => calls.stored.push([id, m])),
      log: (l: string) => logs.push(l), warn: (l: string) => logs.push(l),
    } as any);
    return { submit, calls, tracker, logs, tick: (ms: number) => { t += ms; } };
  }

  it('answers at once, then fetches the scoreboard, parses the replay and hands over a parsed match', async () => {
    const { submit, calls, tracker } = setup();
    const answer = await submit(ID, '1.1.1.1', { lang: 'en' });
    expect(answer).toEqual({ status: 'requested', jobId: null, retryAfterSec: 45, provider: 'self_hosted', message: 'Parsing the replay now. Check back in about 45s for lanes and timelines' });
    expect(answer.message).not.toMatch(/OpenDota/);
    expect(calls.stored).toEqual([]); // not waited for
    await submit.idle();
    expect(calls).toMatchObject({ gc: 1, head: 1, parse: [URL_OK] });
    expect(calls.stored).toHaveLength(1);
    expect(calls.stored[0][0]).toBe(ID);
    expect(isMatchParsed(calls.stored[0][1])).toBe(true);
    expect(calls.stored[0][1].data_source).toBe('steam_gc+odota_parser');
    expect(tracker.active(ID)).toMatchObject({ failed: false });
  });

  it('uses the GC copy it is given instead of spending another GC request', async () => {
    const { submit, calls } = setup();
    await submit(ID, 'ip', { matchData: gc() });
    await submit.idle();
    expect(calls.gc).toBe(0);
    expect(calls.stored).toHaveLength(1);
    // A copy from elsewhere (no replay address we trust) is not used.
    const b = setup();
    await b.submit(ID, 'ip', { matchData: { ...gc(), data_source: 'stratz', cluster: null, replay_salt: null, replay_url: null } });
    await b.submit.idle();
    expect(b.calls.gc).toBe(1);
    const c = setup();
    await c.submit(ID, 'ip', { matchData: { ...gc(), match_id: 5 } });
    await c.submit.idle();
    expect(c.calls.gc).toBe(1);
  });

  it('a second request while one is running is "pending" and starts nothing', async () => {
    let release: any;
    const { submit, calls } = setup({ parse: async () => { await new Promise((r) => { release = r; }); return clone(fx.blob); } });
    expect((await submit(ID, 'a')).status).toBe('requested');
    await new Promise((r) => setTimeout(r, 5));
    const second = await submit(ID, 'b', { lang: 'zh' });
    expect(second).toMatchObject({ status: 'pending', provider: 'self_hosted', retryAfterSec: 45, message: '本场比赛仍在解析中，约 45 秒后再看' });
    release();
    await submit.idle();
    expect(calls.gc).toBe(1);
    expect(calls.stored).toHaveLength(1);
  });

  it('over budget is "throttled": no GC request, no parse', async () => {
    const { submit, calls } = setup({ perClientMax: 1 });
    expect((await submit(ID, 'same')).status).toBe('requested');
    const next = await submit(ID + 1, 'same');
    expect(next.status).toBe('throttled');
    expect(next.retryAfterSec).toBeGreaterThan(0);
    await submit.idle();
    expect(calls.gc).toBe(1);
    expect(calls.parse).toHaveLength(1);
  });

  it('a replay Valve no longer has: failed, nothing stored, and asking again costs nothing', async () => {
    for (const over of [
      { replayAvailable: async () => false },
      { parse: async () => { throw Object.assign(new Error('replay not available'), { code: 'replay_gone' }); } },
      { fetchMatch: async () => ({ ...gc(), replay_salt: 0, cluster: 0 }) },
    ]) {
      const { submit, calls, tracker, tick } = setup({ perClientMax: 1, ...over });
      expect((await submit(ID, 'ip')).status).toBe('requested');
      await submit.idle();
      expect(calls.stored).toEqual([]);
      expect(tracker.active(ID)).toMatchObject({ failed: true });
      tick(2 * 60_000); // past the failure cooldown
      const again = await submit(ID, 'ip', { lang: 'en' });
      expect(again).toMatchObject({ status: 'failed', retryAfterSec: null, reason: 'replay_gone', provider: 'self_hosted' });
      expect(again.message).toMatch(/Valve no longer has this replay/);
      expect((await submit(ID + 1, 'other')).status).toBe('requested'); // the global budget was not eaten
      await submit.idle();
      tick(7 * 60 * 60_000); // remembered for six hours, then it may be tried again
      expect((await submit(ID, 'third')).status).toBe('requested');
      await submit.idle();
    }
  });

  it('with the replay address already known, a gone replay is reported in the answer itself', async () => {
    const { submit, calls, tracker } = setup({ replayAvailable: async () => false });
    const answer = await submit(ID, 'ip', { lang: 'zh', matchData: gc() });
    expect(answer).toMatchObject({ status: 'failed', reason: 'replay_gone', provider: 'self_hosted', retryAfterSec: null });
    expect(answer.message).toMatch(/Valve 已不再保存/);
    await submit.idle();
    expect(calls).toMatchObject({ gc: 0, parse: [], stored: [] });
    expect(tracker.active(ID)).toMatchObject({ failed: true });
    // A copy with no replay address at all is the same answer.
    const b = setup();
    expect(await b.submit(ID, 'ip', { matchData: { ...gc(), cluster: null, replay_salt: null } })).toMatchObject({ status: 'failed', reason: 'replay_gone' });
    expect(b.calls.parse).toEqual([]);
  });

  it('with the replay address known and the replay there, it is checked once, not twice', async () => {
    const { submit, calls } = setup();
    expect((await submit(ID, 'ip', { matchData: gc() })).status).toBe('requested');
    await submit.idle();
    expect(calls).toMatchObject({ gc: 0, head: 1, parse: [URL_OK] });
    expect(calls.stored).toHaveLength(1);
  });

  it('when the HEAD check cannot tell, the parser decides', async () => {
    const { submit, calls } = setup({ replayAvailable: async () => null });
    await submit(ID, 'ip');
    await submit.idle();
    expect(calls.parse).toEqual([URL_OK]);
    expect(calls.stored).toHaveLength(1);
  });

  it.each([
    ['the GC is unreachable', { fetchMatch: async () => { throw Object.assign(new Error('Steam GC HTTP 503'), { status: 503 }); } }],
    ['the parser fails', { parse: async () => { throw Object.assign(new Error('replay parser HTTP 500'), { code: 'parser_failed' }); } }],
    ['the parse is of other players', { parse: async () => { const b = clone(fx.blob); b.players[0].player_slot = 77; return b; } }],
    ['the parse has no timelines', { parse: async () => ({ ...clone(fx.blob), radiant_gold_adv: [] }) }],
    ['storing throws', { onParsed: () => { throw new Error('disk'); } }],
  ])('%s: failed, nothing stored as parsed, and it may be retried after the cooldown', async (_n, over) => {
    const stored: any[] = [];
    const { submit, tracker, tick, calls } = setup({ onParsed: (id: number, m: any) => stored.push(m), ...over });
    expect((await submit(ID, 'ip')).status).toBe('requested');
    await submit.idle();
    expect(stored).toEqual([]);
    expect(calls.stored).toEqual([]);
    expect(tracker.active(ID)).toMatchObject({ failed: true });
    const failed = await submit(ID, 'ip', { lang: 'en' });
    expect(failed).toMatchObject({ status: 'failed', provider: 'self_hosted', message: 'The parse did not go through. Try again in a minute' });
    expect(failed.reason).toBeUndefined();
    tick(61_000);
    expect((await submit(ID, 'ip')).status).toBe('requested'); // not remembered as gone
    await submit.idle();
  });

  it('a slow failure is still backed off: the cooldown counts from the failure', async () => {
    let fail: any;
    const { submit, tracker, tick, calls } = setup({ parse: () => new Promise((_r, reject) => { fail = reject; }) });
    expect((await submit(ID, 'ip')).status).toBe('requested');
    await new Promise((r) => setTimeout(r, 5));
    tick(90_000); // the parser takes a minute and a half, then fails
    fail(Object.assign(new Error('replay parser timeout'), { code: 'parser_failed' }));
    await submit.idle();
    expect(tracker.active(ID)).toMatchObject({ failed: true, retryAfterSec: 60 });
    expect((await submit(ID, 'ip')).status).toBe('failed'); // not a second parse
    tick(59_000);
    expect((await submit(ID, 'ip')).status).toBe('failed');
    tick(2_000);
    expect((await submit(ID, 'ip')).status).toBe('requested');
    await new Promise((r) => setTimeout(r, 5));
    fail(new Error('again'));
    await submit.idle();
    expect(calls.gc).toBe(2);
    // The same when storing the result is what failed.
    let store: any;
    const b = setup({ parse: async () => { await new Promise((r) => { store = r; }); return clone(fx.blob); }, onParsed: () => { throw new Error('disk'); } });
    await b.submit(ID, 'ip');
    await new Promise((r) => setTimeout(r, 5));
    b.tick(90_000);
    store();
    await b.submit.idle();
    expect(b.tracker.active(ID)).toMatchObject({ failed: true, retryAfterSec: 60 });
  });

  it('a caller who leaves during the replay check starts no parse and leaves no failure behind', async () => {
    const gone = new AbortController();
    const { submit, calls, tracker, tick } = setup({ replayAvailable: async () => { gone.abort(); return true; } });
    await expect(submit(ID, 'ip', { matchData: gc(), signal: gone.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await submit.idle();
    expect(calls).toMatchObject({ gc: 0, parse: [], stored: [] });
    expect(tracker.active(ID)).toMatchObject({ failed: false, aborted: true });
    tick(61_000); // the short abort window, not the five-minute one
    expect((await submit(ID, 'ip', { matchData: gc() })).status).toBe('requested');
    await submit.idle();
    expect(calls.parse).toEqual([URL_OK]);
    // Leaving after the request was accepted does not stop the parse.
    const later = new AbortController();
    const c = setup();
    expect((await c.submit(ID, 'ip', { matchData: gc(), signal: later.signal })).status).toBe('requested');
    later.abort();
    await c.submit.idle();
    expect(c.calls.stored).toHaveLength(1);
  });

  it('logs no replay address, salt or account', async () => {
    const { submit, logs } = setup();
    await submit(ID, '9.9.9.9');
    await submit.idle();
    expect(logs.join('\n')).not.toMatch(/366089646|valve\.net|9\.9\.9\.9/);
  });

  it('needs all its parts', () => {
    expect(() => createSelfHostedParseSubmitter({} as any)).toThrow(/requires/);
  });

  it('chooseParseSubmitter: our parser only when it exists and the rule says so, OpenDota otherwise', async () => {
    const seen: string[] = [];
    const openDota = async (...a: any[]) => { seen.push(`od:${a[0]}:${a[1]}:${a[2].lang}`); return { status: 'requested' }; };
    const selfHosted = async (...a: any[]) => { seen.push(`self:${a[0]}:${a[1]}:${a[2].lang}`); return { status: 'requested', provider: 'self_hosted' }; };
    const rule = (m?: any) => m?.data_source === 'steam_gc';
    const both: any = chooseParseSubmitter({ openDota, selfHosted, useSelfHosted: rule });
    expect(await both(1, 'ip', { lang: 'en', matchData: { data_source: 'steam_gc' } })).toMatchObject({ provider: 'self_hosted' });
    await both(2, 'ip', { lang: 'zh', matchData: {} });
    await both(3, 'ip', { lang: 'zh' });
    const none: any = chooseParseSubmitter({ openDota, selfHosted: null, useSelfHosted: () => true });
    await none(4, 'ip', { lang: 'en', matchData: { data_source: 'steam_gc' } });
    const plain: any = chooseParseSubmitter({ openDota });
    await plain(5, 'ip', { lang: 'en' });
    expect(seen).toEqual(['self:1:ip:en', 'od:2:ip:zh', 'od:3:ip:zh', 'od:4:ip:en', 'od:5:ip:en']);
    expect(() => chooseParseSubmitter({} as any)).toThrow(/OpenDota submitter/);
  });
});

describe('matchDetailCache.put', () => {
  it('a self-parsed copy replaces the unparsed one and is served without another fetch', async () => {
    let fetches = 0;
    const cache: any = createMatchDetailCache({ fetchMatch: async () => { fetches += 1; return gc(); } });
    expect(isMatchParsed(await cache.get(ID))).toBe(false);
    expect(cache.put(ID, merge())).toBe(true);
    const got = await cache.get(ID);
    expect(isMatchParsed(got)).toBe(true);
    expect(fetches).toBe(1);
  });

  it('never replaces a parsed entry with an unparsed one, and ignores junk', async () => {
    const cache: any = createMatchDetailCache({ fetchMatch: async () => merge() });
    await cache.get(ID);
    expect(cache.put(ID, gc())).toBe(false);
    expect(isMatchParsed(await cache.get(ID))).toBe(true);
    expect(cache.put(ID, null)).toBe(false);
    expect(cache.put(ID, 'x')).toBe(false);
  });
});
