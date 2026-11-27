#!/usr/bin/env node
/**
 * The reference lane_report's how_the_lane_went quotes (lib/agent/laneProcess.js LANE_PROCESS_REFERENCE), measured on
 * parsed games with gold rows. One row per side of a lane (a lane and a team), read from the first hero of it.
 *
 * - In lane sides that lost their lane (laneFromReplay's result: lost or lost badly; a lane whose result is not known
 *   is left out; only games whose gold log has dying rows: a loss not known is not 0): the gold behind from lane creeps against the gold behind from hero kills, assists and dying netted
 *   together, summed, and how many lanes had the second larger.
 * - Lane lost, by the deaths of the side in enemy visits minus the enemy deaths in them; and by the number of enemy
 *   visits alone.
 * - The same, without the lanes a hero shared part-time (their sums leave that hero out, so a side may be one hero
 *   against two).
 *
 *   node scripts/calibrate-lane-process.mjs <dir with *.trace.json.gz> [--json]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { linkHeroNames } from '../packages/review-engine/src/trace/index.js';
import { laneProcess } from '../lib/agent/laneProcess.js';
import { laneFromReplay } from '../lib/agent/laneFromReplay.js';

const [dir, flag] = process.argv.slice(2);
if (!dir) { console.error('usage: calibrate-lane-process.mjs <traces dir> [--json]'); process.exit(2); }
const rows = []; let games = 0;
const rotTrips = []; let rotHeroes = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.trace.json.gz')).sort()) {
  const t = linkHeroNames(JSON.parse(gunzipSync(readFileSync(`${dir}/${f}`))));
  if (!Array.isArray(t.gold)) continue;
  games += 1;
  const seen = new Set();
  for (let h = 0; h < t.heroes.length; h += 1) {
    const p = laneProcess(t, h);
    if (p.unknown) continue;
    if (p.my_rotations_before_10_00) {
      rotHeroes += 1;
      for (const tr of p.my_rotations_before_10_00.trips) {
        rotTrips.push({
          seconds: tr.seconds,
          enemyKillKnown: Array.isArray(tr.enemy_deaths_i_damaged),
          enemyKill: Array.isArray(tr.enemy_deaths_i_damaged) && tr.enemy_deaths_i_damaged.length > 0,
          partnerDied: Array.isArray(tr.lane_partner_deaths_while_away) && tr.lane_partner_deaths_while_away.length > 0,
          partnerKnown: Array.isArray(tr.lane_partner_deaths_while_away),
          runeKnown: Array.isArray(tr.runes_picked),
          rune: Array.isArray(tr.runes_picked) && tr.runes_picked.length > 0,
          wardKnown: tr.wards_placed != null,
          ward: Boolean(tr.wards_placed && (tr.wards_placed.observers > 0 || tr.wards_placed.sentries > 0)),
        });
      }
    }
    if (!p.gold_gap_by_source || !p.enemy_visits) continue;
    const k = `${p.lane}|${t.heroes[h].team}`; if (seen.has(k)) continue; seen.add(k);
    const r = laneFromReplay(t, h);
    // A lane whose result is not known is neither lost nor not lost: it is left out of every count.
    if (r.unknown || r.lane_result == null) continue;
    const d = p.gold_gap_by_source.my_team_minus_enemy;
    rows.push({
      lost: r.lane_result === 'lost' || r.lane_result === 'lost badly',
      // Kills and dying netted first: a side ahead on one and behind on the other is behind by the difference only.
      creeps: Math.min(0, d.lane_creeps), killsDying: (d.lost_on_dying == null ? null : Math.min(0, d.hero_kills_and_assists + d.lost_on_dying)),
      net: p.enemy_visits.my_team_deaths_in_them - p.enemy_visits.enemy_deaths_in_them, visits: p.enemy_visits.visits,
      partTime: p.part_time_in_this_lane.length > 0,
    });
  }
}
const lost = rows.filter((r) => r.lost);
// The gold comparisons need what dying cost: lanes of games whose log has no dying rows are left out of them.
const lostKnown = lost.filter((r) => r.killsDying != null);
const share = (a, b) => ({ n: a, of: b, pct: b ? Math.round((100 * a) / b) : null });
const out = {
  games, lane_sides: rows.length, lost_lanes: lost.length,
  lost_lanes_with_dying_known: lostKnown.length,
  lost_lanes_gold_behind: { lane_creeps: lostKnown.reduce((s, r) => s + r.creeps, 0), kills_assists_and_dying: lostKnown.reduce((s, r) => s + r.killsDying, 0) },
  lost_lanes_where_kills_and_dying_were_the_larger_part: share(lostKnown.filter((r) => r.killsDying < r.creeps).length, lostKnown.length),
  lane_lost_when_enemy_visits_cost_net_one_or_more: share(rows.filter((r) => r.net >= 1 && r.lost).length, rows.filter((r) => r.net >= 1).length),
  lane_lost_otherwise: share(rows.filter((r) => r.net < 1 && r.lost).length, rows.filter((r) => r.net < 1).length),
  // The number of enemy visits alone, whatever they cost.
  lane_lost_by_enemy_visits: Object.fromEntries([['0', (v) => v === 0], ['1', (v) => v === 1], ['2', (v) => v === 2], ['3_or_more', (v) => v >= 3]].map(([k, f]) => [k, share(rows.filter((r) => f(r.visits) && r.lost).length, rows.filter((r) => f(r.visits)).length)])),
};
// The same, leaving out lanes a hero shared part-time (their sums compare the heroes in the lane only).
const even = rows.filter((r) => !r.partTime); const evenLost = even.filter((r) => r.lost && r.killsDying != null);
out.lane_sides_with_a_part_time_sharer = rows.length - even.length;
out.without_them = {
  lost_lanes_with_dying_known: evenLost.length,
  lost_lanes_where_kills_and_dying_were_the_larger_part: share(evenLost.filter((r) => r.killsDying < r.creeps).length, evenLost.length),
  lane_lost_when_enemy_visits_cost_net_one_or_more: share(even.filter((r) => r.net >= 1 && r.lost).length, even.filter((r) => r.net >= 1).length),
  lane_lost_otherwise: share(even.filter((r) => r.net < 1 && r.lost).length, even.filter((r) => r.net < 1).length),
};
const enemyKnownTrips = rotTrips.filter((x) => x.enemyKillKnown);
const partnerKnownTrips = rotTrips.filter((x) => x.partnerKnown);
const runeKnownTrips = rotTrips.filter((x) => x.runeKnown);
const wardKnownTrips = rotTrips.filter((x) => x.wardKnown);
out.early_rotations = {
  heroes_with_single_lane: rotHeroes,
  trips: rotTrips.length,
  trips_with_enemy_death_damaged: share(enemyKnownTrips.filter((x) => x.enemyKill).length, enemyKnownTrips.length),
  trips_where_lane_partner_died: share(partnerKnownTrips.filter((x) => x.partnerDied).length, partnerKnownTrips.length),
  trips_with_rune_picked: share(runeKnownTrips.filter((x) => x.rune).length, runeKnownTrips.length),
  trips_with_ward_placed: share(wardKnownTrips.filter((x) => x.ward).length, wardKnownTrips.length),
};
if (flag === '--json') console.log(JSON.stringify(out, null, 2));
else for (const [k, v] of Object.entries(out)) console.log(k.padEnd(56), typeof v === 'object' ? JSON.stringify(v) : v);
