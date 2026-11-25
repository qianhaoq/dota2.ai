#!/usr/bin/env node
/**
 * Ask the coach chat questions the replay settles, and grade each answer against the tools (lib/agent/probes.js).
 *
 *   node scripts/probe-chat.mjs <dir with *.trace.json.gz> [--lang en|zh] [--provider deepseek|glm]
 *                               [--games N] [--kinds a,b] [--concurrency N] [--out <file.json>] [--dry]
 *                               [--regrade <earlier --out file>]
 *
 * The player of each game is the hero in the seat given by the match id's last digit, so a run is repeatable and
 * covers both sides. No review goes in: the chat must look things up. --dry prints the probes and their expected
 * answers without calling a model. --regrade grades the answers of an earlier run again with the probes built now
 * (after a grading fix), without calling a model; a probe whose question changed is left out. Keys are read from the environment only (see scripts/deep-review.mjs).
 * Exit status: 0 done · 2 usage · 3 no API key or no traces.
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
import { linkHeroNames } from '../packages/review-engine/src/trace/build.js';

const USAGE = 'Usage: node scripts/probe-chat.mjs <dir> [--lang en|zh] [--provider deepseek|glm] [--games N] [--kinds a,b] [--concurrency N] [--out <file.json>] [--dry] [--regrade <file.json>]';

function parseArgs(argv) {
  const o = { lang: 'en', provider: 'deepseek', games: Infinity, kinds: PROBE_KINDS, concurrency: 3, out: null, dry: false, regrade: null }; const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry') o.dry = true;
    else if (['--lang', '--provider', '--games', '--kinds', '--concurrency', '--out', '--regrade'].includes(a)) { const v = argv[i += 1]; if (!v || v.startsWith('--')) return null; o[a.slice(2)] = v; } else if (a.startsWith('--')) return null;
    else rest.push(a);
  }
  o.games = Number(o.games); o.concurrency = Number(o.concurrency);
  if (typeof o.kinds === 'string') o.kinds = o.kinds.split(',');
  if (rest.length !== 1 || !['en', 'zh'].includes(o.lang) || !DEEP_REVIEW_PROVIDERS.includes(o.provider) || !(o.games > 0) || !(o.concurrency >= 1) || o.kinds.some((k) => !PROBE_KINDS.includes(k))) return null;
  return { ...o, dir: rest[0] };
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
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
    for (const probe of buildProbes(trace, hero, { lang: o.lang }) ?? []) if (o.kinds.includes(probe.kind)) jobs.push({ trace, hero, probe, names: { heroNames: kit.context.hero_names, placeNames: kit.context.place_names, lang: kit.language } });
  }
  if (o.dry) { console.log(JSON.stringify(jobs.map((j) => j.probe), null, 2)); return 0; }
  const started = Date.now();
  const asked = earlier ? jobs.filter((j) => earlier.get(j.probe.id)?.question === j.probe.question) : jobs;
  const results = await pool(asked, o.concurrency, async ({ trace, hero, probe, names }) => {
    let r;
    const before = earlier?.get(probe.id);
    if (before) r = { status: before.status, text: before.answer, tool_calls: before.tool_calls.map((name) => ({ name })), unverified: { length: before.unverified }, usage: before.usage };
    else try { r = await runChat({ complete, trace, hero, lang: o.lang, question: probe.question }); } catch (e) { r = { status: 'error', error: String(e?.message ?? e).slice(0, 200) }; }
    const answer = r.text ?? '';
    const grade = r.status === 'ok' ? gradeProbe(probe, answer, names) : { pass: false, missing: ['(no answer)'], wrong: [], also_named: [] };
    const calls = r.tool_calls ?? [];
    const row = { id: probe.id, kind: probe.kind, question: probe.question, expect: probe.expect, status: r.status, ...grade, asked_source_tool: calls.some((c) => c.name === probe.source.tool), tool_calls: calls.map((c) => c.name), unverified: (r.unverified ?? []).length, answer, usage: r.usage };
    console.error(`${row.pass ? 'PASS' : 'FAIL'} ${probe.id}${row.pass ? '' : ` missing=${grade.missing.join('|')} wrong=${grade.wrong.join('|')}`}`);
    return row;
  });
  const usage = results.reduce((a, r) => ({ input: a.input + (r.usage?.input ?? 0), output: a.output + (r.usage?.output ?? 0) }), { input: 0, output: 0 });
  const summary = { ...scoreProbes(results), asked_source_tool: results.filter((r) => r.asked_source_tool).length, with_unverified: results.filter((r) => r.unverified > 0).length, games: files.length, lang: o.lang, provider: cfg.provider, model: cfg.model, thinking: cfg.thinking, usage, seconds: Math.round((Date.now() - started) / 1000) };
  const body = JSON.stringify({ summary, results }, null, 2);
  if (o.out) writeFileSync(o.out, `${body}\n`);
  console.log(JSON.stringify(summary, null, 2));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main(process.argv.slice(2));
