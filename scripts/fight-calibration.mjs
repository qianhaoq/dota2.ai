#!/usr/bin/env node
/**
 * What decides fights, measured on parsed games: for every fight with a winner (one side lost fewer heroes),
 * how often the side ahead on each pre-fight measure of fight_report won it.
 *
 *   node scripts/fight-calibration.mjs <dir with *.trace.json.gz> [--json]
 *
 * Production traces: gs://<bucket>/agent/*.trace.json.gz. The numbers quoted in
 * docs/GAME_UNDERSTANDING.md and lib/agent/fightReport.js come from this script; re-run it
 * when the corpus grows and update both.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fightReport } from '../lib/agent/fightReport.js';

const dir = process.argv[2];
if (!dir) { console.error('usage: fight-calibration.mjs <dir> [--json]'); process.exit(2); }
const files = readdirSync(dir).filter((f) => f.endsWith('.trace.json.gz'));
const rows = [];
for (const f of files) {
  const trace = JSON.parse(gunzipSync(readFileSync(join(dir, f))));
  // From Radiant's first hero: my_team = Radiant. Every fight is read once.
  const first = trace.heroes.find((h) => h.team === 2);
  const r = fightReport(trace, { hero: first.key });
  if (r.error) continue;
  for (const x of r.fights) {
    if (x.lost_fewer_heroes === 'even') continue;
    const m = x.my_team; const e = x.enemy;
    rows.push({
      match: trace.match_id, fight: x.fight, won: x.lost_fewer_heroes === 'my_team' ? 1 : -1,
      heroes: m.took_part_count - e.took_part_count,
      ultimates: m.ultimates_ready.length - e.ultimates_ready.length,
      levels: m.levels_of_those_in_it - e.levels_of_those_in_it,
      bkbs: m.black_king_bars_ready.length - e.black_king_bars_ready.length,
      gold: Number.isFinite(x.my_team_gold_lead) ? x.my_team_gold_lead : null,
    });
  }
}
const sgn = (v) => (v == null || v === 0 ? 0 : v > 0 ? 1 : -1);
function measure(name, pick) {
  let n = 0; let ok = 0;
  for (const r of rows) { const p = sgn(pick(r)); if (!p) continue; n += 1; if (p === r.won) ok += 1; }
  return { measure: name, fights: n, side_ahead_won: ok, rate: n ? Math.round((ok / n) * 100) : null };
}
const out = {
  games: files.length,
  fights_with_a_winner: rows.length,
  measures: [
    measure('more heroes took part', (r) => r.heroes),
    measure('two or more heroes more took part', (r) => (Math.abs(r.heroes) >= 2 ? r.heroes : 0)),
    measure('more ultimates ready', (r) => r.ultimates),
    measure('more Black King Bars ready', (r) => r.bkbs),
    measure('more levels among those in it', (r) => r.levels),
    measure('gold lead that minute', (r) => r.gold),
    measure('more heroes, else more ultimates, else gold', (r) => sgn(r.heroes) || sgn(r.ultimates) || sgn(r.gold)),
    measure('gold behind but more heroes took part', (r) => (sgn(r.gold) && sgn(r.heroes) && sgn(r.gold) !== sgn(r.heroes) ? r.heroes : 0)),
  ],
};
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`${out.games} games, ${out.fights_with_a_winner} fights where one side lost fewer heroes\n`);
  for (const m of out.measures) console.log(`${m.measure.padEnd(46)} ${String(m.side_ahead_won).padStart(4)}/${String(m.fights).padEnd(4)} ${m.rate}%`);
}
