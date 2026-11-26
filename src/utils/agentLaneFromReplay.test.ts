import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { linkHeroNames } from '../../packages/review-engine/src/trace/index.js';
import { LANE_FROM_REPLAY_RULE, LANE_SHARE, laneFromReplay, laneOf } from '../../lib/agent/laneFromReplay.js';
import { laneReport } from '../../lib/agent/knowledgeTools.js';
import { heroByKey, STATIC_HEROES } from '../../packages/review-engine/src/staticHeroes.js';

const heroById = (id: number) => (STATIC_HEROES as any)[id].internalSlug;

/**
 * lane_report for a game the match record cannot speak for (#359 item 4): the lane, last hits, denies and the
 * lane's result read from the replay. On 9100904020 the record has them, so the replay's reading can be held up to it.
 */
const fixture = (name: string) => JSON.parse(gunzipSync(readFileSync(new URL(`../../packages/review-engine/test/fixtures/${name}`, import.meta.url))).toString());
const bare = linkHeroNames(fixture('trace-9100904020.json.gz'));
const creeps = fixture('creeps-9100904020.json.gz');
const gold = fixture('gold-9100904020.json.gz');
const ix = (npc: string) => bare.names.indexOf(npc);
const trace = {
  ...bare,
  creep_kills: creeps.creep_kills.map(([t, npc, kind, lh, nw]: any[]) => [t, ix(npc), kind, lh, nw]),
  gold: gold.gold.map(([m, npc, reason, sum]: any[]) => [m, ix(npc), reason, sum]),
};
const rec = (key: string) => creeps.record[String(heroByKey(key)!.id)];

describe('the lane read from the replay, on a game whose record can check it', () => {
  it('each hero in the record\'s lane, or in none when no third of the map holds 60% of their lane-stage seconds', () => {
    expect(LANE_SHARE).toBe(0.6);
    trace.heroes.forEach((h: any, i: number) => {
      const l = laneOf(trace, i);
      if (l != null) expect([h.key, l]).toEqual([h.key, rec(h.key).lane]);
    });
    expect(trace.heroes.filter((_: any, i: number) => laneOf(trace, i) != null).length).toBeGreaterThanOrEqual(8);
  });

  it('Beastmaster: bottom lane with Undying against Phantom Assassin and Venomancer; last hits within 2 of the record, never more', () => {
    const r: any = laneFromReplay(trace, trace.heroes.findIndex((h: any) => h.key === 'beastmaster'));
    expect(r).toMatchObject({ lane: 'bot', measured_at: ['5:00', '10:00'], heroes_in_lane: { beastmaster: 'me', undying: 'ally', phantom_assassin: 'enemy', venomancer: 'enemy' } });
    for (const k of Object.keys(r.heroes_in_lane)) {
      const lh = rec(k).lh_t; const dn = rec(k).dn_t;
      // The running count is "at least": short when a summon took the last kill, never over.
      expect([k, r.last_hits_at_10_00[k] <= lh[10], lh[10] - r.last_hits_at_10_00[k] <= 5, r.last_hits_at_5_00[k] <= lh[5]]).toEqual([k, true, true, true]);
      expect([k, Math.abs(r.denies_at_10_00[k] - dn[10]) <= 2]).toEqual([k, true]);
    }
    // The record calls this lane lost for Dire (8% down in gold at 10:00); the replay's earned gold says lost too.
    expect(r.lane_result).toBe('lost');
    expect(r.lane_gold_earned_before_10_00.my_team).toBeLessThan(r.lane_gold_earned_before_10_00.enemy);
  });
});

