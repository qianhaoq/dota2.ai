import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStratzClient as createClient, mapStratzMatch, MATCH_QUERY } from '../../lib/upstream/stratz.js';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { isMatchParsed } from '../../lib/matchReview/matchParse.js';

const createStratzClient = (o: any): any => createClient(o);

/**
 * A STRATZ `match` built from the real 9091400302 OpenDota data, in STRATZ's
 * field names (schema: MatchType / MatchPlayerType / MatchPlayerStatsType).
 * It is a translation for the mapping test, not a recorded STRATZ response;
 * scripts/stratz-check.mjs compares against a live one once a token exists.
 */
const od = JSON.parse(readFileSync(path.join(process.cwd(), 'src/fixtures/coach/match9091400302.parsed.json'), 'utf8'));
const items = JSON.parse(readFileSync(path.join(process.cwd(), 'lib/data/constants/items.json'), 'utf8'));
const itemId = (key: string) => items[key]?.id;
const LANE: Record<number, string> = { 1: 'SAFE_LANE', 2: 'MID_LANE', 3: 'OFF_LANE', 4: 'JUNGLE' };
const stratzMatch = {
  id: od.match_id, didRadiantWin: od.radiant_win, durationSeconds: od.duration, startDateTime: od.start_time,
  gameMode: 'ALL_PICK_RANKED', lobbyType: 'RANKED', clusterId: od.cluster,
  radiantNetworthLeads: od.radiant_gold_adv, radiantExperienceLeads: od.radiant_xp_adv,
  // Per-minute team kills: only their sum is known from OpenDota, so one bucket here.
  radiantKills: [od.radiant_score], direKills: [od.dire_score],
  players: [...od.players].reverse().map((p: any) => ({
    steamAccountId: p.account_id ?? null, isRadiant: p.player_slot < 128, playerSlot: p.player_slot,
    heroId: p.hero_id, kills: p.kills, deaths: p.deaths, assists: p.assists,
    numLastHits: p.last_hits, numDenies: p.denies, goldPerMinute: p.gold_per_min, experiencePerMinute: p.xp_per_min,
    networth: p.net_worth, level: p.level, heroDamage: p.hero_damage, towerDamage: p.tower_damage, heroHealing: p.hero_healing,
    lane: p.is_roaming ? 'ROAMING' : LANE[p.lane_role],
    item0Id: p.item_0, item1Id: p.item_1, item2Id: p.item_2, item3Id: p.item_3, item4Id: p.item_4, item5Id: p.item_5,
    backpack0Id: p.backpack_0, backpack1Id: p.backpack_1, backpack2Id: p.backpack_2, neutral0Id: p.item_neutral,
    stats: { itemPurchases: (p.purchase_log ?? []).map((x: any) => ({ time: x.time, itemId: itemId(x.key) })).filter((x: any) => x.itemId) },
  })),
};

describe('STRATZ fallback mapping', () => {
  const m: any = mapStratzMatch(stratzMatch, '2026-11-21T00:00:00Z');

  it('maps the match and players into OpenDota slots and ids', () => {
    expect(m.match_id).toBe(9091400302);
    expect(m.radiant_win).toBe(false);
    expect(m.game_mode).toBe(22);
    expect(m.lobby_type).toBe(7);
    // Score = team kills, as OpenDota reports it (not the heroes' kills: 33/74 here).
    expect([m.radiant_score, m.dire_score]).toEqual([od.radiant_score, od.dire_score]);
    const heroKills = (r: boolean) => od.players.filter((p: any) => (p.player_slot < 128) === r).reduce((s: number, p: any) => s + p.kills, 0);
    const noTeam = mapStratzMatch({ ...stratzMatch, radiantKills: null, direKills: null }) as any;
    expect([noTeam.radiant_score, noTeam.dire_score]).toEqual([heroKills(true), heroKills(false)]);
    expect(m.patch).toBe(60); // started on 7.41
    // STRATZ leads are net worth: never passed off as OpenDota's earned-gold series.
    expect(m.radiant_gold_adv).toBeUndefined();
    expect(m.radiant_net_worth_adv).toEqual(stratzMatch.radiantNetworthLeads);
    expect(m.players.map((p: any) => p.player_slot)).toEqual([0, 1, 2, 3, 4, 128, 129, 130, 131, 132]);
    for (const p of m.players) {
      const o = od.players.find((x: any) => x.player_slot === p.player_slot);
      expect([p.hero_id, p.kills, p.deaths, p.assists, p.item_0, p.net_worth]).toEqual([o.hero_id, o.kills, o.deaths, o.assists, o.item_0, o.net_worth]);
    }
    // Lane roles become map lanes for each side: Tidehunter (Radiant offlane) is top.
    expect(m.players[0].lane).toBe(3);
    // Item ids become keys: Tidehunter's Blink purchase is there.
    expect(m.players[0].purchase_log.some((x: any) => x.key === 'blink')).toBe(true);
  });

  it('is never taken for a parsed OpenDota match', () => {
    expect(m.od_data).toEqual({ has_parsed: false });
    expect(m.data_source).toBe('stratz');
    expect(isMatchParsed(m)).toBe(false);
    // The engine builds a basic report from it, without parsed-only chapters.
    const r: any = buildCoachReport(m);
    expect(r.match.parsed).toBe(false);
    expect(r.match.source).toBe('stratz');
    expect(r.match.score).toEqual([od.radiant_score, od.dire_score]);
    expect(r.reviews).toHaveLength(10);
  });

  it('rejects an incomplete match', () => {
    expect(() => mapStratzMatch({ ...stratzMatch, players: stratzMatch.players.slice(0, 9) })).toThrow(/incomplete/);
  });
});

