#!/usr/bin/env node
/**
 * Run the review agent's counter tools (ability_counters, item_counters,
 * hero_counters) the way the agent does — reviewToolkit().runTool — on the
 * committed replay-trace fixture, and print what they return. Offline: no
 * network, no model, no cost.
 *
 *   node scripts/counter-tools-sample.mjs [hero] [lang] [calls-json] [--release-start=<ISO time>]
 *
 *   hero        the player's hero in the fixture (default beastmaster)
 *   lang        en | zh (default en)
 *   calls-json  [[tool, args], …] (default: one call of each tool)
 *   --release-start  a start time to tell the game as if played then (e.g. 2026-10-01T12:00:00Z → 7.41f)
 *
 * A match record with the ten heroes at Legend (rank tier 65) is passed so the
 * public numbers have a bracket; the fixture has no OpenDota match JSON.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { reviewToolkit } from '../lib/agent/deepReview.js';
import { HEROES_BY_KEY } from '../packages/review-engine/src/staticHeroes.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const start = process.argv.find((a) => a.startsWith('--release-start='))?.split('=')[1];
const [hero = 'beastmaster', lang = 'en', callsJson] = args;
const trace = JSON.parse(gunzipSync(readFileSync(new URL('../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const match = { players: trace.heroes.map((h) => ({ hero_id: HEROES_BY_KEY.get(h.key).id, rank_tier: 65 })), ...(start ? { start_time: Date.parse(start) / 1000 } : {}) };
const kit = reviewToolkit({ trace, hero, lang, match });
if (!kit) { console.error(`${hero} is not in the fixture: ${trace.heroes.map((h) => h.key).join(', ')}`); process.exit(1); }
const calls = callsJson ? JSON.parse(callsJson) : [
  ['ability_counters', { ability: 'necrolyte_reapers_scythe' }],
  ['item_counters', { item: 'black_king_bar' }],
  ['hero_counters', { against: 'phantom_assassin' }],
];
console.log(JSON.stringify({ match_id: trace.match_id, player_hero: hero, release: kit.patch }));
for (const [name, a] of calls) console.log(JSON.stringify({ call: name, args: a, result: kit.runTool(name, a) }, null, 1));
