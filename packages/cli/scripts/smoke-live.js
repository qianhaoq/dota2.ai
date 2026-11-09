// Opt-in production check: node packages/cli/scripts/smoke-live.js
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validateReview } from '@dota2ai/review-engine';

// execFile rejects on a nonzero CLI exit or timeout.
const result = await promisify(execFile)(process.execPath, [
  fileURLToPath(new URL('../bin/dota2ai.js', import.meta.url)),
  'review', '9035042364', '--hero', '14', '--lang', 'en', '--json',
], {
  encoding: 'utf8',
  env: { ...process.env, DOTA2AI_API_BASE: 'https://dota2.ai' },
  timeout: 45000,
});
const review = JSON.parse(result.stdout);
assert.deepEqual(validateReview(review), { ok: true, errors: [] });
assert.equal(review.match.id, 9035042364);
assert.equal(review.player?.hero_id, 14);
assert.ok(Array.isArray(review.insights));
assert.ok(Array.isArray(review.data_gaps));
console.log(JSON.stringify({
  match_id: review.match.id,
  hero_id: review.player.hero_id,
  hero: review.player.hero,
  insight_count: review.insights.length,
  data_gaps: review.data_gaps.map(gap => gap.topic),
}, null, 2));