describe('STRATZ client', () => {
  it('posts the query with the bearer token and maps the answer', async () => {
    let req: any;
    const c = createStratzClient({ token: 't0k', fetchImpl: async (url: string, init: any) => { req = { url, init }; return { ok: true, status: 200, json: async () => ({ data: { match: stratzMatch } }) }; } });
    const m: any = await c.fetchMatch(9091400302);
    expect(req.url).toBe('https://api.stratz.com/graphql');
    expect(req.init.headers.authorization).toBe('Bearer t0k');
    expect(JSON.parse(req.init.body)).toEqual({ query: MATCH_QUERY, variables: { id: 9091400302 } });
    expect(m.match_id).toBe(9091400302);
    expect(c.snapshot()).toMatchObject({ calls: 1, ok: 1 });
  });

  it('a caller abort cancels the request at once and is not counted as a STRATZ error', async () => {
    const c = createStratzClient({ token: 't', fetchImpl: (_u: string, init: any) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) });
    const ac = new AbortController();
    const p = c.fetchMatch(1, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toBeTruthy();
    expect(c.snapshot().errors).toBe(0);
  });

  it('a missing match is a 404, an HTTP error keeps its status', async () => {
    const none = createStratzClient({ token: 't', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: { match: null } }) }) });
    await expect(none.fetchMatch(1)).rejects.toMatchObject({ status: 404, upstream: 'stratz' });
    const down = createStratzClient({ token: 't', fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
    await expect(down.fetchMatch(1)).rejects.toMatchObject({ status: 503, retryable: true });
  });
});

describe('server wiring', () => {
  it('falls back to STRATZ only when OpenDota fails for a reason other than a missing match or an abort', () => {
    const server = readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');
    expect(server).toMatch(/process\.env\.STRATZ_API_TOKEN\s*\?/);
    const fn = server.slice(server.indexOf('const matchDetailCache = createMatchDetailCache('));
    const body = fn.slice(0, fn.indexOf('\n});'));
    // Fallback order and its stop rules (404, caller abort) live in fetchFromSources:
    // behaviour-tested in upstreamSourceOrder.test.ts.
    expect(body).toContain('await fetchFromSources(matchSources(), {');
    expect(body).toMatch(/signal: options\.signal,\n\s+onFallback/);
    // The caller's cancellation reaches the fallback.
    expect(body).toContain("stratz: () => stratz.fetchMatch(matchId, { signal: options.signal })");
    // A STRATZ copy is returned as-is: only the OpenDota fetcher writes to the parsed-match store.
    const opendotaFetcher = body.slice(body.indexOf('opendota: async () => {'), body.indexOf('stratz: () =>'));
    expect(opendotaFetcher).toContain('matchStore?.putMatch(matchId, data)');
    expect(body.split('matchStore?.putMatch(').length).toBe(2);
    // STRATZ is only in the chain when configured.
    expect(server).toMatch(/configured: \{ opendota: true, stratz: Boolean\(stratz\) \}/);
  });
});
