/**
 * How likely Radiant is to win from a state of the game: a logistic model over three numbers every parsed
 * replay has — the minute, the gold-earned lead, and how many barracks each side has lost.
 *
 * It is a yardstick for moments, not a forecast to show a player: "this fight took the game from 55% to 30%"
 * ranks the moments of one game against each other. What it knows nothing of: the heroes, who is dead right
 * now, buybacks, Aegis, items, experience. Two games in the same state get the same number.
 *
 * What was tried and left out (five-fold cross-validation over 1,839 ranked games, scripts/wp-train.mjs):
 * tower counts and an Aegis flag changed nothing once the gold lead was in (a tower's gold is already in it);
 * the experience lead helped (Brier 0.1767 → 0.1746) but a trace has levels, not experience, and levels worked
 * out from a match record's experience were the trace's own level in only 30% of hero-minutes — not the same
 * quantity, so not used until the replay gives experience itself.
 *
 * The gold lead is gold EARNED (the match record's radiant_gold_adv, or the same summed from the replay's combat
 * log — goldLead's `match_record` and `replay_gold_log`). The replay's net worth graph is another quantity,
 * about 2,900 a minute away from it: a state built from that source is refused (null), not scored.
 *
 * Pure: the model is data (wp.v1.json, written by scripts/wp-train.mjs with what it was trained on and how it
 * did on games it had not seen).
 */

export const WIN_PROB_SCHEMA = 'dota2.ai/win-probability@1';
/** The features, in the order of the model's weights. `t` is the minute over 10; gold in thousands. */
export const FEATURES = ['bias', 'gold_k', 'gold_k_per_sqrt_t', 'barracks'];

/** Past this the model was fitted on almost nothing: the minute is held here. */
const MINUTE_CAP = 60;

/**
 * @param {{ minute: number, gold: number, barracks: number }} s
 *   gold: Radiant's gold-earned lead; barracks: Dire's lost minus Radiant's lost (positive: Radiant ahead).
 * @returns {number[] | null} null when a number is missing: no state, no probability.
 */
export function featuresOf(s) {
  if (!s || ![s.minute, s.gold, s.barracks].every(Number.isFinite)) return null;
  const t = Math.min(MINUTE_CAP, Math.max(1, s.minute)) / 10;
  const g = s.gold / 1000;
  // The same lead is worth less the later it is: divided by the root of the time fitted better than by the time itself.
  return [1, g, g / Math.sqrt(t), s.barracks];
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/**
 * @param {{ schema: string, features: string[], weights: number[] }} model
 * @returns {number | null} Radiant's chance, 0…1; null without a usable state or model.
 */
export function winProbability(model, state) {
  const x = featuresOf(state);
  if (!x || model?.schema !== WIN_PROB_SCHEMA || !Array.isArray(model.weights) || model.weights.length !== x.length || model.features?.join() !== FEATURES.join()) return null;
  return sigmoid(x.reduce((z, v, i) => z + v * model.weights[i], 0));
}

const TOWER = /_tower[1-4]/; const RAX = /_rax_/;
const ownerOf = (name) => (/goodguys/.test(name) ? 2 : /badguys/.test(name) ? 3 : 0);

/**
 * Buildings fallen up to a game second, as differences (the model reads the barracks; towers are counted for
 * whoever wants them). `falls`: [[t, building name]…].
 * The owner is read off the name, never off who took it (that side is often not recorded).
 */
export function buildingsAt(falls, t) {
  const lost = { 2: { towers: 0, barracks: 0 }, 3: { towers: 0, barracks: 0 } };
  for (const [at, name] of falls ?? []) {
    if (!(at <= t) || typeof name !== 'string') continue;
    const side = ownerOf(name); if (!side) continue;
    if (TOWER.test(name)) lost[side].towers += 1; else if (RAX.test(name)) lost[side].barracks += 1;
  }
  return { towers: lost[3].towers - lost[2].towers, barracks: lost[3].barracks - lost[2].barracks };
}

/**
 * The state at a game second, from a per-minute gold lead and the buildings fallen. The lead is read between
 * its two minute points (a straight line: what was earned inside the minute is not known more finely).
 * @param {{ lead: number[] | null, falls: [number, string][], t: number }} o
 * @returns {{ minute: number, gold: number, towers: number, barracks: number } | null}
 */
export function stateAt({ lead, falls, t }) {
  if (!Array.isArray(lead) || lead.length < 2 || !Number.isFinite(t) || t < 0) return null;
  const m = t / 60; const lo = Math.floor(m);
  if (lo >= lead.length) return null;
  const a = lead[lo]; const b = lead[Math.min(lead.length - 1, lo + 1)];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { minute: m, gold: a + (b - a) * (m - lo), ...buildingsAt(falls, t) };
}
