import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { linkHeroNames, runTraceTool } from '../../packages/review-engine/src/trace/index.js';
import { BEHIND_AFTER_LANES, LANES_END, LANES_RULE, MANY_EARLY_DEATHS, lostFromTheLanes } from '../../packages/review-engine/src/trace/lanesLost.js';
import { STILL_IN_IT } from '../../packages/review-engine/src/trace/turningFight.js';

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
/** The answer alone (undefined when it is not known). */
const lost = (l: any, o?: any) => (lostFromTheLanes(l, o) as any).lost_from_the_lanes;

describe('lostFromTheLanes', () => {
  /** The team's lead: `at10` at 10:00, then `after` minute by minute; the game ends in the last minute given. */
  const ended = (l: number[]) => ({ source: 'match_record', end: (l.length - 1) * 60 + 30 });

  it('is more than 2000 behind at 10:00 and in every minute after, to the end — the turning-fight rule\'s own line', () => {
    expect([LANES_END, BEHIND_AFTER_LANES, MANY_EARLY_DEATHS, STILL_IN_IT]).toEqual([600, -2000, 4, -2000]);
    expect(LANES_RULE).toBe('my_team more than 2000 gold behind at 10:00 and in every minute after, to the end of the game');
    // The Luna game of the corpus: 4,096 behind at 10:00, never closer than 4,309 after.
    const luna = lead(-4096, [-4309, -5437, -9000]);
    expect(lostFromTheLanes(luna, ended(luna))).toEqual({ lost_from_the_lanes: true, my_team_gold_lead_at_10: -4096, my_team_best_gold_lead_after: -4309 });
    expect(lost(luna, { ...ended(luna), source: 'replay_gold_log' })).toBe(true);
    // 2000 behind is still in it (turningFight.js): not lost from the lanes, at 10:00 or later.
    for (const l of [lead(-2000, [-9000]), lead(-2001, [-2000, -9000]), lead(-9000, [-1999])]) expect([l, lost(l, ended(l))]).toEqual([l, false]);
    expect(lost(lead(-2001, [-2001]), ended(lead(-2001, [-2001])))).toBe(true);
    // Back within 2000 without ever leading: not lost from the lanes either — a later fight may have turned it.
    const back = lead(-4096, [-3000, -745, -4298]);
    expect(lostFromTheLanes(back, ended(back))).toEqual({ lost_from_the_lanes: false, my_team_gold_lead_at_10: -4096, my_team_best_gold_lead_after: -745 });
    // What the lead did before 10:00 is not read.
    const early = [0, -3000, -4000, -5000, -3000, -2000, -1500, -900, -400, -100, -2500, -6000];
    expect(lost(early, ended(early))).toBe(true);
    // Minutes past the game's end are not read.
    expect(lost(lead(-4000, [-4000, 500]), { source: 'match_record', end: 11 * 60 + 30 })).toBe(true);
  });

  it('says "not known" — never "no" — without a gold-earned lead that covers 10:00 to the end of the game', () => {
    const l = lead(-9000, [-9000, -9000]);
    for (const x of [null, undefined, [], 'none' as any]) expect(lostFromTheLanes(x, ended(l))).toEqual({ unknown: 'no_gold_lead' });
    // The replay's net worth graph is 2,900 off on average: more than the line. A lead of no stated source is not read either.
    expect(lostFromTheLanes(l, { ...ended(l), source: 'replay_net_worth' })).toEqual({ unknown: 'gold_lead_is_not_gold_earned' });
    expect(lostFromTheLanes(l, { end: 720 })).toEqual({ unknown: 'gold_lead_is_not_gold_earned' });
    // Where the game ended is not known: whether the team came back is not either.
    for (const end of [null, undefined, 0, NaN]) expect(lostFromTheLanes(l, { source: 'match_record', end })).toEqual({ unknown: 'game_end_not_known' });
    // A game over by 10:00 has no "after the lanes".
    expect(lostFromTheLanes(lead(-9000, []), { source: 'match_record', end: 610 })).toEqual({ unknown: 'game_ended_before_the_lanes_did' });
    // A series that stops before the game ended: the minutes after it may be the ones the team came back in.
    // (Codex on #382: a 12-point record of a 42:31 game was read as lost from the lanes.)
    expect(lostFromTheLanes(lead(-9000, [-9000]), { source: 'match_record', end: 42 * 60 + 31 })).toEqual({ unknown: 'gold_lead_stops_before_the_game_ended' });
    // A minute missing between 10:00 and the end.
    for (const hole of [null, undefined, NaN]) {
      const h = lead(-4000, [-4000, hole as any, -4000]);
      expect(lostFromTheLanes(h, ended(h))).toEqual({ unknown: 'gold_lead_has_a_minute_missing' });
      const h10 = lead(hole as any, [-4000]);
      expect(lostFromTheLanes(h10, ended(h10))).toEqual({ unknown: 'gold_lead_has_a_minute_missing' });
    }
    // A hole before 10:00 does not matter: those minutes are not read.
    const before = [0, null as any, -500, -900, -1500, -2000, -2500, -2800, -3000, -3500, -4000, -4200];
    expect(lost(before, ended(before))).toBe(true);
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

  it('never says "lost from the lanes" beside a turning fight after 10:00 (Codex on #382)', () => {
    // 4,096 behind at 10:00, back to 745 behind before the 30:26 fight, 4,298 behind after it: the fight turned it.
    const comeback = overview(record(4096, 2500, [[30, 745], [31, 2500], [32, 4298]]));
    expect(comeback.turning_fight?.ref).toBe('fight:11');
    expect(comeback.lanes.lost_from_the_lanes).toBe(false);
    // Over a range of games: whenever the lanes flag is up, no fight from 10:00 on is named.
    let flagged = 0; let cleared = 0;
    for (const at10 of [2001, 3000, 6000]) for (const after of [2001, 2500, 4000, 9000]) for (const dip of [null, 1500, 2100, 2600]) for (const fall of [0, 3000, 9000]) {
      // `dip`: the lead (Radiant's) the minute before the 30:26 fight; `fall`: how much more it was two minutes after.
      const o = overview(record(at10, after, dip == null ? [] : [[30, dip], [31, dip + fall], [32, dip + fall]]));
      if (!o.lanes?.lost_from_the_lanes) { cleared += 1; continue; }
      flagged += 1;
      expect([at10, after, dip, fall, o.turning_fight?.from ?? null]).toEqual([at10, after, dip, fall, null]);
    }
    // Both kinds were seen: the check above ran.
    expect([flagged > 0, cleared > 0]).toEqual([true, true]);
  });

  it('a record that stops before the game ended says "not known", with the gap (Codex on #382)', () => {
    const short = overview({ radiant_gold_adv: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4096, 4309] });
    expect(short.lanes).toBeNull();
    expect(short.gaps).toContainEqual({ topic: 'lanes', reason: 'gold_lead_stops_before_the_game_ended' });
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
