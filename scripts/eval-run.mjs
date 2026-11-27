#!/usr/bin/env node
/**
 * Review the rubric games again, so a change to the prompt or to a tool can be scored before and after.
 * This is the part of the eval that costs money (lib/agent/evalRun.js): it reads the account's balance first,
 * says what it expects to spend, and stops when the budget is spent or the account nears its floor.
 *
 *   node scripts/eval-run.mjs --traces <dir of <match>.trace.json.gz> --out <dir>
 *                             [--matches <dir of <match>.json>] [--rubrics evals/reviews]
 *                             [--games 9100904020.beastmaster,9091400302.tidehunter]
 *                             [--runs 3] [--lang zh] [--budget 5] [--floor 50] [--dry-run]
 *
 * Games: every rubric in --rubrics, or the ones --games names. --matches: an OpenDota-shaped match record per
 * game, as production gives the review (scoreboard, gold curve); a game without one is reviewed from the replay
 * alone, and the plan printed first says which. --runs: reviews per game, written one after another.
 * --budget / --floor: in the account's currency. --dry-run prints the plan and the balance and writes nothing.
 * --out must hold no review yet: a run's files are scored together, so two runs do not share a directory.
 *
 * Then score them, and compare two runs:
 *   node scripts/eval-review.mjs <out of the run on main> --json before.json
 *   node scripts/eval-review.mjs <out of the run on the branch> --baseline before.json
 *
 * Model: DeepSeek, as production runs it (lib/agent/providers.js). The key is EVAL_DEEPSEEK_API_KEY, else
 * DEEPSEEK_API_KEY — which is the account production bills, and the run says so.
 * Exit status: 0 every planned review written · 1 some were not (stopped, or the model gave no verifiable
 * review) · 2 usage · 3 not started (no key, no balance, over budget, under the floor, nothing to run, or --out
 * already holds reviews).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import OpenAI from 'openai';
import { deepReviewProvider } from '../lib/agent/providers.js';
import { openAiCompatible } from '../lib/agent/loop.js';
import { DEEP_REVIEW_PROMPT_VERSION, runDeepReview } from '../lib/agent/deepReview.js';
import { REVIEW_COST_ESTIMATE, parseRunArgs, planRuns, reviewsAlreadyIn, runAll } from '../lib/agent/evalRun.js';
import { readBalance } from '../lib/agent/modelBalance.js';
import { webSearchFromEnv } from '../lib/agent/webSearch.js';
import { linkHeroNames } from '../packages/review-engine/src/trace/build.js';
import { loadRubrics } from './eval-review.mjs';

const USAGE = 'Usage: node scripts/eval-run.mjs --traces <dir> --out <dir> [--matches <dir>] [--rubrics <dir>] [--games <match>.<hero>,…] [--runs N] [--lang en|zh] [--budget N] [--floor N] [--dry-run]';
const readJson = async (file) => { const b = await readFile(file); return JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b).toString('utf8')); };
const said = (b) => (b.known ? `${b.currency} ${b.total.toFixed(2)}` : `not known (${b.reason})`);

async function main(argv) {
  const o = parseRunArgs(argv);
  if (!o) { console.error(USAGE); return 2; }
  const env = { ...process.env, ...(process.env.EVAL_DEEPSEEK_API_KEY ? { DEEPSEEK_API_KEY: process.env.EVAL_DEEPSEEK_API_KEY } : {}) };
  // An earlier run's files in the same directory would be scored with this one's as a single experiment.
  const stale = reviewsAlreadyIn(await readdir(o.out).catch(() => []));
  if (stale.length) { console.error(`Not started: ${o.out} already holds ${stale.length} review(s) (${stale[0]}${stale.length > 1 ? ', …' : ''}). Give a directory of its own to each run.`); return 3; }
  const cfg = deepReviewProvider('deepseek', env);
  if (!cfg.ok) { console.error('No key: set EVAL_DEEPSEEK_API_KEY (an account of its own) or DEEPSEEK_API_KEY.'); return 3; }
  const games = o.games ?? [...(await loadRubrics(o.rubrics)).values()].map((r) => ({ match_id: r.match_id, hero: r.hero }));
  const traceOf = (id) => join(o.traces, `${id}.trace.json.gz`);
  const matchOf = (id) => (o.matches ? join(o.matches, `${id}.json`) : null);
  const plan = planRuns({ games, runs: o.runs, lang: o.lang, version: DEEP_REVIEW_PROMPT_VERSION, hasTrace: (id) => existsSync(traceOf(id)), hasMatch: (id) => Boolean(matchOf(id) && existsSync(matchOf(id))) });

  const balance = () => readBalance({ provider: 'deepseek', apiKey: cfg.apiKey });
  const before = await balance();
  console.log(`Prompt version p${DEEP_REVIEW_PROMPT_VERSION}, model ${cfg.model}, thinking ${cfg.thinking}. ${process.env.EVAL_DEEPSEEK_API_KEY ? 'Key: EVAL_DEEPSEEK_API_KEY.' : 'Key: DEEPSEEK_API_KEY — the account production bills.'}`);
  console.log(`To write: ${plan.jobs.length} review(s) — ${o.runs} of each of ${new Set(plan.jobs.map((j) => `${j.match_id}.${j.hero}`)).size} game(s), in ${o.lang}, into ${o.out}`);
  for (const g of new Map(plan.jobs.map((j) => [`${j.match_id}.${j.hero}`, j])).values()) console.log(`  ${g.match_id} ${g.hero}: ${g.match_record ? 'with its match record' : 'from the replay alone (no match record given)'}`);
  for (const m of plan.missing) console.log(`  ${m.match_id} ${m.hero}: NO TRACE in ${o.traces} — not reviewed`);
  console.log(`Expected spend: ${plan.estimate.toFixed(2)} (${REVIEW_COST_ESTIMATE} a review). Budget ${o.budget}. Balance ${said(before)}; floor ${o.floor}.`);
  if (o.dryRun) { console.log('Dry run: nothing written.'); return 0; }

  const client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  const complete = openAiCompatible({ client, model: cfg.model, extraBody: cfg.extraBody });
  const generate = async (job) => {
    const trace = linkHeroNames(await readJson(traceOf(job.match_id)));
    const match = job.match_record ? await readJson(matchOf(job.match_id)) : null;
    const started = Date.now();
    // The eval scores the review in the language it was written in: the other languages (#393) are not written —
    // they double a run's time and spend and change no score.
    // The search bills the same account as the model: the run's balance check covers both.
    const r = await runDeepReview({ complete, trace, match, hero: job.hero, lang: job.lang, translate: false, webSearch: webSearchFromEnv(env) });
    return { ...r, seconds: Math.round((Date.now() - started) / 1000) };
  };
  // The shape the site stores (review, verification, model, tool_calls), with what the run cost beside it.
  // The directory is made with the first review written: a run that does not start leaves nothing behind.
  const write = async (job, r) => { await mkdir(o.out, { recursive: true }); await writeFile(join(o.out, job.file), `${JSON.stringify({ review: r.review, verification: r.verification, model: cfg.model, tool_calls: Array.isArray(r.tool_calls) ? r.tool_calls.length : r.tool_calls ?? null, tools: Array.isArray(r.tool_calls) ? r.tool_calls.map((t) => t.name) : null, usage: r.usage ?? null, steps: r.steps ?? null, seconds: r.seconds, match_record: job.match_record }, null, 1)}\n`); };
  const out = await runAll({ jobs: plan.jobs, floor: o.floor, budget: o.budget, balance, generate, write, log: (line) => console.log(line) });

  if (!out.started) { console.error(`Not started: ${out.reason}.`); return 3; }
  console.log(`\nWritten ${out.written.length}, no verifiable review ${out.failed.length}, not run ${out.not_run.length}${out.reason === 'done' ? '' : ` (stopped: ${out.reason})`}.`);
  for (const f of out.failed) console.log(`  no review: ${f.file} (${f.status})`);
  for (const f of out.not_run) console.log(`  not run: ${f}`);
  console.log(`Balance ${said(out.before)} → ${out.after ? said(out.after) : 'not read'}${out.spent != null ? `: ${out.spent.toFixed(2)} less (production spends from the same account, so this is at most what the run cost)` : ''}.`);
  console.log(`Score them: node scripts/eval-review.mjs ${o.out}`);
  return out.failed.length || out.not_run.length || plan.missing.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
