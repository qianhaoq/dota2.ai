import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildValveReplayUrl, createSteamGcClient as create, mapGcHistory, mapGcMatch } from '../../lib/upstream/steamGc.js';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { buildSurface, validateSurface } from '../../lib/coach/cards.js';
import { shapeRecent } from '../../lib/coach/recent.js';
import { buildReview, validateReview } from '../../packages/review-engine/src/index.js';

const createSteamGcClient = (o: any): any => create(o);
const load = (f: string) => JSON.parse(readFileSync(new URL(`../fixtures/coach/${f}`, import.meta.url), 'utf8'));
const od = load('match9091400302.unparsed.json');

/**
 * The same game as Valve's GC sends it (CMsgDOTAMatch via protobufjs): team +
 * team_slot instead of player_slot, empty item slots -1, XP_per_min, uint64 as
 * a string, the outcome as an enum name, camelCase on some fields.
 */
const toGc = (m: any) => ({
  match_id: String(m.match_id),
  duration: m.duration,
  startTime: m.start_time,
  cluster: m.cluster,
  replay_salt: m.replay_salt,
  game_mode: m.game_mode,
  lobby_type: m.lobby_type,
  match_outcome: m.radiant_win ? 'k_EMatchOutcome_RadVictory' : 'k_EMatchOutcome_DireVictory',
  radiant_team_score: m.radiant_score,
  dire_team_score: m.dire_score,
  players: [...m.players].reverse().map((p: any, i: number) => ({
    account_id: i === 0 ? 4294967295 : 100000 + p.player_slot,
    team_number: p.player_slot < 128 ? 'DOTA_GC_TEAM_GOOD_GUYS' : 'DOTA_GC_TEAM_BAD_GUYS',
    team_slot: p.player_slot % 128,
    hero_id: p.hero_id,
    kills: p.kills, deaths: p.deaths, assists: p.assists,
    lastHits: p.last_hits, denies: p.denies,
    gold_per_min: p.gold_per_min, XP_per_min: p.xp_per_min,
    net_worth: p.net_worth, level: p.level,
    hero_damage: p.hero_damage, tower_damage: p.tower_damage, hero_healing: p.hero_healing,
    ...Object.fromEntries([0, 1, 2, 3, 4, 5].map((k) => [`item_${k}`, p[`item_${k}`] || -1])),
    item_6: p.backpack_0 || -1, item_7: p.backpack_1 || -1, item_8: p.backpack_2 || -1,
    item_9: p.item_neutral || -1,
  })),
});

