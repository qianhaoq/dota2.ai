/**
 * Writing reviews again to score them: the part of the eval that costs money, and the guards on it.
 *
 * scripts/eval-review.mjs scores reviews without a model. To know whether a change to the prompt or to a tool
 * made reviews better, the same games have to be reviewed again, before and after — and each review is a few
 * hundred thousand tokens on the account production bills. On 2026-11-25 a probe run drained that account and a
 * visitor's review failed twice. So a run:
 *
 * - states what it will write and what that is expected to cost before the first call;
 * - reads the account's balance first and does not start when it cannot read it (unknown is not "enough"),
 *   when the expected spend is over the budget given, or when it would leave less than the floor;
 * - reads the balance again after every review and stops when it is under the floor or the budget is spent —
 *   production spends from the same account while the run goes on;
 * - writes one review at a time: never two model conversations at once;
 * - writes only into a directory that holds no review yet: two runs in one directory would be scored as one.
 *
 * The balance is read by lib/agent/modelBalance.js, the reader the probe run uses: one place knows the endpoint.
 * This file adds what a run of reviews needs on top of its floor: a budget, and the stop between reviews.
 *
 * Pure but for what is injected: the caller gives `balance`, `generate` and `write`.
 */
import { DEFAULT_BALANCE_FLOOR, balanceVerdict } from './modelBalance.js';

/** What one deep review cost on 2026-11-25 with deepseek-flash, thinking on: 0.16 (five reviews, 0.82). Kept above it. */
export const REVIEW_COST_ESTIMATE = 0.25;
/** A run does not start, or go on, when the account would hold less than this (in the account's currency): the probe run's floor. */
export const DEFAULT_FLOOR = DEFAULT_BALANCE_FLOOR;
/** The most a run may be expected to spend unless told otherwise. */
export const DEFAULT_BUDGET = 5;

const GAME = /^([1-9]\d{0,12})\.([a-z][a-z_]{0,39})$/;
const money = (v) => (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : Number.isFinite(v) && v >= 0 ? v : null);

/**
 * @returns {{ traces: string, out: string, matches: string | null, rubrics: string, games: { match_id: number, hero: string }[] | null, runs: number, lang: 'en' | 'zh', budget: number, floor: number, dryRun: boolean } | null}
 *   null for anything it cannot read: a run that spends money is not started on a guess.
 */
export function parseRunArgs(argv) {
  const o = { traces: null, out: null, matches: null, rubrics: 'evals/reviews', games: null, runs: 1, lang: 'zh', budget: DEFAULT_BUDGET, floor: DEFAULT_FLOOR, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') { o.dryRun = true; continue; }
    if (!['--traces', '--out', '--matches', '--rubrics', '--games', '--runs', '--lang', '--budget', '--floor'].includes(a)) return null;
    const v = argv[i += 1];
    if (v == null || v.startsWith('--')) return null;
    if (a === '--games') {
      const list = v.split(',').map((g) => GAME.exec(g.trim()));
      if (!list.length || list.some((m) => !m)) return null;
      o.games = list.map((m) => ({ match_id: Number(m[1]), hero: m[2] }));
    } else if (a === '--runs') { if (!/^[1-9]\d?$/.test(v)) return null; o.runs = Number(v); }
    else if (a === '--lang') { if (v !== 'en' && v !== 'zh') return null; o.lang = v; }
    else if (a === '--budget' || a === '--floor') { const n = money(v); if (n == null) return null; o[a.slice(2)] = n; }
    else o[a.slice(2)] = v;
  }
  if (!o.traces || !o.out) return null;
  return o;
}

/**
 * Reviews already in the directory a run would write to. A run numbers its files from r1 and writes only the
 * reviews it made: with an earlier run's files left there, the scorer would read both as one experiment (the r2
 * and r3 of a three-review run beside the r1 of a later one). So a run writes only into a directory that holds none.
 * @param {string[]} names  the directory's file names (none when it does not exist yet)
 */
export const reviewsAlreadyIn = (names) => (Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && n.endsWith('.review.json')).sort();

/** The file a run's review is written to: the stored review's name, with which run it was. */
export const runFileName = ({ match_id, hero, lang, version, run }) => `${match_id}.${hero}.${lang}.p${version}.r${run}.review.json`;

