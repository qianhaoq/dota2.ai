import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { linkHeroNames, runTraceTool } from '../../packages/review-engine/src/trace/index.js';
import { BEHIND_AFTER_LANES, LANES_END, LANES_RULE, MANY_EARLY_DEATHS, lostFromTheLanes } from '../../packages/review-engine/src/trace/lanesLost.js';

/**
 * A game lost from the lanes: far behind at 10:00 and never ahead after. It decides whether a review may lead
 * with the player's early deaths (prompt step 9): with the first version of that rule, which sent early deaths
 * to second or third place in every game of 25 minutes or more, a Luna who died five times before 10:00 in a
 * game her team was 4,096 behind at 10:00 got the lane as her first finding in 1 review of 3.
 */

/** Match 9100904020, Beastmaster on Dire (the losing side). The committed trace has no gold; a match record gives it. */
const trace = linkHeroNames(JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString()));
/** Radiant's gold lead per minute, 46 minutes: `at10` at 10:00, `after` in every minute after it, but for the ones given. */
const record = (at10: number, after: number, points: [number, number | null][] = []) => { const a: (number | null)[] = Array.from({ length: 46 }, (_, m) => (m < 10 ? 0 : m === 10 ? at10 : after)); for (const [m, v] of points) a[m] = v; return { radiant_gold_adv: a }; };
const overview = (match: any, hero = 'beastmaster') => runTraceTool(trace, 'match_overview', {}, { ...(match ? { match } : {}), perspective: hero }) as any;
const lead = (at10: number, after: number[]) => [...new Array(10).fill(0), at10, ...after];
const EARNED = { source: 'match_record' };
/** The answer alone (undefined when it is not known). */
const lost = (l: any, o?: any) => (lostFromTheLanes(l, o) as any).lost_from_the_lanes;

describe('lostFromTheLanes', () => {
  it('is a lead 2000 or more behind at 10:00 that is not ahead in any minute after', () => {
    expect([LANES_END, BEHIND_AFTER_LANES, MANY_EARLY_DEATHS]).toEqual([600, -2000, 4]);
    expect(LANES_RULE).toBe('my_team 2000 gold or more behind at 10:00, and not ahead in any minute after');
    // The Luna game of the corpus: 4,096 behind at 10:00, never closer than 4,309 after.
    expect(lostFromTheLanes(lead(-4096, [-4309, -5437, -9000]), EARNED)).toEqual({ lost_from_the_lanes: true, my_team_gold_lead_at_10: -4096, my_team_best_gold_lead_after: -4309 });
    expect(lost(lead(-4096, [-4309]), { source: 'replay_gold_log' })).toBe(true);
    // The threshold itself counts; one gold short of it does not.
    expect(lost(lead(-2000, [-1]), EARNED)).toBe(true);
    expect(lostFromTheLanes(lead(-1999, [-9000]), EARNED)).toEqual({ lost_from_the_lanes: false, my_team_gold_lead_at_10: -1999, my_team_best_gold_lead_after: -9000 });
    // Level is not ahead; one gold ahead in one later minute is.
    expect(lost(lead(-3000, [-500, 0, -4000]), EARNED)).toBe(true);
    expect(lostFromTheLanes(lead(-3000, [-500, 1, -4000]), EARNED)).toEqual({ lost_from_the_lanes: false, my_team_gold_lead_at_10: -3000, my_team_best_gold_lead_after: 1 });
    // Behind early and level at 10:00: the lanes did not lose it. What the lead did before 10:00 is not read.
    expect(lost([0, -3000, -4000, -5000, -3000, -2000, -1500, -900, -400, -100, 0, -6000], EARNED)).toBe(false);
  });

  it('says "not known" — never "no" — without a gold-earned lead that covers 10:00 and every minute after', () => {
    for (const l of [null, undefined, [], 'none' as any]) expect(lostFromTheLanes(l, EARNED)).toEqual({ unknown: 'no_gold_lead' });
    // The replay's net worth graph is 2,900 off on average: more than the threshold. A lead of no stated source is not read either.
    expect(lostFromTheLanes(lead(-9000, [-9000]), { source: 'replay_net_worth' })).toEqual({ unknown: 'gold_lead_is_not_gold_earned' });
    expect(lostFromTheLanes(lead(-9000, [-9000]))).toEqual({ unknown: 'gold_lead_is_not_gold_earned' });
    expect(lostFromTheLanes(lead(-9000, [-9000]), { source: null })).toEqual({ unknown: 'gold_lead_is_not_gold_earned' });
    // A game (or a series) over by 10:00 has no "after the lanes".
    expect(lostFromTheLanes(lead(-9000, []), EARNED)).toEqual({ unknown: 'gold_lead_stops_before_the_lanes_end' });
    expect(lostFromTheLanes([0, -500, -900], EARNED)).toEqual({ unknown: 'gold_lead_stops_before_the_lanes_end' });
    // A minute missing may be the minute they were ahead in.
    for (const hole of [null, undefined, NaN]) {
      expect(lostFromTheLanes(lead(-4000, [-4000, hole as any, -4000]), EARNED)).toEqual({ unknown: 'gold_lead_has_a_minute_missing' });
      expect(lostFromTheLanes(lead(hole as any, [-4000]), EARNED)).toEqual({ unknown: 'gold_lead_has_a_minute_missing' });
    }
    // A hole before 10:00 does not matter: those minutes are not read.
    expect(lost([0, null as any, -500, -900, -1500, -2000, -2500, -2800, -3000, -3500, -4000, -4200], EARNED)).toBe(true);
  });
});

