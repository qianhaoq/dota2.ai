// Run from the repository: node packages/cli/scripts/verify-packed.js
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'dota2ai-pack-'));
try {
  execFileSync('npm', ['pack', '--pack-destination', directory], { cwd: packageDir, stdio: 'pipe' });
  const env = { ...process.env, npm_config_cache: join(directory, 'cache') };
  delete env.OPENDOTA_API_KEY;
  delete env.DEEPSEEK_API_KEY;
  delete env.GEMINI_API_KEY;

  const listing = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--pack-destination', directory], { cwd: packageDir, encoding: 'utf8' }))[0].files.map((f) => f.path);
  for (const f of ['src/coachApi.js', 'src/agent.js', 'src/coach.js', 'src/trace.js', 'src/vendor/goals.js', 'src/vendor/knowledge.js', 'skills/dota2ai-coach/SKILL.md']) {
    assert.ok(listing.includes(f), `tarball misses ${f}`);
  }
  const help = execFileSync('npx', ['--yes', '--offline', '--package', join(directory, 'dota2ai-0.1.0.tgz'), 'dota2ai', 'help'], { cwd: directory, env, encoding: 'utf8' });
  assert.match(help, /dota2ai trace/);
  const unpacked = join(directory, 'unpacked');
  execFileSync('mkdir', ['-p', unpacked]);
  execFileSync('tar', ['-xzf', join(directory, 'dota2ai-0.1.0.tgz'), '-C', unpacked]);
  const { loadGoals } = await import(join(unpacked, 'package', 'src', 'agent.js'));
  assert.equal(typeof (await loadGoals()).evaluateGoal, 'function');
  console.log('Packed CLI verified: help runs, coach/trace/skill files present, vendored goal judge loads.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