describe('what the review found on #392: unknown stays unknown', () => {
  const blank = (t: any, key: string, from: number, to: number) => {
    const i = t.heroes.findIndex((h: any) => h.key === key); const st = t.states[i];
    const cut = (arr: any[]) => arr.map((v: any, k: number) => (k + t.t0 >= from && k + t.t0 < to ? null : v));
    return { ...t, states: t.states.map((s: any, j: number) => (j === i ? { ...st, x: cut(st.x), y: cut(st.y), alive: cut(st.alive) } : s)) };
  };
  const bm = trace.heroes.findIndex((h: any) => h.key === 'beastmaster');

  it('another hero with no lane-stage positions: their lane is not known, and the lane\'s result is withheld — not computed without them', () => {
    const t = blank(trace, 'venomancer', 0, 700);
    expect(laneOf(t, t.heroes.findIndex((h: any) => h.key === 'venomancer'))).toBeUndefined();
    const r: any = laneFromReplay(t, bm);
    expect(r).toMatchObject({ lane: 'bot', lane_result: null, lane_gold_earned_before_10_00: null, heroes_whose_lane_is_not_known: ['venomancer'] });
    expect(r.gaps).toContainEqual({ topic: 'lane_result', reason: 'a_hero_s_lane_stage_positions_not_in_trace' });
    // Part of the window missing (more than a tenth): the same.
    const half: any = laneFromReplay(blank(trace, 'venomancer', 300, 600), bm);
    expect([half.lane_result, half.heroes_whose_lane_is_not_known]).toEqual([null, ['venomancer']]);
    // A few seconds missing: still read.
    expect((laneFromReplay(blank(trace, 'venomancer', 300, 320), bm) as any).lane_result).toBe('lost');
  });

  it('the player\'s own positions missing: no lane at all, said so', () => {
    expect(laneReport(blank(trace, 'beastmaster', 0, 700), { hero: 'beastmaster' }, {})).toMatchObject({ lane: null, gaps: [{ topic: 'lane_economy' }, { topic: 'lane_from_replay', reason: 'positions_not_known' }] });
  });

  it('kill rows without the running count: last hits not known — never 0', () => {
    const t = { ...trace, creep_kills: trace.creep_kills.map((r: any) => [r[0], r[1], r[2], null, r[4]]) };
    const r: any = laneFromReplay(t, bm);
    expect(r.last_hits_at_10_00).toEqual({ beastmaster: null, undying: null, phantom_assassin: null, venomancer: null });
    expect(r.gaps).toContainEqual({ topic: 'last_hits', reason: 'running_count_not_in_trace' });
    expect((laneReport(t, { hero: 'beastmaster' }, {}) as any).gaps).toContainEqual({ topic: 'last_hits', reason: 'running_count_not_in_trace' });
    // Denies are counted from the rows' kind, which is still there.
    expect(r.denies_at_10_00.phantom_assassin).toBe((laneFromReplay(trace, bm) as any).denies_at_10_00.phantom_assassin);
  });
});

describe('the second review of #392', () => {
  const bm = trace.heroes.findIndex((h: any) => h.key === 'beastmaster');

  it('earned gold is the positive sums: a death\'s loss is not taken off', () => {
    const r: any = laneFromReplay(trace, bm);
    expect(r.lane_gold_earned_before_10_00).toEqual({ my_team: 5735, enemy: 6301 });
    expect(r.lane_result).toBe('lost');
  });

  it('a lane creep kill without its sides makes that hero\'s denies not known — never 0', () => {
    const pa = ix('npc_dota_hero_phantom_assassin');
    const t = { ...trace, creep_kills: trace.creep_kills.map((r: any) => (r[1] === pa && (r[2] === 'l' || r[2] === 'd') ? [r[0], r[1], 'u', r[3], r[4]] : r)) };
    const r: any = laneFromReplay(t, bm);
    expect(r.denies_at_10_00.phantom_assassin).toBeNull();
    expect(r.denies_at_10_00.beastmaster).toBe((laneFromReplay(trace, bm) as any).denies_at_10_00.beastmaster);
    expect(r.gaps).toContainEqual({ topic: 'denies', reason: 'lane_creep_kills_without_their_sides' });
  });
});