describe('mapGcMatch: Valve GC scoreboard → OpenDota shape', () => {
  const m = mapGcMatch(toGc(od), '2026-11-22T00:00:00.000Z') as any;

  it('slots from team + team_slot, in OpenDota order, whatever order GC sends', () => {
    expect(m.players.map((p: any) => p.player_slot)).toEqual(od.players.map((p: any) => p.player_slot));
    expect(m.players.map((p: any) => p.hero_id)).toEqual(od.players.map((p: any) => p.hero_id));
    expect(m.players.map((p: any) => p.isRadiant)).toEqual(od.players.map((p: any) => p.isRadiant));
  });

  it('empty GC item slots (-1) become 0, never an item id', () => {
    for (const [i, p] of m.players.entries()) {
      const o = od.players[i];
      for (const k of ['item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5', 'backpack_0', 'backpack_1', 'backpack_2', 'item_neutral']) {
        expect(p[k], `${p.hero_id} ${k}`).toBe(o[k] || 0);
        expect(p[k]).toBeGreaterThanOrEqual(0);
      }
    }
    expect(m.players.flatMap((p: any) => [p.item_0, p.item_1, p.item_2, p.item_3, p.item_4, p.item_5])).toContain(0);
  });

  it('scoreboard, winner, replay address and patch are carried over; it is marked unparsed', () => {
    expect(m.match_id).toBe(od.match_id);
    expect(m.radiant_win).toBe(od.radiant_win);
    expect([m.radiant_score, m.dire_score]).toEqual([od.radiant_score, od.dire_score]);
    expect(m.players.map((p: any) => [p.kills, p.deaths, p.assists, p.last_hits, p.xp_per_min])).toEqual(od.players.map((p: any) => [p.kills, p.deaths, p.assists, p.last_hits, p.xp_per_min]));
    expect(m.replay_url).toBe(`http://replay${od.cluster}.valve.net/570/${od.match_id}_${od.replay_salt}.dem.bz2`);
    expect(m.patch).toBe(od.patch);
    expect(m).toMatchObject({ od_data: { has_parsed: false }, data_source: 'steam_gc', gc_fetched_at: '2026-11-22T00:00:00.000Z' });
  });

  it('a hidden profile (4294967295) is no account, not a real id', () => {
    const anon = m.players.find((p: any) => p.player_slot === od.players[9].player_slot);
    expect(anon.account_id).toBeNull();
    expect(m.players.filter((p: any) => p.account_id != null)).toHaveLength(9);
  });

  it('never guesses: no winner, missing players or duplicate slots throw', () => {
    const g = toGc(od);
    expect(() => mapGcMatch({ ...g, match_outcome: 0 })).toThrow(/outcome unknown/);
    expect(() => mapGcMatch({ ...g, match_outcome: 'k_EMatchOutcome_NotScored_Leaver' })).toThrow(/outcome unknown/);
    expect(() => mapGcMatch({ ...g, players: g.players.slice(1) })).toThrow(/incomplete/);
    const dup = g.players.map((p: any, i: number) => (i === 1 ? { ...p, team_slot: g.players[0].team_slot, team_number: g.players[0].team_number } : p));
    expect(() => mapGcMatch({ ...g, players: dup })).toThrow(/slots incomplete/);
    expect(() => mapGcMatch({ ...g, players: g.players.map((p: any, i: number) => (i === 2 ? { ...p, kills: undefined } : p)) })).toThrow(/scoreboard incomplete/);
  });

  it('permanent buffs: consumed Scepter, Shard and Moon Shard become OpenDota\'s flags; no list, no flags', () => {
    const g = toGc(od) as any;
    // Buff lists of a real game (match 9100809044), where OpenDota reports a Shard for exactly these two players.
    g.players[0].permanent_buffs = [{ permanent_buff: 12, stack_count: 0, grant_time: 1846 }];
    g.players[1].permanent_buffs = [{ permanent_buff: 14, stack_count: 3, grant_time: 1238 }];
    g.players[2].permanent_buffs = [];
    g.players[3].permanent_buffs = [{ permanentBuff: 2, stackCount: 0, grantTime: 900 }, { permanent_buff: 1 }, { stack_count: 4 }];
    const out = mapGcMatch(g) as any;
    const at = (i: number) => out.players.find((p: any) => p.player_slot === (g.players[i].team_number === 'DOTA_GC_TEAM_GOOD_GUYS' ? 0 : 128) + g.players[i].team_slot);
    expect(at(0)).toMatchObject({ aghanims_shard: 1, aghanims_scepter: 0, moonshard: 0, permanent_buffs: [{ permanent_buff: 12, stack_count: 0, grant_time: 1846 }] });
    expect(at(1)).toMatchObject({ aghanims_shard: 0, aghanims_scepter: 0, moonshard: 0 });
    expect(at(2)).toMatchObject({ aghanims_shard: 0, aghanims_scepter: 0, moonshard: 0, permanent_buffs: [] });
    expect(at(3)).toMatchObject({ aghanims_shard: 0, aghanims_scepter: 1, moonshard: 1, permanent_buffs: [{ permanent_buff: 2, stack_count: 0, grant_time: 900 }, { permanent_buff: 1, stack_count: 0, grant_time: 0 }] });
    // The GC sent no list for this player: unknown, not "has none".
    for (const k of ['aghanims_shard', 'aghanims_scepter', 'moonshard', 'permanent_buffs']) expect(at(4)).not.toHaveProperty(k);
    // The Shard shows among the player's items in the report.
    const report = buildCoachReport(out) as any;
    const keysOf = (i: number) => report.players[out.players.indexOf(at(i))].items.map((x: any) => x.key);
    const before = (buildCoachReport(mapGcMatch(toGc(od))) as any).players;
    expect(keysOf(0)).toContain('aghanims_shard');
    expect(keysOf(3)).toContain('ultimate_scepter');
    expect(keysOf(1)).not.toContain('aghanims_shard');
    expect(report.players.filter((p: any) => p.items.some((x: any) => x.key === 'aghanims_shard')).length)
      .toBe(before.filter((p: any) => p.items.some((x: any) => x.key === 'aghanims_shard')).length + 1);
  });

  it('the coach engine builds a full unparsed report and card surface from it, with no NaN', () => {
    const r = buildCoachReport(m) as any;
    const ref = buildCoachReport(od) as any;
    expect(r.match.parsed).toBe(false);
    expect(r.match.source).toBe('steam_gc');
    expect(r.players.map((p: any) => p.kda)).toEqual(ref.players.map((p: any) => p.kda));
    expect(r.reviews).toHaveLength(10);
    for (let s = 0; s < 10; s++) {
      expect(r.reviews[s].headline.en).toBeTruthy();
      const surface = buildSurface(r, s);
      expect(validateSurface(surface)).toEqual(surface); // nothing dropped by the card validator
    }
    expect(JSON.stringify(r)).not.toMatch(/NaN|undefined/);
  });

  it('the v1 review engine validates it and reports the missing timeline as a data gap', () => {
    const review = buildReview(m, { heroId: m.players[0].hero_id, lang: 'en', fetchedAt: m.gc_fetched_at }) as any; // as routes/v1 calls it
    expect(validateReview(review)).toEqual({ ok: true, errors: [] });
    expect(JSON.stringify(review.data_gaps ?? review)).toMatch(/pars|replay|timeline/i);
    // No benchmark percentiles were invented: GC has none.
    for (const p of m.players) expect(p.benchmarks).toBeUndefined();
  });
});

