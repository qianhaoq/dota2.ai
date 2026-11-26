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
 * - Denies at 10:00: the deny rows before 10:00 — not known when a lane creep kill of the hero's has no sides in the
 *   log (kind 'u'), which may have been a deny.
 * - The lane's result: the same rule as the record's (lane gold summed per side: within 8% even, 25% won big or
 *   lost badly) — on the gold the log says each hero earned before 10:00 (positive sums only: a death's loss and
 *   selling are not earning). The income every hero
 *   gets over time is not in the log; it is about the same for every hero (324 at 10:00, spread within a game 87
 *   to 279), so it is left out of both sides alike.
 *
 * Calibrated on the 17 corpus games with a parsed match record (scripts/calibrate-lane.mjs), 2026-11-26:
 * - lane: 169 of 170 heroes in the record's lane; the other is a hero the record marks as roaming. With
 *   LANE_SHARE 0.6: 165 decided, all 165 in the record's lane;
 * - last hits at 10:00 from the running count: the record's exactly for 93%, within 2 for 98% (summon heroes
 *   lowest: Venomancer 15 against 20); at 5:00 93% / 100%. Denies at 10:00: 88% exact, 97% within 2;
 * - the lane's result for 159 heroes: the record's exactly for 147 (141 before death losses were left out), the
 *   same direction (won / even / lost) for 147, the opposite for 4 — all four in lanes where the record leaves out a hero it marks as roaming and the
 *   positions put in.
 */
import { traceClock } from '../../packages/review-engine/src/trace/index.js';

export const LANE_FROM = 60;
export const LANE_END = 600;
export const LANE_SHARE = 0.6;
/** A hero's lane is read only when the trace has their state for this share of the lane-stage seconds; less is not known. */
export const LANE_COVERAGE = 0.9;
/** The record's thresholds (lib/coach/chapters.js), on the same quantity summed per side. */
const DRAW = 0.08; const STOMP = 0.25;
/** The log's gold reason for selling an item: money moved, not money earned. */
const SOLD = 6;
/** The record's own lane words (lib/coach/chapters.js): one vocabulary for the model. */
const LANE_NAME = { 1: 'bot', 2: 'mid', 3: 'top' };

const third = (x, y) => { const d = y - x; return Math.abs(d) < 2200 ? 2 : d > 0 ? 3 : 1; };
const inBase = (x, y) => (x > 4200 && y > 3800) || (x < -4600 && y < -4200);

/**
 * The lane (1 bottom, 2 mid, 3 top) a hero spent LANE_SHARE of their living lane-stage seconds in; null when they
 * were in no single lane (a roamer, a jungler); undefined when the trace does not say where they were for enough of
 * those seconds (LANE_COVERAGE) — not known, which is not "in no lane".
 */
export function laneOf(trace, h) {
  const st = trace.states?.[h]; if (!st) return undefined;
  const c = { 1: 0, 2: 0, 3: 0 }; let n = 0; let seen = 0;
  for (let s = LANE_FROM; s < LANE_END; s += 1) {
    const k = s - trace.t0;
    // A second the trace speaks for: dead (no place needed), or alive with a position.
    const dead = st.alive?.[k] === 0; const placed = st.alive?.[k] === 1 && st.x?.[k] != null && st.y?.[k] != null;
    if (dead || placed) seen += 1;
    if (!placed || inBase(st.x[k], st.y[k])) continue;
    c[third(st.x[k], st.y[k])] += 1; n += 1;
  }
  if (seen < LANE_COVERAGE * (LANE_END - LANE_FROM)) return undefined;
  if (!n) return null;
  const [lane, count] = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return count / n >= LANE_SHARE ? Number(lane) : null;
}

/**
 * @param {any} trace  hero names linked
 * @param {number} h  the player's seat
 * @returns {{ unknown: string } | object}  unknown: 'no_creep_kills_in_trace' | 'no_gold_rows_in_trace' | 'positions_not_known' | 'no_single_lane' | 'no_enemy_in_the_lane'
 */
