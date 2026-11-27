#!/usr/bin/env node
/**
 * The reference lane_report's how_the_lane_went quotes (lib/agent/laneProcess.js LANE_PROCESS_REFERENCE), measured on
 * parsed games with gold rows. One row per side of a lane (a lane and a team), read from the first hero of it.
 *
 * - In lane sides that lost their lane (laneFromReplay's result: lost or lost badly; a lane whose result is not known
 *   is left out): the gold behind from lane creeps against the gold behind from hero kills, assists and dying netted
 *   together, summed, and how many lanes had the second larger.
 * - Lane lost, by the deaths of the side in enemy visits minus the enemy deaths in them; and by the number of enemy
 *   visits alone.
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
for (const f of readdirSync(dir).filter((x) => x.endsWith('.trace.json.gz')).sort()) {
  const t = linkHeroNames(JSON.parse(gunzipSync(readFileSync(`${dir}/${f}`))));
  if (!Array.isArray(t.gold)) continue;
  games += 1;
  const seen = new Set();
  for (let h = 0; h < t.heroes.length; h += 1) {
    const p = laneProcess(t, h);
    if (p.unknown || !p.gold_gap_by_source || !p.enemy_visits) continue;
    const k = `${p.lane}|${t.heroes[h].team}`; if (seen.has(k)) continue; seen.add(k);
    const r = laneFromReplay(t, h);
    // A lane whose result is not known is neither lost nor not lost: it is left out of every count.
    if (r.unknown || r.lane_result == null) continue;
    const d = p.gold_gap_by_source.my_team_minus_enemy;
    rows.push({
      lost: r.lane_result === 'lost' || r.lane_result === 'lost badly',
      // Kills and dying netted first: a side ahead on one and behind on the other is behind by the difference only.
      creeps: Math.min(0, d.lane_creeps), killsDying: Math.min(0, d.hero_kills_and_assists + d.lost_on_dying),
      net: p.enemy_visits.my_team_deaths_in_them - p.enemy_visits.enemy_deaths_in_them, visits: p.enemy_visits.visits,
    });
  }
}
const lost = rows.filter((r) => r.lost);
const share = (a, b) => ({ n: a, of: b, pct: b ? Math.round((100 * a) / b) : null });
const out = {
  games, lane_sides: rows.length, lost_lanes: lost.length,
  lost_lanes_gold_behind: { lane_creeps: lost.reduce((s, r) => s + r.creeps, 0), kills_assists_and_dying: lost.reduce((s, r) => s + r.killsDying, 0) },
  lost_lanes_where_kills_and_dying_were_the_larger_part: share(lost.filter((r) => r.killsDying < r.creeps).length, lost.length),
  lane_lost_when_enemy_visits_cost_net_one_or_more: share(rows.filter((r) => r.net >= 1 && r.lost).length, rows.filter((r) => r.net >= 1).length),
  lane_lost_otherwise: share(rows.filter((r) => r.net < 1 && r.lost).length, rows.filter((r) => r.net < 1).length),
  // The number of enemy visits alone, whatever they cost.
  lane_lost_by_enemy_visits: Object.fromEntries([['0', (v) => v === 0], ['1', (v) => v === 1], ['2', (v) => v === 2], ['3_or_more', (v) => v >= 3]].map(([k, f]) => [k, share(rows.filter((r) => f(r.visits) && r.lost).length, rows.filter((r) => f(r.visits)).length)])),
};
if (flag === '--json') console.log(JSON.stringify(out, null, 2));
else for (const [k, v] of Object.entries(out)) console.log(k.padEnd(56), typeof v === 'object' ? JSON.stringify(v) : v);
