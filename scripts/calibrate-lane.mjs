#!/usr/bin/env node
/**
 * How close the lane read from the replay alone (lib/agent/laneFromReplay.js) comes to the match record's, on games
 * that have both: which lane each hero was in, last hits at 5:00 and 10:00, denies at 10:00, and the lane's result.
 *
 *   node scripts/calibrate-lane.mjs <dir with *.trace.json.gz> <dir with <match id>.json match records> [--json]
 *
 * The numbers quoted in lib/agent/laneFromReplay.js come from this script.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { linkHeroNames } from '../packages/review-engine/src/trace/index.js';
import { heroByKey } from '../packages/review-engine/src/staticHeroes.js';
import { laneFromReplay, laneOf } from '../lib/agent/laneFromReplay.js';

const [dir, od] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!dir || !od) { console.error('usage: calibrate-lane.mjs <traces dir> <match records dir> [--json]'); process.exit(2); }
const LANE = { bottom: 1, mid: 2, top: 3 };
const RESULT = { 'won big': 'stomp', won: 'won', even: 'draw', lost: 'lost', 'lost badly': 'stomped' };
const outcome = (diff) => (diff >= 0.25 ? 'stomp' : diff >= 0.08 ? 'won' : diff <= -0.25 ? 'stomped' : diff <= -0.08 ? 'lost' : 'draw');
const dir3 = (o) => (o === 'stomp' || o === 'won' ? 1 : o === 'draw' ? 0 : -1);
const lane = { heroes: 0, decided: 0, agree: 0, agree_all_samples: 0 };
const cs = { lh5: [], lh10: [], dn10: [] };
const result = { heroes: 0, same: 0, same_direction: 0, opposite: 0 };
let games = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.trace.json.gz')).sort()) {
  const id = f.split('.')[0]; const mp = join(od, `${id}.json`); if (!existsSync(mp)) continue;
  const m = JSON.parse(readFileSync(mp, 'utf8')); if (!Array.isArray(m.players?.[0]?.gold_t) || !Array.isArray(m.players[0].lh_t)) continue;
  const t = linkHeroNames(JSON.parse(gunzipSync(readFileSync(join(dir, f)))));
  if (!Array.isArray(t.creep_kills) || !Array.isArray(t.gold)) continue;
  games += 1;
  const rec = (h) => m.players.find((q) => q.hero_id === heroByKey(h.key)?.id);
  t.heroes.forEach((h, i) => {
    const p = rec(h); if (!p || p.lane == null) return;
    lane.heroes += 1; const l = laneOf(t, i);
    if (l != null) { lane.decided += 1; if (l === p.lane) lane.agree += 1; }
    const r = laneFromReplay(t, i); if (r.unknown) return;
    cs.lh5.push(Math.abs(r.last_hits_at_5_00[h.key] - p.lh_t[5])); cs.lh10.push(Math.abs(r.last_hits_at_10_00[h.key] - p.lh_t[10])); cs.dn10.push(Math.abs(r.denies_at_10_00[h.key] - p.dn_t[10]));
    if (p.is_roaming) return;
    const inR = t.heroes.filter((x) => { const q = rec(x); return q && q.lane === p.lane && !q.is_roaming; });
    const us = inR.filter((x) => x.team === h.team).reduce((s, x) => s + rec(x).gold_t[10], 0); const them = inR.filter((x) => x.team !== h.team).reduce((s, x) => s + rec(x).gold_t[10], 0);
    if (!us || !them) return;
    const a = outcome((us - them) / Math.max(us, them)); const b = RESULT[r.lane_result];
    result.heroes += 1; if (a === b) result.same += 1; if (dir3(a) === dir3(b)) result.same_direction += 1; if (dir3(a) * dir3(b) < 0) result.opposite += 1;
  });
}
const within = (arr, k) => (arr.length ? Math.round((arr.filter((x) => x <= k).length / arr.length) * 100) / 100 : null);
const out = {
  games,
  lane,
  last_hits_at_5_00: { heroes: cs.lh5.length, exact: within(cs.lh5, 0), within_2: within(cs.lh5, 2), max: Math.max(...cs.lh5) },
  last_hits_at_10_00: { heroes: cs.lh10.length, exact: within(cs.lh10, 0), within_2: within(cs.lh10, 2), max: Math.max(...cs.lh10) },
  denies_at_10_00: { heroes: cs.dn10.length, exact: within(cs.dn10, 0), within_2: within(cs.dn10, 2), max: Math.max(...cs.dn10) },
  lane_result: result,
};
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`${games} games with a parsed record and the replay's rows`);
  console.log(`lane: ${lane.decided} of ${lane.heroes} heroes decided, ${lane.agree} in the record's lane`);
  for (const k of ['last_hits_at_5_00', 'last_hits_at_10_00', 'denies_at_10_00']) console.log(`${k}: exact ${out[k].exact}, within 2 ${out[k].within_2}, largest difference ${out[k].max} (${out[k].heroes} heroes)`);
  console.log(`lane result: ${result.heroes} heroes; the record's exactly ${result.same}, same direction ${result.same_direction}, opposite ${result.opposite}`);
}
