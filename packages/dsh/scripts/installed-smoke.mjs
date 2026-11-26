// Install the release archive into a clean DSH profile through DSH's own CLI and
// check what a DSH session would get:
//   1. DSH itself composes the profile and loads the plugin's Config through its
//      runtime module resolution (--dump-config / --dump-config-schema);
//   2. the installed plugin, loaded in a Cordis context where @deepseek-ai/* come
//      from the DSH installation (as DSH's resolver supplies them), registers its
//      tools, refuses bad arguments, and survives a reload.
//   node packages/dsh/scripts/installed-smoke.mjs <archive.tgz> --dsh <@deepseek-ai/dsh>/lib/bin.js [--live]
// --live also calls dota2.ai (a roster, a matchup, a replay review start; marked internal).
// Needs Node >= 24.9 and pnpm on PATH (DSH installs plugins with pnpm).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const archive = resolve(args.find((a) => a.endsWith('.tgz')) ?? '');
const cli = args.indexOf('--dsh') >= 0 ? resolve(args[args.indexOf('--dsh') + 1]) : null;
const live = args.includes('--live');
if (!archive.endsWith('.tgz') || !cli) {
  console.error('usage: installed-smoke.mjs <archive.tgz> --dsh <dsh bin.js> [--live]');
  process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), 'dsh-dota2ai-smoke-'));
const env = { ...process.env, DSH_HOME: home };
const dsh = (...a) => execFileSync(process.execPath, [cli, ...a], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
let fiber;
try {
  dsh('plugin', '--profile', 'web', 'add', archive);

  // 1. The real host: the bundle patch is composed, and the Config loads under DSH's resolution.
  const composed = dsh('--profile', 'web', '--dump-config');
  assert.match(composed, /@qianhaoq\/dsh-dota2ai/, 'the bundle patch is in the composed profile');
  // The shipped web profile reports diagnostics of its own here (and exits 1): only ours matter.
  const dump = spawnSync(process.execPath, [cli, '--profile', 'web', '--dump-config-schema'], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.match(JSON.stringify(JSON.parse(dump.stdout)), /"apiBase":\{"description":"dota2.ai origin"/, 'DSH loaded the plugin module and read its Config');
  assert.doesNotMatch(dump.stderr, /dota2ai/, `no DSH diagnostic about the plugin:\n${dump.stderr}`);

  // 2. The installed plugin in a Cordis context; @deepseek-ai/* resolve to the DSH installation.
  const host = createRequire(cli);
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('@deepseek-ai/') && context.parentURL?.includes('/profiles/web/node_modules/@qianhaoq/dsh-dota2ai/')) {
        return next(pathToFileURL(host.resolve(specifier)).href, context);
      }
      return next(specifier, context);
    },
  });
  const fromHost = async (id) => import(pathToFileURL(host.resolve(id)).href);
  const { Context } = await fromHost('@deepseek-ai/cordis');
  const Tools = (await fromHost('@deepseek-ai/dsh-tools')).default;
  const SystemPrompt = (await fromHost('@deepseek-ai/dsh-system-prompt')).default;
  const Skills = (await fromHost('@deepseek-ai/dsh-skill')).default;
  const profile = createRequire(join(home, 'profiles/web/package.json'));
  const plugin = await import(pathToFileURL(profile.resolve('@qianhaoq/dsh-dota2ai')).href);

  const ctx = new Context();
  new SystemPrompt(ctx, {});
  new Tools(ctx, {});
  ctx.plugin(Skills, {});
  if (live) process.env.DOTA2AI_INTERNAL = '1';
  fiber = ctx.plugin(plugin, { enabled: true, lang: 'en', apiBase: 'https://dota2.ai', skillEnabled: true });
  await fiber.inertia;

  const names = ['replay_review', 'recent_matches', 'coach_report', 'coach_cases', 'coach_ask', 'goal_check', 'hero_matchup'].map((n) => `dota2ai_${n}`);
  for (const n of names) assert.ok(ctx.tools.get(n), `${n} registered`);
  const call = (name, a) => ctx.tools.execute({ callId: `smoke-${name}`, name, arguments: a, signal: new AbortController().signal });

  const skill = await ctx.skills.get('dota2ai');
  assert.match(skill?.content ?? '', /dota2ai_replay_review/, 'the dota2ai skill is registered');
  assert.doesNotMatch(skill.content, /^---/, 'skill body without frontmatter');

  // Arguments are checked by DSH before anything leaves the machine.
  const bad = await call('dota2ai_coach_report', {});
  assert.equal(bad.isError, true, 'missing match_id is refused');

  if (live) {
    const roster = await call('dota2ai_coach_report', { match_id: 9100904020 });
    assert.equal(roster.isError, false, JSON.stringify(roster));
    assert.equal(roster.value.roster.length, 10);
    const matchup = await call('dota2ai_hero_matchup', { hero: 'tidehunter', vs: 'ursa' });
    assert.equal(matchup.isError, false, JSON.stringify(matchup));
    assert.ok(matchup.value.lines?.en?.length, 'matchup lines');
    const review = await call('dota2ai_replay_review', { match_id: 9100904020, hero: 'beastmaster', lang: 'en' });
    assert.equal(review.isError, false, JSON.stringify(review));
    console.log(`replay_review status: ${review.value.status}`);
  }
  await fiber.restart();
  assert.ok(ctx.tools.get('dota2ai_replay_review'), 'tools come back after a reload');
  console.log(`DSH install, composed profile, Config under DSH resolution, ${names.length} tools, the skill, argument check${live ? ', live calls' : ''} and reload passed`);
} finally {
  await fiber?.dispose();
  rmSync(home, { recursive: true, force: true });
}
