#!/usr/bin/env node
/**
 * What decides fights and pushes, measured on parsed games.
 * - Fights: for every fight with a winner (one side lost fewer heroes), how often the side ahead on each
 *   pre-fight measure of fight_report won it.
 * - Pushes (siege_report): how often a push took its building, by how many more heroes hit it than its
 *   owners had near, and by how many of the owners were dead when it began.
 * - Deaths (death_context): how often a death was traded (an enemy hero died within 15 s), by how many allies
 *   were within 2200 at it; and, every 5 s from 10:00, how often a living hero died in the next 20 s, by
 *   allies near and side of the map — whether standing alone is itself the danger.
 * - Roshans (roshan_report): each Aegis pickup, whether it was used or expired, and the buildings each side took
 *   in the 300 s after.
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
import { roshanReport } from '../lib/agent/roshanReport.js';
import { linkHeroNames, runTraceTool } from '../packages/review-engine/src/trace/index.js';
import { dist, heroOfName, region, stateAt } from '../packages/review-engine/src/trace/query.js';

const dir = process.argv[2];
if (!dir) { console.error('usage: calibrate.mjs <dir> [--json]'); process.exit(2); }
const files = readdirSync(dir).filter((f) => f.endsWith('.trace.json.gz'));
const rows = [];
const pushes = [];
const deaths = [];
const moments = [];
const roshans = [];
for (const f of files) {
  // As the site reads a stored trace: hero names linked to the combat log's.
  const trace = linkHeroNames(JSON.parse(gunzipSync(readFileSync(join(dir, f)))));
  // From Radiant's first hero: my_team = Radiant. Every fight is read once.
  const first = trace.heroes.find((h) => h.team === 2);
  for (const hero of trace.heroes) {
    for (const d of runTraceTool(trace, 'death_context', { hero: hero.key }).deaths ?? []) if (d.allies_within_2200.at_death != null) deaths.push({ allies: d.allies_within_2200.at_death, traded: d.traded_within_15s });
  }
  // Every 5 s from 10:00 to 20 s before the end: each living hero, and whether they died in the next 20 s.
  const died = trace.heroes.map((_, i) => trace.deaths.filter((d) => heroOfName(trace, d[1]) === i).map((d) => d[0]));
  for (let sec = 600; sec < trace.t0 + trace.n - 20; sec += 5) {
    const at = trace.heroes.map((_, i) => stateAt(trace, i, sec));
    trace.heroes.forEach((h, i) => {
      const s = at[i]; if (!s?.alive) return;
      const allies = trace.heroes.filter((o, j) => j !== i && o.team === h.team && at[j]?.alive && dist(at[j], s) <= 2200).length;
      const side = region(s.x, s.y); const enemyHalf = h.team === 2 ? side.startsWith('dire') : side.startsWith('radiant');
      moments.push({ allies, enemyHalf, died: died[i].some((d) => d > sec && d <= sec + 20) });
    });
  }
  for (const x of roshanReport(trace, { hero: first.key }).takes ?? []) {
    roshans.push({ aegis: x.aegis, took: x.buildings_taking_side_took_count, lost: x.buildings_other_side_took_in_the_next_300s.length, fights: x.fights_in_the_next_300s });
  }
  for (const p of siegeReport(trace, { hero: first.key }).pushes ?? []) {
    pushes.push({ took: p.took_it, margin: p.hitting_minus_owners_near, deadOwners: p.owners_dead_when_it_began });
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
const traded = (list) => ({ deaths: list.length, traded: list.filter((d) => d.traded).length, rate: list.length ? Math.round((list.filter((d) => d.traded).length / list.length) * 100) : null });
const risk = (list) => ({ moments: list.length, died_within_20s: list.filter((m) => m.died).length, rate: list.length ? Math.round((list.filter((m) => m.died).length / list.length) * 1000) / 10 : null });
const alliesLabel = (n) => (n >= 2 ? '2 or more' : String(n));
out.deaths = {
  traded_by_allies_within_2200_at_death: [0, 1, 2].map((n) => ({ allies: alliesLabel(n), ...traded(deaths.filter((d) => (n >= 2 ? d.allies >= 2 : d.allies === n))) })),
  died_within_20s_by_allies_near: [true, false].flatMap((half) => [0, 1, 2].map((n) => ({ side: half ? 'enemy half' : 'own half or river', allies: alliesLabel(n), ...risk(moments.filter((m) => m.enemyHalf === half && (n >= 2 ? m.allies >= 2 : m.allies === n))) }))),
};
const fightsAfter = roshans.flatMap((x) => x.fights);
out.roshans = {
  takes: roshans.length,
  aegis: { used: roshans.filter((x) => x.aegis === 'used').length, expired: roshans.filter((x) => x.aegis === 'expired').length, game_ended: roshans.filter((x) => x.aegis === 'game_ended').length },
  buildings_in_the_next_300s: { taking_side: roshans.reduce((n, x) => n + x.took, 0), other_side: roshans.reduce((n, x) => n + x.lost, 0) },
  takes_with_no_building_after: roshans.filter((x) => x.took === 0).length,
  fights_in_the_next_300s: { fights: fightsAfter.length, taking_side_lost_fewer: fightsAfter.filter((f) => f.aegis_side_deaths < f.other_side_deaths).length, other_side_lost_fewer: fightsAfter.filter((f) => f.aegis_side_deaths > f.other_side_deaths).length },
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
  console.log(`\n${deaths.length} deaths; share traded (an enemy hero died within 15 s)\n`);
  for (const x of out.deaths.traded_by_allies_within_2200_at_death) console.log(`${`  allies within 2200 at death: ${x.allies}`.padEnd(46)} ${String(x.traded).padStart(4)}/${String(x.deaths).padEnd(5)} ${x.rate}%`);
  const ro = out.roshans;
  console.log(`\n${ro.takes} Roshans (Aegis pickups): used ${ro.aegis.used}, expired ${ro.aegis.expired}, game ended ${ro.aegis.game_ended}`);
  console.log(`  in the 300 s after: the taking side took ${ro.buildings_in_the_next_300s.taking_side} buildings, the other side ${ro.buildings_in_the_next_300s.other_side}; takes with no building after: ${ro.takes_with_no_building_after}`);
  console.log(`  fights in those 300 s: ${ro.fights_in_the_next_300s.fights}, the taking side lost fewer in ${ro.fights_in_the_next_300s.taking_side_lost_fewer}, the other side in ${ro.fights_in_the_next_300s.other_side_lost_fewer}`);
  console.log(`\nliving heroes every 5 s from 10:00; share dead within 20 s\n`);
  for (const x of out.deaths.died_within_20s_by_allies_near) console.log(`${`  ${x.side}, allies near: ${x.allies}`.padEnd(46)} ${String(x.died_within_20s).padStart(5)}/${String(x.moments).padEnd(6)} ${x.rate}%`);
}
