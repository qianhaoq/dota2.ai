/**
 * The win-probability model with its fitted weights (wp.v1.json): what a caller uses.
 *   radiantWinProbabilityAt(trace, t, ctx)          → { radiant, minute, gold, towers, barracks, gold_source } | { unknown }
 *     gold_source: 'match_record' | 'replay_gold_log' — which gold-earned lead was read (goldLead's source)
 *   radiantWinProbabilitySwing(trace, from, to, ctx) → { from, to, radiant_change } | { unknown }
 * `ctx` is the tools' ctx ({ match } when the caller has the match record). See winProb.js for what the number
 * is and is not, and fromTrace.js for when there is none.
 */
import model from './wp.v1.json' with { type: 'json' };
import { winProbabilityAt, winProbabilitySwing } from './fromTrace.js';

export const WIN_PROB_MODEL = model;
export const radiantWinProbabilityAt = (trace, t, ctx = {}) => winProbabilityAt(model, trace, t, ctx);
export const radiantWinProbabilitySwing = (trace, from, to, ctx = {}) => winProbabilitySwing(model, trace, from, to, ctx);
export { FEATURES, WIN_PROB_SCHEMA, buildingsAt, featuresOf, stateAt, winProbability } from './winProb.js';
export { modelInputs, winProbabilityAt, winProbabilitySwing } from './fromTrace.js';