describe('buildValveReplayUrl', () => {
  it('only from three positive integers', () => {
    expect(buildValveReplayUrl({ match_id: 9091400302, cluster: 413, replay_salt: 434748305 })).toBe('http://replay413.valve.net/570/9091400302_434748305.dem.bz2');
    expect(buildValveReplayUrl({ match_id: '9091400302', cluster: '413', replay_salt: '7' })).toBe('http://replay413.valve.net/570/9091400302_7.dem.bz2');
    for (const bad of [{}, { match_id: 1, cluster: 0, replay_salt: 1 }, { match_id: 1, cluster: 1, replay_salt: -1 }, { match_id: 1, cluster: 'evil.com/', replay_salt: 1 }, { match_id: 1.5, cluster: 1, replay_salt: 1 }]) {
      expect(buildValveReplayUrl(bad as any)).toBeNull();
    }
  });
});

describe('Steam GC history → recent games', () => {
  const resp = { matches: [
    { match_id: '9100000002', start_time: 1795000000, hero_id: 67, winner: true, game_mode: 22, lobby_type: 7, duration: 2400 },
    { match_id: '9100000001', start_time: 1794990000, hero_id: 29, winner: false, game_mode: 1, lobby_type: 0, duration: 1900 },
  ] };

  it('keeps what GC says; K/D/A and seat stay unknown, never 0/0/0', () => {
    const r = shapeRecent(86745912, mapGcHistory(resp)) as any;
    expect(r.matches).toHaveLength(2);
    expect(r.matches[0]).toMatchObject({ match_id: 9100000002, won: true, ranked: true, slot: null, radiant: null, kda: null, duration: 2400, hero: { id: 67 } });
    expect(r.matches[1]).toMatchObject({ won: false, ranked: false, kda: null });
  });

  it('OpenDota rows keep their K/D/A; a row missing any of K/D/A shows none of it', () => {
    const r = shapeRecent(1, [
      { match_id: 1, player_slot: 130, radiant_win: true, hero_id: 1, kills: 0, deaths: 3, assists: 9 },
      { match_id: 2, player_slot: 2, radiant_win: true, hero_id: 1, kills: 4 },
    ]) as any;
    expect(r.matches[0]).toMatchObject({ slot: 7, radiant: false, won: false, kda: [0, 3, 9] });
    expect(r.matches[1]).toMatchObject({ slot: 2, won: true, kda: null });
  });
});