describe('match_overview on a lost game', () => {
  it('says whether it was lost from the lanes, from the player\'s side, with the numbers and the rule', () => {
    // Beastmaster is on Dire: Radiant 4,096 ahead at 10:00 and ahead in every minute after.
    expect(overview(record(4096, 4309)).lanes).toEqual({ lost_from_the_lanes: true, my_team_gold_lead_at_10: -4096, my_team_best_gold_lead_after: -4309, rule: LANES_RULE });
    // The game as it was: Dire 482 behind at 10:00 and 3,565 ahead later.
    expect(overview(record(482, 5000, [[20, -3565]])).lanes).toEqual({ lost_from_the_lanes: false, my_team_gold_lead_at_10: -482, my_team_best_gold_lead_after: 3565, rule: LANES_RULE });
    // Far behind at 10:00, ahead once later: a game that was come back into.
    expect(overview(record(4096, 4309, [[31, -200]])).lanes.lost_from_the_lanes).toBe(false);
  });

  it('is null with a stated gap when the lead cannot say; absent for a winner and with no viewer', () => {
    // No gold lead at all: the gap that says so is the gold one.
    const none = overview(null);
    expect(none.lanes).toBeNull();
    expect(none.gaps.filter((g: any) => g.topic === 'gold_advantage' || g.topic === 'lanes')).toEqual([{ topic: 'gold_advantage', reason: 'not_in_trace' }]);
    // A record with a minute missing after 10:00.
    const holed = overview(record(4096, 4309, [[25, null]]));
    expect(holed.lanes).toBeNull();
    expect(holed.gaps).toContainEqual({ topic: 'lanes', reason: 'gold_lead_has_a_minute_missing' });
    // The side that won is not told its game was lost from the lanes — in either direction.
    const won = overview(record(4096, 4309), 'phantom_assassin');
    expect([won.result, 'lanes' in won]).toEqual(['my_team_won', false]);
    expect(won.gaps.some((g: any) => g.topic === 'lanes')).toBe(false);
    const nobody = runTraceTool(trace, 'match_overview', {}, { match: record(4096, 4309) }) as any;
    expect('lanes' in nobody).toBe(false);
  });

  it('counts each hero\'s deaths before 10:00', () => {
    const o = overview(record(482, 5000));
    const row = (hero: string) => { const h = o.heroes.find((x: any) => x.hero === hero); return [h.deaths, h.deaths_before_10]; };
    expect(row('beastmaster')).toEqual([11, 4]);
    expect(row('undying')).toEqual([15, 5]);
    expect(row('skywrath_mage')).toEqual([9, 0]);
    expect(row('mirana')).toEqual([5, 0]);
    // Every hero death of the trace before 10:00 is somebody's.
    const npcs = new Set(trace.heroes.map((h: any) => h.npc));
    expect(o.heroes.reduce((n: number, h: any) => n + h.deaths_before_10, 0)).toBe(trace.deaths.filter((d: any) => d[0] < 600 && npcs.has(trace.names[d[1]])).length);
    // A death at 10:00 exactly is not before it.
    const edge = { ...trace, deaths: [[599.9, trace.deaths[0][1], trace.deaths[0][2], 1], [600, trace.deaths[0][1], trace.deaths[0][2], 2]] };
    const victim = trace.heroes.find((h: any) => h.npc === trace.names[trace.deaths[0][1]]).key;
    expect((runTraceTool(edge, 'match_overview', {}, {}) as any).heroes.find((h: any) => h.hero === victim)).toMatchObject({ deaths: 2, deaths_before_10: 1 });
  });
});
