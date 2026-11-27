/**
 * Gold by where it came from, summed from the replay's gold log (`trace.gold`: [game minute, hero name index, the
 * log's reason code, gold], build.js). One reading for lane_report's how_the_lane_went and farm_report's stretches.
 *
 * - Income by source: lane creeps, neutrals, hero kills and assists, buildings, Roshan and the Tormentor (one code
 *   for both), bounty runes, and the rest (wards, couriers, codes the log does not name).
 * - lost_on_dying: what dying cost (a negative sum). Some replays' logs have no dying rows at all (15 of 209 parsed
 *   games with gold rows, 2026-11-27, deaths or not): then it is null — not known, never 0.
 * - Left out: selling (money moved, not earned) and the starting purse (reason 0 before the horn, minute < 0).
 * - The income every hero gets over time has no rows: it is in no source.
 */

const SOURCE = { 13: 'lane_creeps', 14: 'neutrals', 12: 'hero_kills_and_assists', 11: 'buildings', 15: 'roshan_and_tormentor', 17: 'bounty_runes' };
const SOLD = 6; const DYING = 1;
export const GOLD_SOURCES = ['lane_creeps', 'neutrals', 'hero_kills_and_assists', 'buildings', 'roshan_and_tormentor', 'bounty_runes', 'other'];

/**
 * @param {any} trace
 * @param {number[]} heroes  name indexes (trace.names) of the heroes summed
 * @param {number} from  first game minute counted (inclusive)
 * @param {number} to  minute the sum ends before (exclusive)
 * @returns {Record<string, number>|null}  each source, lost_on_dying and earned (the sources added); null without gold rows
 */
export function goldBySource(trace, heroes, from, to) {
  if (!Array.isArray(trace.gold)) return null;
  const s = Object.fromEntries([...GOLD_SOURCES, 'lost_on_dying'].map((k) => [k, 0]));
  if (!logsDying(trace)) s.lost_on_dying = null;
  for (const g of trace.gold) {
    if (g[0] < from || g[0] >= to || !heroes.includes(g[1]) || g[2] === SOLD || (g[2] === 0 && g[0] < 0)) continue;
    if (g[2] === DYING) { if (s.lost_on_dying != null) s.lost_on_dying += g[3]; continue; }
    if (g[3] > 0) s[SOURCE[g[2]] ?? 'other'] += g[3];
  }
  s.earned = GOLD_SOURCES.reduce((a, k) => a + s[k], 0);
  return s;
}

/** a − b for every key of two goldBySource sums; null where either is not known. */
export function goldDifference(a, b) {
  return Object.fromEntries(Object.keys(a).map((k) => [k, a[k] == null || b[k] == null ? null : a[k] - b[k]]));
}

const dyingLogged = new WeakMap();
/** Whether the trace's gold log has dying rows at all: without any, what dying cost is not known. */
function logsDying(trace) {
  if (!dyingLogged.has(trace)) dyingLogged.set(trace, trace.gold.some((g) => g[2] === DYING));
  return dyingLogged.get(trace);
}