export function laneFromReplay(trace, h) {
  if (!Array.isArray(trace.creep_kills)) return { unknown: 'no_creep_kills_in_trace' };
  if (!Array.isArray(trace.gold)) return { unknown: 'no_gold_rows_in_trace' };
  const lanes = trace.heroes.map((_, i) => laneOf(trace, i));
  const lane = lanes[h];
  if (lane === undefined) return { unknown: 'positions_not_known' };
  if (lane === null) return { unknown: 'no_single_lane' };
  // Heroes whose lane is not known may have been in this one: then who was in it, and so its result, is not known.
  const notKnown = trace.heroes.map((x, i) => i).filter((i) => lanes[i] === undefined);
  const team = trace.heroes[h].team;
  const inLane = trace.heroes.map((x, i) => i).filter((i) => lanes[i] === lane);
  if (!inLane.some((i) => trace.heroes[i].team !== team)) return { unknown: 'no_enemy_in_the_lane' };
  const nameIx = (i) => trace.names.indexOf(trace.heroes[i].npc);
  // The running count on the hero's last kill row before `at`. No row: none yet (0). Rows without the count (an
  // extract that did not give it): not known (null) — never 0.
  const lastHits = (i, at) => {
    const nx = nameIx(i); let v = 0; let rows = 0; let counted = false;
    for (const r of trace.creep_kills) if (r[1] === nx && r[0] < at) { rows += 1; if (Number.isInteger(r[3])) { v = r[3]; counted = true; } }
    return rows && !counted ? null : v;
  };
  // A lane creep whose sides the log did not give ('u') may have been a deny: with any, the count is not known.
  const denies = (i, at) => { const nx = nameIx(i); const rows = trace.creep_kills.filter((r) => r[1] === nx && r[0] < at); return rows.some((r) => r[2] === 'u') ? null : rows.filter((r) => r[2] === 'd').length; };
  // Earned: positive sums only — a death's loss is a negative row, and selling moves money without earning it
  // (the same as tools.js's earned lead).
  const earned = (i) => { const nx = nameIx(i); return trace.gold.filter((g) => g[1] === nx && g[0] < LANE_END / 60 && g[2] !== SOLD && g[3] > 0).reduce((s, g) => s + g[3], 0); };
  const by = (f) => Object.fromEntries(inLane.map((i) => [trace.heroes[i].key, f(i)]));
  const us = inLane.filter((i) => trace.heroes[i].team === team).reduce((s, i) => s + earned(i), 0);
  const them = inLane.filter((i) => trace.heroes[i].team !== team).reduce((s, i) => s + earned(i), 0);
  const diff = (us - them) / Math.max(us, them, 1);
  const result = diff >= STOMP ? 'won big' : diff >= DRAW ? 'won' : diff <= -STOMP ? 'lost badly' : diff <= -DRAW ? 'lost' : 'even';
  const lh5 = by((i) => lastHits(i, 300)); const lh10 = by((i) => lastHits(i, LANE_END));
  const countsMissing = Object.values(lh10).some((v) => v === null) || Object.values(lh5).some((v) => v === null);
  const dn10 = by((i) => denies(i, LANE_END)); const deniesMissing = Object.values(dn10).some((v) => v === null);
  return {
    lane: LANE_NAME[lane],
    measured_at: [traceClock(300), traceClock(LANE_END)],
    heroes_in_lane: by((i) => (i === h ? 'me' : trace.heroes[i].team === team ? 'ally' : 'enemy')),
    last_hits_at_5_00: lh5, last_hits_at_10_00: lh10, denies_at_10_00: dn10,
    // With a hero whose lane is not known, who was in this lane is not known either: no sums, no result.
    lane_gold_earned_before_10_00: notKnown.length ? null : { my_team: us, enemy: them },
    lane_result: notKnown.length ? null : result,
    ...(notKnown.length ? { heroes_whose_lane_is_not_known: notKnown.map((i) => trace.heroes[i].key) } : {}),
    gaps: [
      ...(notKnown.length ? [{ topic: 'lane_result', reason: 'a_hero_s_lane_stage_positions_not_in_trace' }] : []),
      ...(countsMissing ? [{ topic: 'last_hits', reason: 'running_count_not_in_trace' }] : []),
      ...(deniesMissing ? [{ topic: 'denies', reason: 'lane_creep_kills_without_their_sides' }] : []),
    ],
  };
}

export const LANE_FROM_REPLAY_RULE = `read from the replay (no parsed match record): lane = the third of the map a hero spent ${LANE_SHARE * 100}% or more of their living seconds in between 1:00 and 10:00; last hits = the combat log's running count (at least: a summon's kill shows only at the hero's next own last hit); result = lane gold the log says was earned before 10:00, summed per side (the income every hero gets over time is not in it): within 8% even, 8% or more won or lost, 25% or more won big or lost badly`;
