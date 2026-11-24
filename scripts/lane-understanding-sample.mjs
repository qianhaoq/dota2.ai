#!/usr/bin/env node
/**
 * Run the review agent's lane and learning tools the way the agent does —
 * reviewToolkit().runTool — on the acceptance fixture: match 9080127650, the
 * player on Night Stalker. Offline: no network, no model, no cost.
 *
 *   node scripts/lane-understanding-sample.mjs [lang] [calls-json]
 *
 * The match record is the public scoreboard reduced to hero ids, medals, the
 * start time and the patch (src/fixtures/coach/match9080127650.public.json).
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { reviewToolkit } from '../lib/agent/deepReview.js';

const [lang = 'en', callsJson] = process.argv.slice(2);
const trace = JSON.parse(gunzipSync(readFileSync(new URL('../packages/review-engine/test/fixtures/trace-9080127650.json.gz', import.meta.url))).toString());
const match = JSON.parse(readFileSync(new URL('../src/fixtures/coach/match9080127650.public.json', import.meta.url), 'utf8'));
const kit = reviewToolkit({ trace, hero: 'night_stalker', lang, match });
const calls = callsJson ? JSON.parse(callsJson) : [
  ['lane_phase', { hero: 'night_stalker' }],
  ['learn_from_pros', { hero: 'night_stalker' }],
  ['hero_counters', { against: 'slark' }],
  ['ability_counters', { ability: 'pudge_dismember' }],
];
console.log(JSON.stringify({ match_id: trace.match_id, player_hero: 'night_stalker', release: kit.patch }));
for (const [name, a] of calls) console.log(JSON.stringify({ call: name, args: a, result: kit.runTool(name, a) }, null, 1));
