#!/usr/bin/env node
/**
 * The review page's funnel over the last days of /api/events (lib/analyticsFunnel.js).
 *
 *   gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="dota2-ai" AND jsonPayload.type="analytics"' \
 *     --project <project> --freshness=7d --limit 50000 --format=json | node scripts/funnel.mjs
 *
 * Also reads one JSON object per line (a local server's stdout, filtered to the analytics lines).
 *
 * A browser of ours — the owner's, a session's check — is left out whole once it has been opened with
 * `?internal=1` (lib/analyticsFunnel.js), and the count of what was left out is printed first.
 */
import { parseLogText, summarizeFunnel } from '../lib/analyticsFunnel.js';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const out = summarizeFunnel(parseLogText(Buffer.concat(chunks).toString('utf8')));
const open = out.browsers.opened;
const pct = (n) => (open ? ` (${Math.round((n / open) * 100)}%)` : '');
const label = {
  opened: 'opened a match page',
  requested: 'asked for a review',
  refused: 'were refused at least once',
  viewed: 'saw a finished review',
  own: 'got the review they asked for',
  asked: 'asked the coach a question',
  returned: 'came back (of those who opened: on a later day than their first match page)',
  shared: 'shared the game or their review',
  arrived: 'came in by a shared link',
  goal: 'set a next-game goal',
  checked: 'had that goal checked on a later game',
  goalOnly: 'asked to check a goal without a review',
  played: 'replayed a moment on the map',
  rated: 'said whether a finding was right',
};
console.log(`days: ${out.days[0] ?? '-'} … ${out.days.at(-1) ?? '-'}   events: ${Object.entries(out.events).map(([k, v]) => `${k}=${v}`).join(' ')}`);
if (out.internal.events) console.log(`left out as ours (a browser opened once with ?internal=1): ${out.internal.events} events from ${out.internal.browsers} browser(s)`);
console.log(`browsers (by anonId; ${out.anonymous} events had none):`);
for (const [step, text] of Object.entries(label)) {
  console.log(`  ${String(out.browsers[step]).padStart(5)}  ${text}${step === 'opened' ? '' : `   — of those who opened: ${out.ofOpened[step]}${pct(out.ofOpened[step])}`}`);
}
const said = out.ratings.right + out.ratings.wrong + out.ratings.useless;
if (said) console.log(`findings rated (events; a change of mind counts again): right ${out.ratings.right}, wrong ${out.ratings.wrong}, not useful ${out.ratings.useless} — ${out.ratings.on_the_first_finding} of ${said} about the first finding. The words themselves: scripts/feedback-report.mjs`);
const sources = Object.entries(out.bySource).sort((a, b) => b[1].came - a[1].came);
if (sources.length) {
  console.log('by community link (?src=): came / opened a match / got their review / shared');
  for (const [src, r] of sources) console.log(`  ${src.padEnd(8)} ${String(r.came).padStart(5)} ${String(r.opened).padStart(5)} ${String(r.own).padStart(5)} ${String(r.shared).padStart(5)}`);
}
