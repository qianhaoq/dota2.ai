// Run from the repository: node packages/cli/scripts/verify-packed.js
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { buildReview, validateReview } from '@dota2ai/review-engine';
const packageDir = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('../../review-engine/test/fixtures/gold/9035042364.json.gz', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'dota2ai-pack-'));
try {
  execFileSync('npm', ['pack', '--pack-destination', directory], { cwd: packageDir, stdio: 'pipe' });
  const preload = join(directory, 'fixture.mjs');
  writeFileSync(preload, `import { readFileSync } from 'node:fs';\nimport { gunzipSync } from 'node:zlib';\nglobalThis.fetch = async url => {\n if (String(url) !== 'https://api.opendota.com/api/matches/9035042364') throw new Error('Unexpected upstream');\n return { ok: true, json: async () => JSON.parse(gunzipSync(readFileSync(${JSON.stringify(fixture)}))) };\n};\n`);
  const env = { ...process.env, NODE_OPTIONS: `--import=${preload}`, npm_config_cache: join(directory, 'cache') };
  delete env.OPENDOTA_API_KEY;
  delete env.DEEPSEEK_API_KEY;
  delete env.GEMINI_API_KEY;
  const output = execFileSync('npx', ['--yes', '--offline', '--package', join(directory, 'dota2ai-0.1.0.tgz'), 'dota2ai', 'review', '9035042364', '--hero', 'pudge', '--json', '--offline'], { cwd: directory, env, encoding: 'utf8' });
  const review = JSON.parse(output);
  assert.equal(validateReview(review).ok, true);
  const raw = JSON.parse(gunzipSync(readFileSync(fixture)));
  const expected = buildReview(raw, { heroId: 14, lang: 'en', fetchedAt: review.meta.generated_at, presetFollowups: true });
  assert.equal(review.match.id, expected.match.id);
  assert.deepEqual(review.facts['gold.low'], expected.facts['gold.low']);
  assert.deepEqual(review.insights.map(i => i.id), expected.insights.map(i => i.id));
  assert.deepEqual(review, expected);
  console.log('Packed npx CLI: schema valid; match ID, gold.low, insight IDs and full engine review match; no keys or registry access.');
  // The coach commands and the agent skill ship too, with the vendored goal judge.
  const listing = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--pack-destination', directory], { cwd: packageDir, encoding: 'utf8' }))[0].files.map((f) => f.path);
  for (const f of ['src/coachApi.js', 'src/agent.js', 'src/coach.js', 'src/vendor/goals.js', 'src/vendor/knowledge.js', 'skills/dota2ai-coach/SKILL.md']) assert.ok(listing.includes(f), `tarball misses ${f}`);
  const help = execFileSync('npx', ['--yes', '--offline', '--package', join(directory, 'dota2ai-0.1.0.tgz'), 'dota2ai', 'help'], { cwd: directory, env, encoding: 'utf8' });
  assert.match(help, /dota2ai goal/);
  const unpacked = join(directory, 'unpacked');
  execFileSync('mkdir', ['-p', unpacked]);
  execFileSync('tar', ['-xzf', join(directory, 'dota2ai-0.1.0.tgz'), '-C', unpacked]);
  const { loadGoals } = await import(join(unpacked, 'package', 'src', 'agent.js'));
  assert.equal(typeof (await loadGoals()).evaluateGoal, 'function');
  console.log('Packed coach commands: help runs, coach/agent/skill files present, vendored goal judge loads.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