describe('createSteamGcClient', () => {
  const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ ok: status < 300, status, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, json: async () => body });
  const mk = (respond: (url: string, init: any) => any) => {
    const seen: { url: string; init: any }[] = [];
    const logs: string[] = [];
    const c = createSteamGcClient({ baseUrl: 'http://10.0.0.5:5700/', secret: 's3cr3t-token', fetchImpl: async (url: string, init: any) => { seen.push({ url, init }); return respond(url, init); }, log: (m: string) => logs.push(m) });
    return { c, seen, logs };
  };

  it('refuses to start without a URL or a secret', () => {
    expect(() => create({ baseUrl: '', secret: 'x' } as any)).toThrow(/URL/);
    expect(() => create({ baseUrl: 'file:///etc/passwd', secret: 'x' } as any)).toThrow(/http/);
    expect(() => create({ baseUrl: 'http://x', secret: '' } as any)).toThrow(/SECRET/);
  });

  it('sends the bearer secret, maps the match, and never logs the secret', async () => {
    const { c, seen, logs } = mk((url) => (url.includes('/match/') ? res(200, { match: toGc(od) }) : res(500, {})));
    const m = await c.fetchMatch(od.match_id);
    expect(seen[0].url).toBe(`http://10.0.0.5:5700/match/${od.match_id}`);
    expect(seen[0].init.headers.authorization).toBe('Bearer s3cr3t-token');
    expect(m.data_source).toBe('steam_gc');
    await expect(c.fetchRecent(86745912)).rejects.toMatchObject({ status: 500, retryable: true });
    expect(logs.join('\n')).not.toContain('s3cr3t');
    expect(logs.join('\n')).not.toContain('86745912'); // ids are not logged either
    expect(JSON.stringify(c.snapshot())).not.toContain('s3cr3t');
  });

  it('keeps the retriever status: 404 not found, 451 blocked (not retryable), 429 quota with Retry-After', async () => {
    for (const [st, retryable] of [[404, false], [451, false], [429, true], [503, true]] as const) {
      const { c } = mk(() => res(st, { code: 'x' }, { 'retry-after': '3600' }));
      await expect(c.fetchMatch(1)).rejects.toMatchObject({ status: st, retryable, upstream: 'steam_gc' });
    }
    const { c } = mk(() => res(429, {}, { 'retry-after': '3600' }));
    await expect(c.fetchMatch(1)).rejects.toMatchObject({ retryAfterSec: 3600 });
  });

  it('a different match in the answer is an error, not that match', async () => {
    const { c } = mk(() => res(200, toGc(od)));
    await expect(c.fetchMatch(123)).rejects.toThrow(/another match/);
  });

  it('a caller abort is passed through and not counted as a retriever error', async () => {
    const ac = new AbortController();
    const { c } = mk((_u, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))));
    const p = c.fetchMatch(1, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toBeTruthy();
    expect(c.snapshot().errors).toBe(0);
  });

  it('history asks for a bounded page and maps it', async () => {
    const { c, seen } = mk(() => res(200, { matches: [{ match_id: 5, hero_id: 1, winner: true }] }));
    expect(await c.fetchRecent(7, { limit: 500 })).toEqual([expect.objectContaining({ match_id: 5, player_won: true })]);
    expect(seen[0].url).toBe('http://10.0.0.5:5700/history/7?limit=50');
  });
});
