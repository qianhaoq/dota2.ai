#!/usr/bin/env node
/**
 * Score stored deep reviews without a model (lib/agent/evalReview.js).
 *
 *   node scripts/eval-review.mjs <dir of *.review.json> [--rubrics evals/reviews] [--all-versions]
 *                                [--json out.json] [--baseline data/eval-baseline.v1.json]
 *
 * The reviews are the files the site stores (`<match>.<hero>.<lang>.p<version>[.plan-<plan>].review.json`):
 *   gcloud storage cp 'gs://<agent bucket>/agent/*.review.json' <dir>
 * or the ones scripts/eval-run.mjs writes (the same name with `.r<n>` before `.review.json`: the n-th review of
 * that game written in one run).
 *
 * By default each game is scored by its review of the newest prompt version — by each of them when a run wrote
 * several; --all-versions scores every file and adds one row per prompt version. Stability is always read over every version of a game (a plan's
 * reviews apart): three or more reviews of one game, hero and language.
 *
 * A game with a rubric (evals/reviews/<match>.<hero>.json) is also scored against it; draft rubrics and
 * approved ones are reported apart.
 *
 * --baseline compares the summary with a kept one and exits 1 when a judged number got worse.
 * Exit status: 0 scored · 1 worse than the baseline · 2 usage · 3 nothing readable.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RUBRIC_SCHEMA, compareSummaries, scoreReview, stabilityOf, summarize } from '../lib/agent/evalReview.js';

const USAGE = 'Usage: node scripts/eval-review.mjs <dir of *.review.json> [--rubrics <dir>] [--all-versions] [--json <file>] [--baseline <file>]';
const NAME = /^(\d+)\.([a-z_]+)(?:\.(en|zh|ru))?\.p(\d+)(?:\.plan-([a-z_-]+))?(?:\.m-[a-z0-9._-]+)?(?:\.r([1-9]\d?))?\.review\.json$/;

export function parseArgs(argv) {
  const o = { dir: null, rubrics: 'evals/reviews', allVersions: false, json: null, baseline: null };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all-versions') o.allVersions = true;
    else if (['--rubrics', '--json', '--baseline'].includes(a)) { const v = argv[i += 1]; if (!v || v.startsWith('--')) return null; o[a.slice(2)] = v; } else if (a.startsWith('--')) return null;
    else rest.push(a);
  }
  if (rest.length !== 1) return null;
  return { ...o, dir: rest[0] };
}

/** Which game, hero, language, prompt version and plan a stored review's file name says it is; null for another file. */
export function parseName(file) {
  const m = NAME.exec(file);
  return m ? { file, match_id: Number(m[1]), hero: m[2], lang: m[3] ?? null, version: Number(m[4]), plan: m[5] ?? null, run: m[6] ? Number(m[6]) : null } : null;
}

/** Expand a stored single-language review or trilingual bundle into scorable per-language entries. */
export function expandStoredEntries(meta, stored) {
  if (!stored || typeof stored !== 'object') return [];
  if (stored.reviews && typeof stored.reviews === 'object') {
    const out = [];
    for (const [lang, rev] of Object.entries(stored.reviews)) {
      if (rev && Array.isArray(rev.findings)) out.push({ ...meta, lang, stored: { ...stored, review: rev } });
    }
    if (out.length) return out;
  }
  if ((stored.review ?? stored).findings) {
    const lang = meta.lang ?? (stored.review ?? stored).lang ?? 'en';
    return [{ ...meta, lang, stored }];
  }
  return [];
}

async function readJson(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } }

/** The rubrics in a directory, by "<match>.<hero>". A file that is not a rubric of this schema is left out. */
export async function loadRubrics(dir) {
  const out = new Map();
  let names = [];
  try { names = await readdir(dir); } catch { return out; }
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    const r = await readJson(join(dir, n));
    if (r?.schema === RUBRIC_SCHEMA && Number.isInteger(r.match_id) && typeof r.hero === 'string') out.set(`${r.match_id}.${r.hero}`, r);
  }
  return out;
}

/**
 * Score every review in `entries` ({ ...parseName, stored }): `latest` is the summary over each game's newest
 * version (with the stability numbers added), `by_version` one summary per prompt version (only when asked),
 * `stability` the games reviewed three times or more, `games` one row per scored game.
 */
