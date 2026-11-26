#!/usr/bin/env node
/**
 * Fit the win-probability model (packages/review-engine/src/value/winProb.js) on games collected by
 * scripts/wp-collect.mjs, and say how it does on games it did not see. No network, no model call.
 *
 *   node scripts/wp-train.mjs --data <dir with games.jsonl> [--out packages/review-engine/src/value/wp.v1.json] [--folds 5]
 *
 * One row per game minute from 1:00 to the last whole minute: the state then (gold-earned lead, barracks lost)
 * and who won. Only ranked All Pick games are fitted on, whatever else the data file holds. Games with a leaver
 * are left out: an abandon moves the gold lead for a reason the model is not given.
 *
 * How it does is measured on games it did not see: the games are cut in parts by id (a game is whole in one
 * part — never minutes of one game on both sides), and each part is scored by a fit on the others. Printed,
 * and written into the model file: the Brier score and log loss of the model, of the gold lead alone, of the
 * gold lead with the minute, and of saying 50% always; said against seen by tenth; the Brier by stretch of the
 * game and by rank group. The weights written are fitted on every game. Nothing is written, and the script
 * exits 1, when the model does not beat the gold lead alone.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FEATURES, WIN_PROB_SCHEMA, buildingsAt, featuresOf } from '../packages/review-engine/src/value/winProb.js';

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** The rows of one collected game: [features, radiant won (1/0), minute]. */
export function rowsOf(game) {
  const out = [];
  const last = Math.min(game.gold.length - 1, Math.floor(game.dur / 60));
  for (let m = 1; m <= last; m += 1) {
    const x = featuresOf({ minute: m, gold: game.gold[m], ...buildingsAt(game.b, m * 60) });
    if (x) out.push([x, game.win ? 1 : 0, m]);
  }
  return out;
}

/**
 * Logistic regression by Newton's method with a small ridge (the bias is not shrunk).
 * @param {[number[], number][]} rows  @param {number[]} [use] indexes of the features fitted; the others stay 0
 */
export function fit(rows, use = null, { ridge = 1e-3, steps = 30 } = {}) {
  const n = rows[0][0].length; const idx = use ?? Array.from({ length: n }, (_, i) => i); const k = idx.length;
  let w = new Array(k).fill(0);
  for (let step = 0; step < steps; step += 1) {
    const g = new Array(k).fill(0); const H = Array.from({ length: k }, () => new Array(k).fill(0));
    for (const [x, y] of rows) {
      let z = 0; for (let a = 0; a < k; a += 1) z += w[a] * x[idx[a]];
      const p = sigmoid(z); const d = p - y; const s = Math.max(1e-9, p * (1 - p));
      for (let a = 0; a < k; a += 1) { g[a] += d * x[idx[a]]; for (let b = a; b < k; b += 1) H[a][b] += s * x[idx[a]] * x[idx[b]]; }
    }
    for (let a = 0; a < k; a += 1) { if (idx[a] !== 0) { g[a] += ridge * w[a]; H[a][a] += ridge; } for (let b = 0; b < a; b += 1) H[a][b] = H[b][a]; }
    const dw = solve(H, g);
    w = w.map((v, a) => v - dw[a]);
    if (Math.max(...dw.map(Math.abs)) < 1e-8) break;
  }
  const full = new Array(n).fill(0); idx.forEach((i, a) => { full[i] = w[a]; });
  return full;
}

/** Gaussian elimination with partial pivoting: A x = b. */
function solve(A, b) {
  const n = b.length; const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c += 1) {
    let p = c; for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r += 1) { const f = M[r][c] / d; if (f) for (let q = c; q <= n; q += 1) M[r][q] -= f * M[c][q]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r -= 1) { let s = M[r][n]; for (let q = r + 1; q < n; q += 1) s -= M[r][q] * x[q]; x[r] = s / (M[r][r] || 1e-12); }
  return x;
}

const predict = (w, x) => sigmoid(x.reduce((z, v, i) => z + v * w[i], 0));
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

/** Brier score, log loss and the predicted-against-observed table of a weight vector over rows. */
export function score(w, rows) {
  let brier = 0; let ll = 0; const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  for (const [x, y] of rows) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, predict(w, x)));
    brier += (p - y) ** 2; ll -= y * Math.log(p) + (1 - y) * Math.log(1 - p);
    const b = bins[Math.min(9, Math.floor(p * 10))]; b.n += 1; b.p += p; b.y += y;
  }
  return { rows: rows.length, brier: round(brier / rows.length), log_loss: round(ll / rows.length), calibration: bins.map((b, i) => ({ said: `${i * 10}–${i * 10 + 10}%`, rows: b.n, mean_said: b.n ? round(b.p / b.n, 3) : null, radiant_won: b.n ? round(b.y / b.n, 3) : null })) };
}

