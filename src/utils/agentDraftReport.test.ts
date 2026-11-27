import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { linkHeroNames } from '../../packages/review-engine/src/trace/index.js';
import { DRAFT_TOOL, draftReport } from '../../lib/agent/draftReport.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { heroMatchup } from '../../lib/agent/referenceTools.js';

/** The draft as it was played (#437 P3): lanes from the replay and how each pairing usually goes, on 9100904020. */
const fixture = (name: string) => JSON.parse(gunzipSync(readFileSync(new URL(`../../packages/review-engine/test/fixtures/${name}`, import.meta.url))).toString());
const trace = linkHeroNames(fixture('trace-9100904020.json.gz'));
// Public medals for the match (Legend): the bracket is the match's median, as hero_matchup reads it.
const match = { players: trace.heroes.map(() => ({ hero_id: null, rank_tier: 55 })) };
const seat = (key: string) => trace.heroes.findIndex((h: any) => h.key === key);

describe('draft_report', () => {
  const r: any = draftReport(trace, { hero: 'beastmaster' }, { match });

  it('which heroes went to which lane, the solo lanes, and the player\'s lane marked', () => {
    expect(r.lanes.map((l: any) => [l.lane, l.my_team, l.enemy, l.solo])).toEqual([
      ['bot', ['beastmaster', 'undying'], ['phantom_assassin', 'venomancer'], { my_team: false, enemy: false }],
      ['mid', ['skywrath_mage'], ['necrolyte'], { my_team: true, enemy: true }],
      ['top', ['sven', 'dark_willow'], ['axe', 'mirana'], { my_team: false, enemy: false }],
    ]);
    expect(r.lanes.filter((l: any) => l.my_lane).map((l: any) => l.lane)).toEqual(['bot']);
    expect(r.in_no_single_lane).toEqual([]);
  });

  it('every pairing in a lane, read in the match\'s bracket — the numbers hero_matchup gives', () => {
    expect(r.bracket_basis).toBe('the median public medal of the match');
    // The pairings of the bottom lane, each the same numbers hero_matchup gives for that pair in that bracket (the
    // readings themselves move with each data refresh).
    expect(r.lanes[0].pairings.map((p: any) => [p.hero, p.against])).toEqual([
      ['beastmaster', 'phantom_assassin'], ['beastmaster', 'venomancer'], ['undying', 'phantom_assassin'], ['undying', 'venomancer'],
    ]);
    for (const p of r.lanes.flatMap((l: any) => l.pairings)) {
      const m: any = heroMatchup(trace, { hero: p.hero, against: p.against }, { match, perspective: 'beastmaster' });
      expect([p.hero, p.against, p.lane_when_they_met, p.game]).toEqual([p.hero, p.against, m.by_bracket[0].lane_when_they_met, m.by_bracket[0].win]);
    }
    expect(r.lanes[0].pairings.some((p: any) => p.lane_when_they_met || p.game)).toBe(true);
    expect(r.lanes[1].pairings[0]).toMatchObject({ hero: 'skywrath_mage', against: 'necrolyte', bracket: 'Legend–Ancient' });
    expect(r.gaps).toEqual([]);
  });

  it('the bracket not known: each bracket\'s reading, none picked, and a gap', () => {
    const u: any = draftReport(trace, { hero: 'beastmaster' }, {});
    expect(u.lanes[0].pairings[0].by_bracket.map((b: any) => b.bracket)).toEqual(['Herald–Guardian', 'Crusader–Archon', 'Legend–Ancient', 'Divine–Immortal']);
    expect(u.gaps).toContainEqual({ topic: 'bracket', reason: 'not_known' });
  });

  it('a support splitting two lanes is listed under each with its share, and counted when saying whether a lane was solo', () => {
    // Put Dark Willow (top) where Beastmaster stood every third second: no single lane, a large share in the bottom one.
    const i = seat('dark_willow'); const st = trace.states[i]; const b = trace.states[seat('beastmaster')];
    const mix = (arr: any[], from: any[]) => arr.map((v: any, k: number) => (k + trace.t0 >= 60 && k + trace.t0 < 600 && k % 3 === 0 && b.x[k] != null && b.y[k] != null ? from[k] : v));
    const t = { ...trace, states: trace.states.map((s: any, j: number) => (j === i ? { ...st, x: mix(st.x, b.x), y: mix(st.y, b.y) } : s)) };
    const d: any = draftReport(t, { hero: 'beastmaster' }, { match });
    expect(d.in_no_single_lane.map((x: any) => x.hero)).toEqual(['dark_willow']);
    const bot = d.lanes.find((l: any) => l.lane === 'bot');
    expect(bot.shared_part_time_by.map((x: any) => x.hero)).toEqual(['dark_willow']);
    expect(bot.pairings.filter((p: any) => p.part_time).map((p: any) => p.hero)).toEqual(['dark_willow', 'dark_willow']);
    // Sven alone in top, with Dark Willow sharing it part-time: not solo.
    const top = d.lanes.find((l: any) => l.lane === 'top');
    expect([top.my_team, top.solo.my_team]).toEqual([['sven'], false]);
  });

  it('a hero with no lane-stage positions: their lane is not known — never placed, and gaps names them', () => {
    const i = seat('necrolyte'); const st = trace.states[i];
    const cut = (arr: any[]) => arr.map((v: any, k: number) => (k + trace.t0 < 700 ? null : v));
    const t = { ...trace, states: trace.states.map((s: any, j: number) => (j === i ? { ...st, x: cut(st.x), y: cut(st.y), alive: cut(st.alive) } : s)) };
    const d: any = draftReport(t, { hero: 'beastmaster' }, { match });
    expect(d.lane_not_known).toEqual(['necrolyte']);
    expect(d.lanes.find((l: any) => l.lane === 'mid').enemy).toEqual([]);
    expect(d.gaps).toContainEqual({ topic: 'lanes', reason: 'a_hero_s_lane_stage_positions_not_in_trace', heroes: ['necrolyte'] });
  });

  it('is a review tool, and its ref opens the same record under a line', () => {
    expect(DRAFT_TOOL.name).toBe('draft_report');
    expect(r.ref).toBe('draft:beastmaster');
    expect(resolveRef(trace, 'draft:beastmaster', { hero: 'beastmaster', match })?.record.lanes).toEqual(r.lanes);
  });

  it('missing positions that could tip whether a hero shared a lane: listed as may have, solo not known for that side, and a gap', () => {
    // Dark Willow: 150 of 540 lane-stage seconds bottom, 50 unplaced, 50 mid, the rest top (28%–37% bottom).
    const i = seat('dark_willow'); const st = trace.states[i];
    const x = st.x.slice(); const y = st.y.slice(); const alive = st.alive.slice();
    let bot = 0; let missing = 0; let mid = 0;
    for (let k = 60; k < 600; k += 1) {
      alive[k] = 1;
      if (bot < 150) { x[k] = 5000; y[k] = -5500; bot += 1; } else if (missing < 50) { x[k] = null; y[k] = null; missing += 1; } else if (mid < 50) { x[k] = 0; y[k] = 0; mid += 1; } else { x[k] = -5500; y[k] = 5000; }
    }
    const t = { ...trace, states: trace.states.map((s: any, j: number) => (j === i ? { ...st, x, y, alive } : s)) };
    const d: any = draftReport(t, { hero: 'beastmaster' }, { match });
    const bot2 = d.lanes.find((l: any) => l.lane === 'bot');
    expect(bot2.shared_part_time_by).toBeUndefined();
    expect(bot2.may_have_shared_part_time).toEqual([{ hero: 'dark_willow', side: 'my_team' }]);
    // Two heroes of the player's side in the lane already: not solo whatever she did.
    expect(bot2.solo.my_team).toBe(false);
    // Sven alone in top, and Dark Willow (most of her seconds there) shared it: not solo either.
    const top = d.lanes.find((l: any) => l.lane === 'top');
    expect(top.solo.my_team).toBe(false);
    expect(d.gaps).toContainEqual({ topic: 'part_time_sharing', reason: 'missing_positions_could_tip_it', heroes: ['dark_willow'] });
  });
});

