#!/usr/bin/env node
/**
 * What decides fights and pushes, measured on parsed games.
 * - Fights: for every fight with a winner (one side lost fewer heroes), how often the side ahead on each
 *   pre-fight measure of fight_report won it.
 * - Pushes (siege_report): how often a push took its building, by how many more heroes hit it than its
 *   owners had near, and by how many of the owners were dead when it began.
 *
 *   node scripts/calibrate.mjs <dir with *.trace.json.gz> [--json]
 *
 * Production traces: gs://<bucket>/agent/*.trace.json.gz. The numbers quoted in
 * docs/GAME_UNDERSTANDING.md and lib/agent/fightReport.js come from this script; re-run it
 * when the corpus grows and update both.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fightReport } from '../lib/agent/fightReport.js';
import { siegeReport } from '../lib/agent/siegeReport.js';
import { linkHeroNames } from '../packages/review-engine/src/trace/index.js';

const dir = process.argv[2];
if (!dir) { console.error('usage: calibrate.mjs <dir> [--json]'); process.exit(2); }
const files = readdirSync(dir).filter((f) => f.endsWith('.trace.json.gz'));
const rows = [];
const pushes = [];
for (const f of files) {
  // As the site reads a stored trace: hero names linked to the combat log's.
  const trace = linkHeroNames(JSON.parse(gunzipSync(readFileSync(join(dir, f)))));
  // From Radiant's first hero: my_team = Radiant. Every fight is read once.
  const first = trace.heroes.find((h) => h.team === 2);
  for (const p of siegeReport(trace, { hero: first.key }).pushes ?? []) {
    pushes.push({ took: p.took_it, margin: p.hitting_minus_owners_near, deadOwners: p.owners_not_near.filter((x) => x.doing === 'dead').length });
  }
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
const share = (list) => ({ pushes: list.length, took_it: list.filter((p) => p.took).length, rate: list.length ? Math.round((list.filter((p) => p.took).length / list.length) * 100) : null });
// In order, as a list: an object's number-like keys would be sorted ahead of the others.
const bucket = (key, lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).map((v) => ({ value: v === lo ? (v === 0 ? '0' : `${v} or fewer`) : v === hi ? `${v} or more` : String(v), ...share(pushes.filter((p) => (v === lo ? key(p) <= v : v === hi ? key(p) >= v : key(p) === v))) }));
out.pushes = {
  total: share(pushes),
  by_heroes_hitting_minus_owners_near: bucket((p) => p.margin, -1, 3),
  two_or_more_hitting_than_near: share(pushes.filter((p) => p.margin >= 2)),
  at_most_one_more_hitting_than_near: share(pushes.filter((p) => p.margin <= 1)),
  by_owners_dead_when_it_began: bucket((p) => p.deadOwners, 0, 4),
};
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`${out.games} games, ${out.fights_with_a_winner} fights where one side lost fewer heroes\n`);
  for (const m of out.measures) console.log(`${m.measure.padEnd(46)} ${String(m.side_ahead_won).padStart(4)}/${String(m.fights).padEnd(4)} ${m.rate}%`);
  const line = (label, x) => console.log(`${label.padEnd(46)} ${String(x.took_it).padStart(4)}/${String(x.pushes).padEnd(4)} ${x.rate}%`);
  console.log(`\n${out.pushes.total.pushes} pushes on buildings; share that took the building\n`);
  line('all pushes', out.pushes.total);
  line('two or more hitting than near', out.pushes.two_or_more_hitting_than_near);
  line('at most one more hitting than near', out.pushes.at_most_one_more_hitting_than_near);
  for (const x of out.pushes.by_heroes_hitting_minus_owners_near) line(`  hitting minus near: ${x.value}`, x);
  for (const x of out.pushes.by_owners_dead_when_it_began) line(`  owners dead when it began: ${x.value}`, x);
}