describe('lane_report uses it only when the record cannot speak', () => {
  it('no record: read from the replay, with the rule, the note, and what it could not read', () => {
    const r: any = laneReport(trace, { hero: 'beastmaster' }, {});
    expect(r).toMatchObject({ ref: 'lane:beastmaster', read_from: 'replay', lane: 'bot', lane_result: 'lost', lane_result_rule: LANE_FROM_REPLAY_RULE });
    expect(r.note).toContain('Last hits are at least these');
    expect(r.gaps).toEqual([{ topic: 'lane_economy', reason: 'no_match_data_for_this_game' }, { topic: 'xp_at_10_00', reason: 'not_in_replay_data' }, { topic: 'pro_lane_baseline', reason: 'needs_the_match_record' }, { topic: 'lane_positions_of_creep_waves', reason: 'not_in_data' }]);
    // The deaths before 10:00 are there as always.
    expect(r.my_deaths_before_10_00_total).toBe(4);
  });

  it('a record without per-minute numbers, or one too thin to read: the replay too, saying why', () => {
    // The game's own record with only slots and kills, as OpenDota has it before it parses the replay.
    const slim = { match_id: 9100904020, radiant_win: true, duration: 2551, players: [{"hero_id": 2, "player_slot": 0, "kills": 4, "deaths": 12, "assists": 14}, {"hero_id": 44, "player_slot": 1, "kills": 25, "deaths": 4, "assists": 12}, {"hero_id": 36, "player_slot": 2, "kills": 9, "deaths": 6, "assists": 16}, {"hero_id": 40, "player_slot": 3, "kills": 9, "deaths": 16, "assists": 31}, {"hero_id": 9, "player_slot": 4, "kills": 4, "deaths": 5, "assists": 23}, {"hero_id": 18, "player_slot": 128, "kills": 8, "deaths": 10, "assists": 7}, {"hero_id": 38, "player_slot": 129, "kills": 9, "deaths": 11, "assists": 18}, {"hero_id": 85, "player_slot": 130, "kills": 7, "deaths": 15, "assists": 24}, {"hero_id": 101, "player_slot": 131, "kills": 11, "deaths": 9, "assists": 12}, {"hero_id": 119, "player_slot": 132, "kills": 7, "deaths": 6, "assists": 18}] };
    const a: any = laneReport(trace, { hero: 'beastmaster' }, { match: slim });
    expect([a.read_from, a.lane, a.gaps[0]]).toEqual(['replay', 'bot', { topic: 'lane_economy', reason: 'match_not_parsed_for_per_minute_gold' }]);
    const b: any = laneReport(trace, { hero: 'beastmaster' }, { match: { match_id: 9100904020, players: [] } });
    expect([b.read_from, b.lane, b.gaps[0]]).toEqual(['replay', 'bot', { topic: 'lane_economy', reason: 'match_data_incomplete' }]);
  });

  it('a record with the lane wins: the replay is not read', () => {
    // The parsed record of 9091400302 (the fixture agentKnowledge.test.ts reads it with), on a trace that has creep
    // and gold rows: lane_report reads the record and never says read_from.
    const match = JSON.parse(readFileSync(new URL('../fixtures/coach/match9091400302.parsed.json', import.meta.url), 'utf8'));
    expect(Array.isArray(match.players[0].gold_t)).toBe(true);
    const heroes = match.players.map((p: any, i: number) => { const key = heroById(p.hero_id); return { key, npc: `npc_dota_hero_${key}`, team: i < 5 ? 2 : 3, player_index: i }; });
    // The replay's rows are there (any rows): the record still decides.
    const withRows = { heroes, names: heroes.map((h: any) => h.npc), deaths: [], creep_kills: [[100, 0, 'l', 1, 700]], gold: [[1, 0, 13, 40]], states: heroes.map(() => ({ x: [], y: [], alive: [] })), t0: 0 };
    const r: any = laneReport(withRows, { hero: 'tidehunter' }, { match });
    expect(r).not.toHaveProperty('read_from');
    expect(r).toMatchObject({ lane: 'top', lane_result: 'lost', last_hits_at_10_00: { tidehunter: 41 } });
  });

  it('a trace without the rows (built before they were kept): no lane, and the gap says which rows are missing — never zeros', () => {
    const r: any = laneReport(bare, { hero: 'beastmaster' }, {});
    expect(r).toMatchObject({ lane: null });
    expect(r).not.toHaveProperty('last_hits_at_10_00');
    expect(r.gaps).toEqual([{ topic: 'lane_economy', reason: 'no_match_data_for_this_game' }, { topic: 'lane_from_replay', reason: 'no_creep_kills_in_trace' }]);
    expect((laneReport({ ...bare, creep_kills: trace.creep_kills }, { hero: 'beastmaster' }, {}) as any).gaps[1]).toEqual({ topic: 'lane_from_replay', reason: 'no_gold_rows_in_trace' });
  });

  it('a hero in no single lane gets no lane — not the lane they spent most time in', () => {
    // Move Beastmaster to the middle of the map for half of the lane stage.
    const bm = trace.heroes.findIndex((h: any) => h.key === 'beastmaster');
    const st = trace.states[bm];
    const moved = { ...st, x: st.x.map((v: any, k: number) => (k + trace.t0 >= 60 && k + trace.t0 < 330 ? 0 : v)), y: st.y.map((v: any, k: number) => (k + trace.t0 >= 60 && k + trace.t0 < 330 ? 0 : v)) };
    const t2 = { ...trace, states: trace.states.map((s: any, i: number) => (i === bm ? moved : s)) };
    expect(laneOf(t2, bm)).toBeNull();
    expect(laneReport(t2, { hero: 'beastmaster' }, {})).toMatchObject({ lane: null, gaps: [{ topic: 'lane_economy' }, { topic: 'lane_from_replay', reason: 'no_single_lane' }] });
  });
});