/** Which of `folds` parts a game is in, by its id alone. */
export const foldOf = (id, folds) => Math.floor((((Number(id) * 2654435761) % 4294967296) / 4294967296) * folds);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (name, d = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] != null ? args[i + 1] : d; };
  const data = flag('--data'); const out = flag('--out'); const folds = Number(flag('--folds', '5'));
  if (!data || !Number.isInteger(folds) || folds < 2 || folds > 20) { console.error('usage: node scripts/wp-train.mjs --data <dir> [--out <model.json>] [--folds 5]'); process.exit(2); }
  const all = readFileSync(join(data, 'games.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const games = [...new Map(all.map((g) => [g.id, g])).values()];
  // The cohort the model file names, whatever the data file holds: ranked lobby, Ranked All Pick.
  const cohort = games.filter((g) => g.lobby === 7 && g.mode === 22);
  // A game whose building rows do not reach an Ancient's fall has unknown buildings: not fitted on.
  const whole = cohort.filter((g) => Array.isArray(g.b) && g.b.some((b) => /_fort$/.test(b[1])));
  const clean = whole.filter((g) => !g.leaver);
  if (clean.length < 200) { console.error(`too few games: ${clean.length}`); process.exit(3); }
  // Every row with its game and the part its game is in: [features, won, minute, game, fold].
  const rows = clean.flatMap((g) => rowsOf(g).map((r) => [...r, g, foldOf(g.id, folds)]));
  const GOLD = [0, 1]; const TIMED = [0, 1, 2];
  // Each game is scored by a model fitted without it (and without the rest of its part).
  const scored = { model: [], gold: [], timed: [] };
  for (let k = 0; k < folds; k += 1) {
    const train = rows.filter((r) => r[4] !== k); const test = rows.filter((r) => r[4] === k);
    const w = { model: fit(train), gold: fit(train, GOLD), timed: fit(train, TIMED) };
    for (const name of Object.keys(scored)) for (const r of test) scored[name].push([r[0], r[1], r[2], r[3], w[name]]);
  }
  /** Brier, log loss and calibration of out-of-fold predictions (each row carries the weights that never saw its game). */
  const outOfFold = (list) => {
    let brier = 0; let ll = 0; const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
    for (const [x, y, , , w] of list) { const p = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(x.reduce((z, v, i) => z + v * w[i], 0)))); brier += (p - y) ** 2; ll -= y * Math.log(p) + (1 - y) * Math.log(1 - p); const b = bins[Math.min(9, Math.floor(p * 10))]; b.n += 1; b.p += p; b.y += y; }
    return { rows: list.length, brier: list.length ? round(brier / list.length) : null, log_loss: list.length ? round(ll / list.length) : null, calibration: bins.map((b, i) => ({ said: `${i * 10}–${i * 10 + 10}%`, rows: b.n, mean_said: b.n ? round(b.p / b.n, 3) : null, radiant_won: b.n ? round(b.y / b.n, 3) : null })) };
  };
  const m = outOfFold(scored.model); const g = outOfFold(scored.gold); const gt = outOfFold(scored.timed);
  /**
   * Calibration in each stretch of the game, folded onto the favoured side: of the rows where the model gave one
   * side between 60% and 70% (and so on), how often that side won. A model can be right overall and wrong early.
   */
  const favoured = (lo, hi) => {
    const rowsIn = scored.model.filter((x) => x[2] >= lo && x[2] <= hi);
    return { minutes: lo === hi ? `${lo}` : `${lo}–${hi === 999 ? '' : hi}`, bands: [0.5, 0.6, 0.7, 0.8, 0.9].map((a) => {
      const inBand = rowsIn.map(([x, y, , , w]) => [sigmoid(x.reduce((z, v, i) => z + v * w[i], 0)), y]).filter(([p]) => { const c = Math.max(p, 1 - p); return c >= a && c < a + 0.1; });
      if (!inBand.length) return { said: `${a * 100}–${a * 100 + 10}%`, rows: 0, mean_said: null, favoured_won: null };
      return { said: `${a * 100}–${a * 100 + 10}%`, rows: inBand.length, mean_said: round(inBand.reduce((t, [p]) => t + Math.max(p, 1 - p), 0) / inBand.length, 3), favoured_won: round(inBand.filter(([p, y]) => (p >= 0.5) === (y === 1)).length / inBand.length, 3) };
    }) };
  };
  const stretch = (lo, hi) => { const pick = (l) => l.filter((x) => x[2] >= lo && x[2] < hi); const r = pick(scored.model); return r.length ? { minutes: `${lo}–${hi}`, rows: r.length, brier: outOfFold(r).brier, gold_lead_alone: outOfFold(pick(scored.gold)).brier } : null; };
  const group = (name, lo, hi) => { const r = scored.model.filter((x) => x[3].rank != null && x[3].rank >= lo && x[3].rank < hi); return r.length ? { rank: name, games: new Set(r.map((x) => x[3].id)).size, rows: r.length, brier: outOfFold(r).brier } : null; };
  const w = fit(rows);
  const ids = clean.map((x) => x.id).sort((a, b) => a - b);
  const ranked = clean.filter((x) => x.rank != null);
  const model = {
    schema: WIN_PROB_SCHEMA, features: FEATURES, weights: w.map((v) => round(v, 6)),
    trained: new Date().toISOString().slice(0, 10),
    data: {
      source: 'OpenDota: public ranked All Pick matches it has parsed (scripts/wp-collect.mjs)',
      gold: 'gold earned lead (radiant_gold_adv) at each whole minute — the quantity goldLead gives as match_record and replay_gold_log; never the replay net worth graph',
      games_collected: games.length, left_out_not_ranked_all_pick: games.length - cohort.length, left_out_without_the_buildings: cohort.length - whole.length, left_out_with_a_leaver: whole.length - clean.length,
      games_fitted_on: clean.length, rows_fitted_on: rows.length,
      radiant_won_share: round(clean.filter((x) => x.win).length / clean.length, 3),
      match_ids: [ids[0], ids.at(-1)], opendota_patch_ids: [...new Set(clean.map((x) => x.patch))].sort(),
      rank_tier_mean: ranked.length ? round(ranked.reduce((a, x) => a + x.rank, 0) / ranked.length, 1) : null,
      games_by_rank: { under_40: ranked.filter((x) => x.rank < 40).length, from_40_to_59: ranked.filter((x) => x.rank >= 40 && x.rank < 60).length, from_60: ranked.filter((x) => x.rank >= 60).length, not_known: clean.length - ranked.length },
    },
    cross_validated: {
      how: `${folds} parts by game id; each game scored by a fit that did not see it. The weights above are fitted on all of them.`,
      model: { brier: m.brier, log_loss: m.log_loss },
      gold_lead_alone: { brier: g.brier, log_loss: g.log_loss },
      gold_lead_with_the_minute: { brier: gt.brier, log_loss: gt.log_loss },
      always_half: { brier: 0.25, log_loss: round(Math.log(2)) },
      calibration: m.calibration,
      calibration_by_stretch: [[1, 1], [2, 3], [4, 5], [6, 10], [11, 20], [21, 999]].map(([a, b]) => favoured(a, b)),
      by_stretch: [[1, 10], [10, 20], [20, 30], [30, 40], [40, 200]].map(([a, b]) => stretch(a, b)).filter(Boolean),
      by_rank: [group('Herald–Crusader (rank_tier under 40)', 0, 40), group('Archon–Legend (40–59)', 40, 60), group('Ancient and above (60+)', 60, 100)].filter(Boolean),
    },
    not_in_it: ['heroes and items', 'who is dead at the moment', 'buybacks', 'Aegis', 'experience', 'towers (measured: nothing once the gold lead is in)'],
  };
  console.log(`games ${games.length} (${games.length - cohort.length} not ranked All Pick, ${cohort.length - whole.length} without their buildings and ${whole.length - clean.length} with a leaver left out); ${clean.length} games / ${rows.length} rows, ${folds} parts`);
  console.log(`weights: ${FEATURES.map((f, i) => `${f} ${model.weights[i]}`).join(', ')}`);
  console.log(`out of fold — Brier: model ${m.brier}, gold lead with the minute ${gt.brier}, gold lead alone ${g.brier}, always 50% 0.25; log loss: ${m.log_loss} / ${gt.log_loss} / ${g.log_loss} / ${round(Math.log(2))}`);
  console.log('said → Radiant won (rows):  ' + m.calibration.filter((c) => c.rows).map((c) => `${c.mean_said}→${c.radiant_won} (${c.rows})`).join('  '));
  console.log('by stretch: ' + model.cross_validated.by_stretch.map((s) => `${s.minutes} min: ${s.brier} (gold alone ${s.gold_lead_alone}, ${s.rows} rows)`).join(' | '));
  console.log('by rank: ' + model.cross_validated.by_rank.map((s) => `${s.rank}: ${s.brier} (${s.games} games)`).join(' | '));
  if (!(m.brier < g.brier)) { console.error('the model does not beat the gold lead alone: nothing written'); process.exit(1); }
  if (out) { writeFileSync(out, `${JSON.stringify(model, null, 2)}\n`); console.log(`written ${out}`); }
}
