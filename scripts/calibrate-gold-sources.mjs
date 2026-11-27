#!/usr/bin/env node
/**
 * The reference farm_report's gold_by_source quotes (lib/agent/farmReport.js GOLD_SOURCE_REFERENCE), measured on
 * parsed games with gold rows: for the side that lost each game, its gold difference to the winner by source, summed
 * over the games, in each ten-minute stretch (as farm_report cuts them) — where a losing side's gap is usually made.
 *
 *   node scripts/calibrate-gold-sources.mjs <dir with *.trace.json.gz> [--json]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { linkHeroNames, matchOverview } from '../packages/review-engine/src/trace/index.js';
import { GOLD_SOURCES, goldBySource, goldDifference } from '../lib/agent/goldSources.js';

const [dir, flag] = process.argv.slice(2);
if (!dir) { console.error('usage: calibrate-gold-sources.mjs <traces dir> [--json]'); process.exit(2); }
const KEYS = [...GOLD_SOURCES, 'lost_on_dying', 'earned'];
const stretches = new Map(); let games = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.trace.json.gz')).sort()) {
  const t = linkHeroNames(JSON.parse(gunzipSync(readFileSync(`${dir}/${f}`))));
  if (!Array.isArray(t.gold)) continue;
  const o = matchOverview(t, {}, { perspective: t.heroes[0].key });
  if (!o.result || !o.duration?.t) continue;
  games += 1;
  const loser = o.result === 'my_team_lost' ? t.heroes[0].team : t.heroes.find((h) => h.team !== t.heroes[0].team).team;
  const ix = (lost) => t.heroes.filter((h) => (h.team === loser) === lost).map((h) => t.names.indexOf(h.npc));
  const end = Math.floor(o.duration.t / 60);
  for (let a = 0; a < end; a += 10) {
    const b = Math.min(a + 10, end); const label = a >= 30 ? '30:00+' : `${a}:00–${a + 10}:00`;
    const d = goldDifference(goldBySource(t, ix(true), a === 0 ? -Infinity : a, b), goldBySource(t, ix(false), a === 0 ? -Infinity : a, b));
    const s = stretches.get(label) ?? { stretches: 0, ...Object.fromEntries(KEYS.map((k) => [k, 0])) };
    s.stretches += 1; for (const k of KEYS) s[k] += d[k] ?? 0;
    stretches.set(label, s);
  }
}
const out = { games, losing_side_minus_winner_by_stretch: Object.fromEntries(stretches) };
if (flag === '--json') console.log(JSON.stringify(out, null, 2));
else { console.log('games', games); for (const [k, v] of stretches) console.log(k.padEnd(12), JSON.stringify(v)); }
