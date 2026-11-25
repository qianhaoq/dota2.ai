/**
 * What moved between two runs of scripts/calibrate.mjs --json: the tables the prompt's numbers and
 * docs/GAME_UNDERSTANDING.md quote, re-run on a larger corpus. A rate whose change is larger than its sampling noise
 * is listed, so a weekly re-run says which quoted numbers need a second look and which held.
 *
 * Every row of the tables (an array entry, or a nested object) that has a count of cases — fights, pushes, deaths,
 * moments, towers, takes — is read as that count and its outcomes: each other whole number in the row is an outcome,
 * and its rate is over the row's count. Two more kinds of rate are read as the docs quote them:
 * - a nested object with no count of its own whose numbers split its parent's cases (roshans.aegis: used, expired,
 *   game ended of the takes) is a row over the parent's count;
 * - a pair "<side>_lost_fewer" / "<side>_lost_more" is also read as a win rate over the fights it decided
 *   (ultimate_edges: the edge side's wins of the fights with a winner), the rate the docs quote. The row is matched across runs by where it is and by its labels (its text,
 * true/false and tier fields). The change is judged by a two-proportion z score; the two corpora overlap (the new
 * one holds the old games), so the score is a guide to what to look at, not a test.
 */

/** The fields that count a row's cases, in the order a row is read. */
const CASES = ['fights', 'pushes', 'deaths', 'moments', 'towers', 'takes'];
/** Fields that name a row rather than count something in it. */
const LABELS = new Set(['tier', 'value']);
/** Below this many cases in either run a rate is too noisy to call. */
export const MIN_CASES = 20;
/** |z| from which a change is listed. */
export const SHIFT_Z = 2;

const isCount = (v) => Number.isInteger(v) && v >= 0;

/**
 * Every row with a count of cases: { at, key, cases, n, outcomes: { field: { k, n } } }. An outcome's n is the
 * count its rate is over: the row's, or the fights a lost_fewer / lost_more pair decided.
 */
export function calibrationRows(run) {
  const rows = [];
  const visit = (node, at, parent) => {
    if (Array.isArray(node)) { node.forEach((x) => visit(x, at, null)); return; }
    if (!node || typeof node !== 'object') return;
    const own = CASES.find((c) => isCount(node[c]));
    const counts = Object.entries(node).filter(([k, v]) => k !== 'rate' && !LABELS.has(k) && isCount(v));
    // No count of its own: a split of the parent's cases when its numbers add up to no more than them.
    const split = !own && parent && counts.length >= 2 && counts.reduce((a, [, v]) => a + v, 0) <= parent.n ? parent : null;
    const cases = own ?? split?.cases;
    if (cases) {
      const n = own ? node[own] : split.n;
      const labels = Object.entries(node).filter(([k, v]) => k !== 'rate' && (LABELS.has(k) || typeof v === 'string' || typeof v === 'boolean' || v === null)).map(([k, v]) => `${k}=${v}`);
      const outcomes = Object.fromEntries(counts.filter(([k, v]) => k !== own && v <= n).map(([k, v]) => [k, { k: v, n }]));
      for (const [k, fewer] of counts) {
        const side = /^(.*)_lost_fewer$/.exec(k)?.[1];
        const more = side != null ? node[`${side}_lost_more`] : undefined;
        if (isCount(more) && fewer + more > 0) outcomes[`${side}_lost_fewer_of_decided`] = { k: fewer, n: fewer + more };
      }
      rows.push({ at, key: labels.join(' '), cases, n, outcomes });
    }
    const self = own ? { cases: own, n: node[own] } : null;
    for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') visit(v, at ? `${at}.${k}` : k, self);
  };
  visit(run, '', null);
  return rows;
}

/** Two-proportion z score of k2/n2 against k1/n1; null when it cannot be computed. */
export function zScore(k1, n1, k2, n2) {
  if (!(n1 > 0 && n2 > 0)) return null;
  const p = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se > 0 ? (k2 / n2 - k1 / n1) / se : null;
}

const pct = (k, n) => (n > 0 ? Math.round((100 * k) / n) : null);

/**
 * @returns {{ games: { before: number | null, after: number | null }, shifted: { row: string, outcome: string, before: { of: number, count: number, rate: number | null }, after: { of: number, count: number, rate: number | null }, z: number }[], held: number, too_few: number, new_rows: string[], gone_rows: string[] }}
 */
export function compareCalibration(before, after, { minCases = MIN_CASES, shiftZ = SHIFT_Z } = {}) {
  const id = (r) => `${r.at} | ${r.cases}${r.key ? ` | ${r.key}` : ''}`;
  const old = new Map(calibrationRows(before).map((r) => [id(r), r]));
  const now = new Map(calibrationRows(after).map((r) => [id(r), r]));
  const shifted = []; let held = 0; let tooFew = 0;
  for (const [key, b] of now) {
    const a = old.get(key);
    if (!a) continue;
    for (const [field, x2] of Object.entries(b.outcomes)) {
      const x1 = a.outcomes[field];
      if (!x1) continue;
      if (x1.n < minCases || x2.n < minCases) { tooFew += 1; continue; }
      const z = zScore(x1.k, x1.n, x2.k, x2.n);
      if (z != null && Math.abs(z) >= shiftZ) shifted.push({ row: key, outcome: field, before: { of: x1.n, count: x1.k, rate: pct(x1.k, x1.n) }, after: { of: x2.n, count: x2.k, rate: pct(x2.k, x2.n) }, z: Math.round(z * 10) / 10 });
      else held += 1;
    }
  }
  shifted.sort((x, y) => Math.abs(y.z) - Math.abs(x.z));
  return {
    games: { before: before?.games ?? null, after: after?.games ?? null },
    shifted, held, too_few: tooFew,
    new_rows: [...now.keys()].filter((k) => !old.has(k)),
    gone_rows: [...old.keys()].filter((k) => !now.has(k)),
  };
}
