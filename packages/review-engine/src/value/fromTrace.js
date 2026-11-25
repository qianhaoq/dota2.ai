/**
 * The win-probability model read on a parsed replay: Radiant's chance at a game second, and how it moved
 * across a stretch (a fight, the minutes after a tower).
 *
 * The gold lead is taken where the review's tools take it (goldLead), and only when it is gold earned — the
 * match record's, or the replay's combat log summed. A trace that has only the net worth graph gets no number:
 * the model was fitted on another quantity (see winProb.js). Buildings are read off the trace's own rows, by
 * whose they were; a trace without that list gets no number either.
 */
import { goldLead } from '../trace/tools.js';
import { stateAt, winProbability } from './winProb.js';

/** Gold-lead sources the model may be read on. */
const EARNED = new Set(['match_record', 'replay_gold_log']);

/**
 * @param {any} trace  a match trace, hero names linked
 * @param {{ match?: any }} [ctx]  the match record, when the caller has it (as the tools' ctx)
 * @returns {{ lead: number[], source: string, falls: [number, string][] } | { unknown: 'no_buildings' | 'no_gold_lead' | 'net_worth_only' }}
 */
export function modelInputs(trace, ctx = {}) {
  // A trace with no building rows at all does not know which barracks stand: that is not "none fell". An empty
  // list is: the builder writes one for a game in which nothing fell.
  if (!Array.isArray(trace?.buildings)) return { unknown: 'no_buildings' };
  const g = goldLead(trace, ctx);
  if (!g) return { unknown: 'no_gold_lead' };
  if (!EARNED.has(g.source)) return { unknown: 'net_worth_only' };
  return { lead: g.lead, source: g.source, falls: trace.buildings.map((b) => [b[0], trace.names[b[1]]]) };
}

/**
 * Radiant's chance at game second `t`.
 * @returns {{ radiant: number, minute: number, gold: number, towers: number, barracks: number, gold_source: string } | { unknown: string }}
 *   unknown: 'no_buildings' | 'no_gold_lead' | 'net_worth_only' | 'outside_the_gold_lead' (before 0:00, after its last minute, or a gap in it) | 'no_model'
 */
export function winProbabilityAt(model, trace, t, ctx = {}, inputs = modelInputs(trace, ctx)) {
  if (inputs.unknown) return { unknown: inputs.unknown };
  const state = stateAt({ lead: inputs.lead, falls: inputs.falls, t });
  if (!state) return { unknown: 'outside_the_gold_lead' };
  const p = winProbability(model, state);
  if (p == null) return { unknown: 'no_model' };
  return { radiant: p, ...state, gold_source: inputs.source };
}

/**
 * How Radiant's chance moved from second `from` to second `to` (e.g. a fight's start to two minutes after its
 * end): both ends and the difference. Positive: toward Radiant. Unknown when either end is.
 */
export function winProbabilitySwing(model, trace, from, to, ctx = {}) {
  const inputs = modelInputs(trace, ctx);
  const a = winProbabilityAt(model, trace, from, ctx, inputs); const b = winProbabilityAt(model, trace, to, ctx, inputs);
  if (a.unknown || b.unknown) return { unknown: a.unknown ?? b.unknown };
  return { from: a, to: b, radiant_change: b.radiant - a.radiant };
}