/**
 * What a run will write: `runs` reviews of each game, one after another, game by game.
 * @param {{ games: { match_id: number, hero: string }[], runs: number, lang: string, version: number, hasTrace: (matchId: number) => boolean, hasMatch?: (matchId: number) => boolean }} o
 * @returns {{ jobs: { match_id: number, hero: string, lang: string, run: number, file: string, match_record: boolean }[], missing: { match_id: number, hero: string }[], estimate: number }}
 *   `missing`: games with no trace to review — said, not skipped silently.
 */
export function planRuns({ games, runs, lang, version, hasTrace, hasMatch = () => false }) {
  const jobs = []; const missing = [];
  const seen = new Set();
  for (const g of games) {
    const key = `${g.match_id}.${g.hero}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!hasTrace(g.match_id)) { missing.push({ match_id: g.match_id, hero: g.hero }); continue; }
    for (let run = 1; run <= runs; run += 1) jobs.push({ match_id: g.match_id, hero: g.hero, lang, run, file: runFileName({ ...g, lang, version, run }), match_record: Boolean(hasMatch(g.match_id)) });
  }
  return { jobs, missing, estimate: Math.round(jobs.length * REVIEW_COST_ESTIMATE * 100) / 100 };
}

/**
 * May the run start (or go on)? `spent`: what the run has cost so far, by the balance (0 before it starts).
 * `balance`: what modelBalance.js's readBalance gave ({ known, available, total, currency } or { known: false, reason }).
 * @param {{ balance: { known: true, available: boolean, total: number, currency: string } | { known: false, reason: string }, estimate: number, floor: number, budget: number, spent?: number }} o
 * @returns {{ go: boolean, reason: string }}
 */
export function spendVerdict({ balance, estimate, floor, budget, spent = 0 }) {
  // Not known, closed for calls, or already under the floor: the probe run's own verdict, in its words.
  const now = balanceVerdict(balance, floor);
  if (!now.go) return { go: false, reason: now.reason };
  if (spent + estimate > budget + 1e-9) return { go: false, reason: `over the budget: ${Math.round((spent + estimate) * 100) / 100} against ${budget}` };
  if (balance.total - estimate < floor - 1e-9) return { go: false, reason: `it would leave less than the floor: ${balance.total} ${balance.currency} less ${estimate} against a floor of ${floor}` };
  return { go: true, reason: 'ok' };
}

/**
 * Write the planned reviews one at a time, checking the account between them.
 * @param {{
 *   jobs: ReturnType<typeof planRuns>['jobs'], floor: number, budget: number,
 *   balance: () => Promise<{ known: true, available: boolean, total: number, currency: string } | { known: false, reason: string }>,
 *   generate: (job: object) => Promise<{ status: string, [k: string]: any }>,
 *   write: (job: object, result: object) => Promise<void>,
 *   log?: (line: string) => void,
 * }} o
 * @returns {Promise<{ started: boolean, reason: string, written: string[], failed: { file: string, status: string }[], not_run: string[], before: object, after: object | null, spent: number | null }>}
 */
export async function runAll({ jobs, floor, budget, balance, generate, write, log = () => {} }) {
  const before = await balance();
  const first = spendVerdict({ balance: before, estimate: Math.round(jobs.length * REVIEW_COST_ESTIMATE * 100) / 100, floor, budget });
  const out = { started: false, reason: first.reason, written: [], failed: [], not_run: jobs.map((j) => j.file), before, after: null, spent: null };
  if (!first.go || !jobs.length) return { ...out, reason: jobs.length ? first.reason : 'nothing_to_run' };
  out.started = true;
  let now = before;
  for (const job of jobs) {
    // What the account has lost since the start is the run's spend as far as it can be told (production spends there too).
    const spent = Math.max(0, before.total - now.total);
    const next = spendVerdict({ balance: now, estimate: REVIEW_COST_ESTIMATE, floor, budget, spent });
    if (!next.go) { out.reason = next.reason; break; }
    log(`writing ${job.file}`);
    let result;
    try { result = await generate(job); } catch (err) { result = { status: `error:${String(err?.message ?? err).slice(0, 80)}` }; }
    out.not_run = out.not_run.filter((f) => f !== job.file);
    if (result?.status === 'ok') { await write(job, result); out.written.push(job.file); } else out.failed.push({ file: job.file, status: String(result?.status ?? 'no_result') });
    now = await balance();
    // The balance cannot be read any more: stop rather than go on blind.
    if (!now.known) { out.reason = `the balance is not known: ${now.reason}`; break; }
  }
  out.after = now;
  out.spent = now.known ? Math.round(Math.max(0, before.total - now.total) * 100) / 100 : null;
  if (!out.not_run.length && out.reason === 'ok') out.reason = 'done';
  return out;
}