export function evaluate(entries, rubrics, { allVersions = false } = {}) {
  const groupKey = (e) => `${e.match_id}.${e.hero}.${e.lang}.${e.plan ?? ''}`;
  const groups = new Map();
  for (const e of entries) groups.set(groupKey(e), [...(groups.get(groupKey(e)) ?? []), e]);
  const score = (e) => ({ ...e, stored: undefined, score: scoreReview(e.stored, rubrics.get(`${e.match_id}.${e.hero}`) ?? null) });
  // A game's newest version: one stored review, or every review a run wrote of it.
  const latest = [...groups.values()].flatMap((list) => { const newest = Math.max(...list.map((e) => e.version)); return list.filter((e) => e.version === newest); }).map(score);
  /** @type {Record<string, ReturnType<typeof summarize>> | null} */
  let byVersion = null;
  if (allVersions) {
    byVersion = {};
    for (const v of [...new Set(entries.map((e) => e.version))].sort((a, b) => a - b)) byVersion[`p${v}`] = summarize(entries.filter((e) => e.version === v).map((e) => score(e).score));
  }
  // Stability: a game reviewed three times or more, a plan's reviews apart.
  const stable = [...groups.entries()].filter(([, list]) => list.length >= 3).map(([game, list]) => ({ game, ...stabilityOf(list.map((e) => e.stored)) }));
  const meanOf = (k) => { const v = stable.map((s) => s[k]).filter((x) => x != null); return v.length ? Math.round((v.reduce((a, n) => a + n, 0) / v.length) * 100) / 100 : null; };
  const stability = { games: stable.length, main_reason_agreement: meanOf('main_reason_agreement'), first_finding_overlap: meanOf('first_finding_overlap'), by_game: stable };
  return {
    latest: { ...summarize(latest.map((x) => x.score)), main_reason_agreement: stability.main_reason_agreement, first_finding_overlap: stability.first_finding_overlap },
    by_version: byVersion,
    stability,
    games: latest.map(({ file, match_id, hero, lang, version, plan, score: s }) => ({ file, match_id, hero, lang, version, plan, verdict_chars: s.style.verdict_chars, top_dense: `${s.style.top.dense}/${s.style.top.sentences}`, english_words: s.style.english?.words ?? null, thin_rules: s.logic.thin_rules, matchup_both_ways: Boolean(s.logic.matchup_both_ways), rubric: s.rubric })),
  };
}

const fmt = (v) => (v == null ? '–' : typeof v === 'number' ? String(v) : JSON.stringify(v));

async function main(argv) {
  const o = parseArgs(argv);
  if (!o) { console.error(USAGE); return 2; }
  let names;
  try { names = await readdir(o.dir); } catch { console.error(`Cannot read ${o.dir}`); return 3; }
  const entries = [];
  for (const n of names) {
    const meta = parseName(n);
    if (!meta) continue;
    const stored = await readJson(join(o.dir, n));
    entries.push(...expandStoredEntries(meta, stored));
  }
  if (!entries.length) { console.error(`No stored reviews (*.review.json) in ${o.dir}`); return 3; }
  const rubrics = await loadRubrics(o.rubrics);
  const out = evaluate(entries, rubrics, { allVersions: o.allVersions });

  console.log(`${entries.length} stored reviews, ${out.games.length} scored (each game by its newest version: ${new Set(out.games.map((g) => `${g.match_id}.${g.hero}.${g.lang}.${g.plan ?? ''}`)).size} game(s)), ${rubrics.size} rubric(s)\n`);
  console.log('| number | value |\n|---|---|');
  for (const [k, v] of Object.entries(out.latest)) if (v == null || typeof v !== 'object') console.log(`| ${k} | ${fmt(v)} |`);
  for (const k of ['rubric_approved', 'rubric_draft']) if (out.latest[k]) for (const [kk, v] of Object.entries(out.latest[k])) console.log(`| ${k}.${kk} | ${fmt(v)} |`);
  console.log(`\nStability over ${out.stability.games} game(s) reviewed three times or more:`);
  for (const s of out.stability.by_game) console.log(`  ${s.game}  reviews=${s.reviews}  main_reason=${JSON.stringify(s.main_reason)} agreement=${fmt(s.main_reason_agreement)}  first_finding_overlap=${fmt(s.first_finding_overlap)}`);
  const scored = out.games.filter((g) => g.rubric);
  if (scored.length) {
    console.log('\nAgainst rubrics:');
    for (const g of scored) console.log(`  ${g.file}  [${g.rubric.status}]  hit ${g.rubric.hit_weight}/${g.rubric.weight}  ${g.rubric.must_hit.map((p) => `${p.hit ? '✓' : '✗'} ${p.id}${p.finding ? `(#${p.finding})` : ''}`).join('  ')}  lead ${g.rubric.lead_ok == null ? '–' : g.rubric.lead_ok ? `✓ ${g.rubric.lead}` : '✗'}  turning fight ${fmt(g.rubric.turning_fight_covered)}  main reason ${fmt(g.rubric.main_reason_ok)}${g.rubric.must_not.length ? `  MUST-NOT: ${g.rubric.must_not.map((x) => x.id).join(', ')}` : ''}`);
  }
  if (out.by_version) {
    console.log('\nBy prompt version (reviews, dense top sentences, English words per Chinese review, thin rules):');
    for (const [v, s] of Object.entries(out.by_version)) console.log(`  ${v.padEnd(4)} n=${String(s.reviews).padEnd(3)} dense=${fmt(s.top_dense_sentences)}  english=${fmt(s.english_words_per_chinese_review)}  thin_rules=${fmt(s.thin_rules)}`);
  }
  if (o.json) await writeFile(o.json, `${JSON.stringify({ schema: 'dota2.ai/review-eval@1', reviews: entries.length, ...out }, null, 1)}\n`);
  if (o.baseline) {
    const base = await readJson(o.baseline);
    if (!base?.latest) { console.error(`Cannot read the baseline ${o.baseline}`); return 3; }
    const { worse, better } = compareSummaries(base.latest, out.latest);
    console.log(`\nAgainst ${o.baseline}: ${worse.length} worse, ${better.length} better`);
    for (const w of worse) console.log(`  WORSE  ${w.key}: ${w.before} → ${w.after}`);
    for (const b of better) console.log(`  better ${b.key}: ${b.before} → ${b.after}`);
    if (worse.length) return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
