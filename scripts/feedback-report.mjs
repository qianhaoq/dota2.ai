#!/usr/bin/env node
/**
 * What readers said about the findings of their reviews: right, wrong, not useful — overall, by prompt version,
 * and for the finding the page leads with. No model, no network: it reads a directory of the records the site
 * keeps under agent/feedback/ (lib/agent/feedback.js).
 *
 *   gcloud storage cp -r gs://<bucket>/agent/feedback ./feedback
 *   node scripts/feedback-report.mjs ./feedback [--json out.json] [--list 40]
 *
 * --list N: how many of the newest "wrong" / "not useful" words to print (default 20).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarizeFeedback } from '../lib/agent/feedback.js';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const dir = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!dir) { console.error('usage: node scripts/feedback-report.mjs <dir of feedback records> [--json out.json] [--list N]'); process.exit(2); }
const list = Number.isInteger(Number(flag('--list'))) && Number(flag('--list')) >= 0 && flag('--list') != null ? Number(flag('--list')) : 20;

let files; try { files = readdirSync(dir).filter((f) => !f.startsWith('.')); } catch { console.error(`cannot read ${dir}`); process.exit(3); }
const records = []; let unreadable = 0;
for (const f of files) { try { records.push(JSON.parse(readFileSync(join(dir, f), 'utf8'))); } catch { unreadable += 1; } }
const s = summarizeFeedback(records);
if (flag('--json')) writeFileSync(flag('--json'), `${JSON.stringify(s, null, 2)}\n`);

const rate = (t) => (t.right_rate == null ? '–' : `${Math.round(t.right_rate * 100)}%`);
const reasons = (t) => Object.entries(t.reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || '–';
const row = (label, t) => `| ${label} | ${t.n} | ${t.right} | ${t.wrong} | ${t.useless} | ${rate(t)} | ${reasons(t)} |`;
console.log(`${files.length} file(s): ${s.all.n} word(s) on findings, ${s.skipped} not a feedback record, ${unreadable} unreadable`);
console.log('\n| | said | right | wrong | not useful | right rate | reasons |\n|---|---|---|---|---|---|---|');
console.log(row('all findings', s.all));
console.log(row('the first finding', s.first_finding));
for (const v of s.by_prompt_version) console.log(row(v.prompt_version == null ? 'version not recorded' : `p${v.prompt_version}`, v));
if (list && s.not_right.length) {
  console.log(`\nNot right, newest first (${Math.min(list, s.not_right.length)} of ${s.not_right.length}):`);
  for (const r of s.not_right.slice(0, list)) console.log(`  ${String(r.at).slice(0, 16)}  ${r.match_id} ${r.hero} ${r.lang} p${r.prompt_version ?? '?'}${r.model ? ` ${r.model}` : ''}  #${r.finding} ${r.rating}${r.reason ? `:${r.reason}` : ''}  ${r.title}`);
}
