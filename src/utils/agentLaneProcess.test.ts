import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { linkHeroNames } from '../../packages/review-engine/src/trace/index.js';
import { VISIT_AFTER, VISIT_GAP, laneProcess } from '../../lib/agent/laneProcess.js';
import { laneReport } from '../../lib/agent/knowledgeTools.js';

/**
 * How the lane went (#437 P1): where the lane's gold gap came from and who came into the lane, on 9100904020
 * (Beastmaster and Undying against Phantom Assassin and Venomancer in the bottom lane).
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
const seat = (key: string) => trace.heroes.findIndex((h: any) => h.key === key);
const bm = seat('beastmaster');

describe('how the lane went, read from the replay', () => {
  const r: any = laneProcess(trace, bm);

  it('the gap split by source: behind on lane creeps, ahead on kills — the starting purse in neither', () => {
    expect(r.lane).toBe('bot');
    const d = r.gold_gap_by_source.my_team_minus_enemy;
    expect(d).toEqual({ lane_creeps: -907, neutrals: 169, hero_kills_and_assists: 537, bounty_runes: 0, other: -365, lost_on_dying: 60, earned: -566 });
    // The parts add up to what each side earned; dying is a loss, not earning.
    for (const side of ['my_team', 'enemy']) {
      const s = r.gold_gap_by_source[side];
      expect(s.lane_creeps + s.neutrals + s.hero_kills_and_assists + s.bounty_runes + s.other).toBe(s.earned);
      expect(s.lost_on_dying).toBeLessThanOrEqual(0);
    }
    // Running every two minutes, ending on the 10:00 gap.
    expect(r.by_two_minutes.map((x: any) => x.at)).toEqual(['2:00', '4:00', '6:00', '8:00', '10:00']);
    expect(r.by_two_minutes[4].my_team_minus_enemy).toBe(d.earned);
    expect(r.by_two_minutes[1].my_team_minus_enemy).toBe(-1446);
  });

  it('visits: heroes from outside the lane who exchanged damage in it, and who died during them', () => {
    expect([VISIT_GAP, VISIT_AFTER]).toEqual([30, 10]);
    expect(r.visits.map((v: any) => [v.hero, v.side, v.their_lane, v.from])).toEqual([
      ['necrolyte', 'enemy', 'mid', '7:55'], ['dark_willow', 'my_team', 'top', '8:18'], ['mirana', 'enemy', 'top', '8:27'], ['dark_willow', 'my_team', 'top', '9:47'],
    ]);
    // Beastmaster's death at 8:27 falls in two visits (Dark Willow's and Mirana's): one death in each side's count.
    expect(r.enemy_visits).toEqual({ visits: 2, heroes: ['necrolyte', 'mirana'], my_team_deaths_in_them: 2, enemy_deaths_in_them: 1 });
    expect(r.my_team_visits).toEqual({ visits: 2, heroes: ['dark_willow'], my_team_deaths_in_them: 1, enemy_deaths_in_them: 1 });
    // No lane hero is ever a visitor of their own lane.
    for (const v of r.visits) expect(Object.keys(r.heroes_in_lane)).not.toContain(v.hero);
  });

  it('where the player spent the lane stage adds up to its seconds', () => {
    const s = r.my_lane_seconds;
    expect(s.in_lane + s.elsewhere + s.in_base + s.dead + s.not_known).toBe(540);
    expect(s).toMatchObject({ from: '1:00', to: '10:00', not_known: 0 });
  });

  it('lane_report carries it under how_the_lane_went, with its rule and the corpus reference', () => {
    const l: any = laneReport(trace, { hero: 'beastmaster' }, {});
    expect(l.how_the_lane_went.gold_gap_by_source.my_team_minus_enemy.earned).toBe(-566);
    expect(l.how_the_lane_went.rule).toMatch(/visits/);
    expect(l.how_the_lane_went.reference).toMatch(/209 parsed games/);
  });
});

describe('unknown stays unknown', () => {
  it('a trace without gold rows: no gold split (null, said in gaps) — never zeros; the visits are still read', () => {
    const { gold: _g, ...t } = trace as any;
    const r: any = laneProcess(t, bm);
    expect([r.gold_gap_by_source, r.by_two_minutes]).toEqual([null, null]);
    expect(r.gaps).toContainEqual({ topic: 'gold_gap_by_source', reason: 'no_gold_rows_in_trace' });
    expect(r.enemy_visits.visits).toBe(2);
  });

  it('a hero whose lane-stage positions are missing: who was in the lane is not known — no split, no visits', () => {
    const i = seat('venomancer'); const st = trace.states[i];
    const cut = (arr: any[]) => arr.map((v: any, k: number) => (k + trace.t0 < 700 ? null : v));
    const t = { ...trace, states: trace.states.map((s: any, j: number) => (j === i ? { ...st, x: cut(st.x), y: cut(st.y), alive: cut(st.alive) } : s)) };
    const r: any = laneProcess(t, bm);
    expect([r.gold_gap_by_source, r.visits, r.enemy_visits]).toEqual([null, null, null]);
    expect(r.heroes_whose_lane_is_not_known).toEqual(['venomancer']);
    expect(r.gaps).toContainEqual({ topic: 'visits', reason: 'a_hero_s_lane_stage_positions_not_in_trace' });
  });

  it('the player\'s own positions missing: not known, and lane_report says so instead of an empty lane', () => {
    const st = trace.states[bm];
    const cut = (arr: any[]) => arr.map(() => null);
    const t = { ...trace, states: trace.states.map((s: any, j: number) => (j === bm ? { ...st, x: cut(st.x), y: cut(st.y), alive: cut(st.alive) } : s)) };
    expect(laneProcess(t, bm)).toEqual({ unknown: 'positions_not_known' });
    expect(laneReport(t, { hero: 'beastmaster' }, {})).toMatchObject({ how_the_lane_went: null, how_the_lane_went_not_known: 'positions_not_known' });
  });
});
