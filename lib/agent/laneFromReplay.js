/**
 * The laning stage read from the replay alone, for a game the match record cannot speak for (OpenDota did not
 * parse it, or there is no record). lane_report uses the record when it has the lane; this is what it falls back on.
 *
 * - Which lane: the third of the map (top / mid / bottom, along the diagonal from base to base) a hero spent the
 *   most of their living seconds in between 1:00 and 10:00, outside their own base — when that is LANE_SHARE of
 *   them or more; otherwise the hero is in no single lane (a roamer, a jungler).
 * - Last hits at 5:00 and 10:00: the running count the combat log gives on the hero's last kill row before then.
 *   A kill made by the hero's summons has no row of its own and shows in the count only at the hero's next own
 *   last hit: the number is "at least", and only ever short.
 * - Denies at 10:00: the deny rows before 10:00.
 * - The lane's result: the same rule as the record's (lane gold summed per side: within 8% even, 25% won big or
 *   lost badly) — on the gold the log says each hero earned before 10:00 (selling left out). The income every hero
 *   gets over time is not in the log; it is about the same for every hero (324 at 10:00, spread within a game 87
 *   to 279), so it is left out of both sides alike.
 *
 * Calibrated on the 17 corpus games with a parsed match record (scripts/calibrate-lane.mjs), 2026-11-26:
 * - lane: 169 of 170 heroes in the record's lane; the other is a hero the record marks as roaming. With
 *   LANE_SHARE 0.6: 165 decided, all 165 in the record's lane;
 * - last hits at 10:00 from the running count: the record's exactly for 93%, within 2 for 98% (summon heroes
 *   lowest: Venomancer 15 against 20); at 5:00 93% / 100%. Denies at 10:00: 88% exact, 97% within 2;
 * - the lane's result for 159 heroes: the record's exactly for 141, the same direction (won / even / lost) for
 *   147, the opposite for 4 — all four in lanes where the record leaves out a hero it marks as roaming and the
 *   positions put in.
 */
import { traceClock } from '../../packages/review-engine/src/trace/index.js';

export const LANE_FROM = 60;
export const LANE_END = 600;
export const LANE_SHARE = 0.6;
/** The record's thresholds (lib/coach/chapters.js), on the same quantity summed per side. */
const DRAW = 0.08; const STOMP = 0.25;
/** The log's gold reason for selling an item: money moved, not money earned. */
const SOLD = 6;
/** The record's own lane words (lib/coach/chapters.js): one vocabulary for the model. */
const LANE_NAME = { 1: 'bot', 2: 'mid', 3: 'top' };

const third = (x, y) => { const d = y - x; return Math.abs(d) < 2200 ? 2 : d > 0 ? 3 : 1; };
const inBase = (x, y) => (x > 4200 && y > 3800) || (x < -4600 && y < -4200);

/** The lane (1 bottom, 2 mid, 3 top) a hero spent LANE_SHARE of their living lane-stage seconds in, or null. */
export function laneOf(trace, h) {
  const st = trace.states?.[h]; if (!st) return null;
  const c = { 1: 0, 2: 0, 3: 0 }; let n = 0;
  for (let s = LANE_FROM; s < LANE_END; s += 1) {
    const k = s - trace.t0;
    if (st.x[k] == null || st.y[k] == null || st.alive[k] !== 1 || inBase(st.x[k], st.y[k])) continue;
    c[third(st.x[k], st.y[k])] += 1; n += 1;
  }
  if (!n) return null;
  const [lane, count] = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return count / n >= LANE_SHARE ? Number(lane) : null;
}

/**
 * @param {any} trace  hero names linked
 * @param {number} h  the player's seat
 * @returns {{ unknown: string } | object}  unknown: 'no_creep_kills_in_trace' | 'no_gold_rows_in_trace' | 'no_single_lane' | 'no_enemy_in_the_lane'
 */
export function laneFromReplay(trace, h) {
  if (!Array.isArray(trace.creep_kills)) return { unknown: 'no_creep_kills_in_trace' };
  if (!Array.isArray(trace.gold)) return { unknown: 'no_gold_rows_in_trace' };
  const lanes = trace.heroes.map((_, i) => laneOf(trace, i));
  const lane = lanes[h];
  if (lane == null) return { unknown: 'no_single_lane' };
  const team = trace.heroes[h].team;
  const inLane = trace.heroes.map((x, i) => i).filter((i) => lanes[i] === lane);
  if (!inLane.some((i) => trace.heroes[i].team !== team)) return { unknown: 'no_enemy_in_the_lane' };
  const nameIx = (i) => trace.names.indexOf(trace.heroes[i].npc);
  const lastHits = (i, at) => { const nx = nameIx(i); let v = 0; for (const r of trace.creep_kills) if (r[1] === nx && r[0] < at && Number.isInteger(r[3])) v = r[3]; return v; };
  const denies = (i, at) => { const nx = nameIx(i); return trace.creep_kills.filter((r) => r[1] === nx && r[0] < at && r[2] === 'd').length; };
  const earned = (i) => { const nx = nameIx(i); return trace.gold.filter((g) => g[1] === nx && g[0] < LANE_END / 60 && g[2] !== SOLD).reduce((s, g) => s + g[3], 0); };
  const by = (f) => Object.fromEntries(inLane.map((i) => [trace.heroes[i].key, f(i)]));
  const us = inLane.filter((i) => trace.heroes[i].team === team).reduce((s, i) => s + earned(i), 0);
  const them = inLane.filter((i) => trace.heroes[i].team !== team).reduce((s, i) => s + earned(i), 0);
  const diff = (us - them) / Math.max(us, them, 1);
  const result = diff >= STOMP ? 'won big' : diff >= DRAW ? 'won' : diff <= -STOMP ? 'lost badly' : diff <= -DRAW ? 'lost' : 'even';
  return {
    lane: LANE_NAME[lane],
    measured_at: [traceClock(300), traceClock(LANE_END)],
    heroes_in_lane: by((i) => (i === h ? 'me' : trace.heroes[i].team === team ? 'ally' : 'enemy')),
    last_hits_at_5_00: by((i) => lastHits(i, 300)), last_hits_at_10_00: by((i) => lastHits(i, LANE_END)), denies_at_10_00: by((i) => denies(i, LANE_END)),
    lane_gold_earned_before_10_00: { my_team: us, enemy: them },
    lane_result: result,
  };
}

export const LANE_FROM_REPLAY_RULE = `read from the replay (no parsed match record): lane = the third of the map a hero spent ${LANE_SHARE * 100}% or more of their living seconds in between 1:00 and 10:00; last hits = the combat log's running count (at least: a summon's kill shows only at the hero's next own last hit); result = lane gold the log says was earned before 10:00, summed per side (the income every hero gets over time is not in it): within 8% even, 8% or more won or lost, 25% or more won big or lost badly`;
