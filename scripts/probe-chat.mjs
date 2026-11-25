#!/usr/bin/env node
/**
 * Ask the coach chat questions the replay settles, and grade each answer against the tools (lib/agent/probes.js).
 *
 *   node scripts/probe-chat.mjs <dir with *.trace.json.gz> [--lang en|zh] [--provider deepseek|glm]
 *                               [--games N] [--kinds a,b] [--concurrency N] [--out <file.json>] [--dry]
 *                               [--regrade <earlier --out file>] [--only <probe id,…>]
 *                               [--min-balance <amount>] [--no-balance-check]
 *
 * The player of each game is the hero in the seat given by the match id's last digit, so a run is repeatable and
 * covers both sides. No review goes in: the chat must look things up. --dry prints the probes and their expected
 * answers without calling a model. --regrade grades the answers of an earlier run again with the probes built now
 * (after a grading fix), without calling a model; a probe whose question changed is left out. Keys are read from
 * the environment only (see scripts/deep-review.mjs).
 *
 * The model account is the site's: a key on this machine can bill the account production runs on. Before the
 * first question, and again every 20 questions sent, the run reads the account's balance (lib/agent/modelBalance.js) and
 * does not start, or stops, when it is under --min-balance (default 50, in the account's currency) or cannot be
 * read. Probes it did not reach are written as not_asked and are not scored. --no-balance-check turns this off:
 * only for an account nothing else depends on.
 * Exit status: 0 done · 2 usage · 3 no API key or no traces · 4 not started, or stopped early, for the balance.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import OpenAI from 'openai';
import { DEEP_REVIEW_PROVIDERS, deepReviewProvider } from '../lib/agent/providers.js';
import { openAiCompatible } from '../lib/agent/loop.js';
import { runChat } from '../lib/agent/chat.js';
import { reviewToolkit } from '../lib/agent/deepReview.js';
import { buildProbes, gradeProbe, scoreProbes, PROBE_KINDS } from '../lib/agent/probes.js';
import { runProbes } from '../lib/agent/probeRun.js';
import { readBalance, balanceVerdict, DEFAULT_BALANCE_FLOOR } from '../lib/agent/modelBalance.js';
import { linkHeroNames } from '../packages/review-engine/src/trace/build.js';

const USAGE = 'Usage: node scripts/probe-chat.mjs <dir> [--lang en|zh] [--provider deepseek|glm] [--games N] [--kinds a,b] [--concurrency N] [--out <file.json>] [--dry] [--regrade <file.json>] [--only <id,…>] [--min-balance <amount>] [--no-balance-check]';

function parseArgs(argv) {
  const o = { lang: 'en', provider: 'deepseek', games: Infinity, kinds: PROBE_KINDS, concurrency: 3, out: null, dry: false, regrade: null, only: null, 'min-balance': DEFAULT_BALANCE_FLOOR, balanceCheck: true }; const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry') o.dry = true;
    else if (a === '--no-balance-check') o.balanceCheck = false;
    else if (['--lang', '--provider', '--games', '--kinds', '--concurrency', '--out', '--regrade', '--only', '--min-balance'].includes(a)) { const v = argv[i += 1]; if (!v || v.startsWith('--')) return null; o[a.slice(2)] = v; } else if (a.startsWith('--')) return null;
    else rest.push(a);
  }
  o.games = Number(o.games); o.concurrency = Number(o.concurrency); o.minBalance = Number(o['min-balance']);
  if (typeof o.kinds === 'string') o.kinds = o.kinds.split(',');
  if (typeof o.only === 'string') o.only = new Set(o.only.split(','));
  if (rest.length !== 1 || !['en', 'zh'].includes(o.lang) || !DEEP_REVIEW_PROVIDERS.includes(o.provider) || !(o.games > 0) || !(o.concurrency >= 1) || !(o.minBalance >= 0) || o.kinds.some((k) => !PROBE_KINDS.includes(k))) return null;
  return { ...o, dir: rest[0] };
}

async function main(argv) {
  const o = parseArgs(argv);
  if (!o) { console.error(USAGE); return 2; }
  const files = readdirSync(o.dir).filter((f) => f.endsWith('.trace.json.gz')).sort().slice(0, o.games);
  if (!files.length) { console.error('No traces in that directory.'); return 3; }
  let complete = null; let cfg = null;
  const earlier = o.regrade ? new Map(JSON.parse(readFileSync(o.regrade, 'utf8')).results.map((r) => [r.id, r])) : null;
  if (earlier) cfg = { provider: 'regrade', model: null, thinking: null };
  if (!o.dry && !earlier) {
    cfg = deepReviewProvider(o.provider, process.env);
    if (!cfg.ok) { console.error(`${cfg.needs ?? 'Provider'} is not set.`); return 3; }
    complete = openAiCompatible({ client: new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey }), model: cfg.model, extraBody: cfg.extraBody });
  }
  const jobs = [];
  for (const f of files) {
    // As the site reads a stored trace: hero names linked to the combat log's.
    const trace = linkHeroNames(JSON.parse(gunzipSync(readFileSync(join(o.dir, f))).toString('utf8')));
    const hero = trace.heroes[Number(String(trace.match_id).slice(-1))]?.key ?? trace.heroes[0].key;
    const kit = reviewToolkit({ trace, hero, lang: o.lang });
    for (const probe of buildProbes(trace, hero, { lang: o.lang }) ?? []) if (o.kinds.includes(probe.kind) && (!o.only || o.only.has(probe.id))) jobs.push({ trace, hero, probe, names: { heroNames: kit.context.hero_names, placeNames: kit.context.place_names, lang: kit.language } });
  }
  if (o.dry) { console.log(JSON.stringify(jobs.map((j) => j.probe), null, 2)); return 0; }
  // The balance of the account this run spends from: read before the first question and as the run goes.
  const live = !earlier;
  const balance = () => readBalance({ provider: cfg.provider, apiKey: cfg.apiKey });
  const guard = live && o.balanceCheck ? async () => balanceVerdict(await balance(), o.minBalance) : null;
  const before = live ? await balance() : null;
  if (guard) {
    const v = balanceVerdict(before, o.minBalance);
    console.error(`Balance: ${v.reason}.`);
    if (!v.go) { console.error('Not started: this account is the one the site runs on. Top it up, lower --min-balance, or pass --no-balance-check for an account nothing else depends on.'); return 4; }
  } else if (live) console.error('Balance check is off (--no-balance-check).');
  const started = Date.now();
  const asked = earlier ? jobs.filter((j) => earlier.get(j.probe.id)?.question === j.probe.question) : jobs;
  const { rows: results, stopped } = await runProbes({
    jobs: asked,
    concurrency: o.concurrency,
    guard,
    live,
    // A re-grade answers from the earlier run's file; a row it did not get an answer for stays without one.
    ask: earlier
      ? async ({ probe }) => { const was = earlier.get(probe.id); return { status: was.status, error: was.error, text: was.answer, tool_calls: (was.tool_calls ?? []).map((name) => ({ name })), unverified: { length: was.unverified ?? 0 }, usage: was.usage }; }
      : ({ trace, hero, probe }) => runChat({ complete, trace, hero, lang: o.lang, question: probe.question }),
    grade: ({ probe, names }, answer) => gradeProbe(probe, answer, names),
    onRow: (row) => console.error(row.pass == null ? `SKIP ${row.id} ${row.status}${row.error ? ` (${row.error})` : ''}` : `${row.pass ? 'PASS' : 'FAIL'} ${row.id}${row.pass ? '' : ` missing=${row.missing.join('|')} wrong=${row.wrong.join('|')}`}`),
  });
  if (stopped) console.error(`Stopped early: ${stopped}. Probes not reached are written as not_asked and are not scored.`);
  const after = live ? await balance() : null;
  const spent = before?.known && after?.known && before.currency === after.currency ? Math.round((before.total - after.total) * 100) / 100 : null;
  const usage = results.reduce((a, r) => ({ input: a.input + (r.usage?.input ?? 0), output: a.output + (r.usage?.output ?? 0) }), { input: 0, output: 0 });
  const count = (status) => results.filter((r) => r.status === status).length;
  const summary = {
    ...scoreProbes(results), errors: count('error'), not_asked: count('not_asked'), stopped,
    asked_source_tool: results.filter((r) => r.asked_source_tool).length, with_unverified: results.filter((r) => r.unverified > 0).length,
    games: files.length, lang: o.lang, provider: cfg.provider, model: cfg.model, thinking: cfg.thinking, usage,
    ...(live ? { balance: { before: before?.known ? before.total : null, after: after?.known ? after.total : null, currency: (after?.known ? after : before)?.currency ?? null, spent, floor: o.balanceCheck ? o.minBalance : null } } : {}),
    seconds: Math.round((Date.now() - started) / 1000),
  };
  const body = JSON.stringify({ summary, results }, null, 2);
  if (o.out) writeFileSync(o.out, `${body}\n`);
  console.log(JSON.stringify(summary, null, 2));
  return stopped ? 4 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main(process.argv.slice(2));
