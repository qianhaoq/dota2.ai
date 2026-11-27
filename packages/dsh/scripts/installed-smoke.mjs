// Install the release archive into a clean DSH profile through DSH's own CLI and
// check what a real DSH session gets:
//   1. DSH composes the web profile (both host & client bundles) and reads Config
//      under DSH's runtime module resolution (--dump-config / --dump-config-schema);
//   2. the installed plugin, loaded in a Cordis context where @deepseek-ai/* come
//      from the DSH installation, registers its 7 tools, skill, and `Dota2AiRemote`
//      Typert service, runs local requests & streams against a mock host `ctx.llm`,
//      refuses bad arguments, and survives `fiber.restart()`;
//   3. (--browser) boots `dsh web --no-open` and uses Playwright Chromium to click
//      the `dota2.ai` sidebar entry, verify the standalone page renders without
//      errors or web-only install blocks, and navigate to `/r/9100904020`.
//
// Usage:
//   node packages/dsh/scripts/installed-smoke.mjs <archive.tgz> --dsh <@deepseek-ai/dsh>/lib/bin.js [--live] [--browser]
// Needs Node >= 24.9 and pnpm on PATH (DSH installs plugins with pnpm).
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const archive = resolve(args.find((a) => a.endsWith('.tgz')) ?? '');
const cli = args.indexOf('--dsh') >= 0 ? resolve(args[args.indexOf('--dsh') + 1]) : null;
const live = args.includes('--live');
const browserCheck = args.includes('--browser');
if (!archive.endsWith('.tgz') || !cli) {
  console.error('usage: installed-smoke.mjs <archive.tgz> --dsh <dsh bin.js> [--live] [--browser]');
  process.exit(2);
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close((err) => (err ? reject(err) : resolvePort(port)));
    });
    srv.on('error', reject);
  });
}

const home = mkdtempSync(join(tmpdir(), 'dsh-dota2ai-smoke-'));
const env = { ...process.env, DSH_HOME: home };
const dsh = (...a) => execFileSync(process.execPath, [cli, ...a], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
let fiber;
try {
  dsh('plugin', '--profile', 'web', 'add', archive);

  // 1. The real host: both host and client entries are composed into the web profile, and Config loads cleanly.
  const composed = dsh('--profile', 'web', '--dump-config');
  assert.match(composed, /@qianhaoq\/dsh-dota2ai/, 'the bundle patch is in the composed profile');
  // The shipped web profile reports diagnostics of its own here (and exits 1): only ours matter.
  const dump = spawnSync(process.execPath, [cli, '--profile', 'web', '--dump-config-schema'], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const schemaStr = JSON.stringify(JSON.parse(dump.stdout));
  assert.match(schemaStr, /"apiBase":\{[^}]*"description":"dota2\.ai origin/, 'DSH loaded the plugin module and read its Config');
  assert.match(schemaStr, /"extractorBin":\{/, 'Config exposes extractorBin');
  assert.doesNotMatch(dump.stderr, /dota2ai/, `no DSH diagnostic about the plugin:\n${dump.stderr}`);

  // Verify shipped subpath artifacts exist in the installed profile.
  const profile = createRequire(join(home, 'profiles/web/package.json'));
  const installedMain = profile.resolve('@qianhaoq/dsh-dota2ai');
  const installedClient = profile.resolve('@qianhaoq/dsh-dota2ai/client');
  const installedTypert = profile.resolve('@qianhaoq/dsh-dota2ai/typert');
  const installedRemote = profile.resolve('@qianhaoq/dsh-dota2ai/remote');
  for (const f of [installedMain, installedClient, installedTypert, installedRemote]) {
    assert.ok(existsSync(f), `installed artifact exists: ${f}`);
  }
  assert.match(readFileSync(installedClient, 'utf8'), /window\.__ModuleLoader__\.load\(\{ id: "@qianhaoq\/dsh-dota2ai"/);

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
  const { Context, Service } = await fromHost('@deepseek-ai/cordis');
  const Tools = (await fromHost('@deepseek-ai/dsh-tools')).default;
  const SystemPrompt = (await fromHost('@deepseek-ai/dsh-system-prompt')).default;
  const Skills = (await fromHost('@deepseek-ai/dsh-skill')).default;
  const TypertMod = await fromHost('@deepseek-ai/dsh-typert-registry');
  const Typert = TypertMod.default ?? TypertMod.TypertRegistryService;
  const plugin = await import(pathToFileURL(installedMain).href);

  // Mock host `llm` + `agentDefaultModel` services so we exercise local Host-LLM calls in Cordis!
  class MockLlm extends Service {
    constructor(c) {
      super(c, 'llm', true);
    }
    listProviders() {
      return [{ id: 'deepseek', name: 'DeepSeek' }];
    }
    async listModels() {
      return [{ id: 'deepseek-chat', name: 'DeepSeek V3' }];
    }
    async resolveModelInfo() {
      return { defaultMaxTokens: 8192 };
    }
    async prepareCall(config) {
      return {
        config,
        async *stream() {
          yield { type: 'text-delta', index: 0, text: 'Beastmaster works cleanly on patch 7.42.' };
          yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 10 } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      };
    }
  }
  class MockDefaultModel extends Service {
    constructor(c) {
      super(c, 'agentDefaultModel', true);
    }
    currentSelection() {
      return { provider: 'deepseek', model: 'deepseek-chat' };
    }
  }

  const ctx = new Context();
  new SystemPrompt(ctx, {});
  new Tools(ctx, {});
  ctx.plugin(Skills, {});
  if (Typert) ctx.plugin(Typert, {});
  new MockLlm(ctx);
  new MockDefaultModel(ctx);

  if (live) process.env.DOTA2AI_INTERNAL = '1';
  fiber = ctx.plugin(plugin, { enabled: true, lang: 'en', apiBase: 'https://dota2.ai', skillEnabled: true });
  await fiber.inertia;
  await new Promise((r) => setTimeout(r, 50));

  const names = ['replay_review', 'recent_matches', 'coach_report', 'coach_cases', 'coach_ask', 'goal_check', 'hero_matchup'].map((n) => `dota2ai_${n}`);
  for (const n of names) assert.ok(ctx.tools.get(n), `${n} registered`);
  const call = (name, a) => ctx.tools.execute({ callId: `smoke-${name}`, name, arguments: a, signal: new AbortController().signal });

  const skill = await ctx.skills.get('dota2ai');
  assert.match(skill?.content ?? '', /dota2ai_replay_review/, 'the dota2ai skill is registered');
  assert.doesNotMatch(skill.content, /^---/, 'skill body without frontmatter');

  // Local hero_matchup works completely offline from bundled patch snapshots!
  const localMatchup = await call('dota2ai_hero_matchup', { hero: 'tidehunter', vs: 'ursa' });
  assert.equal(localMatchup.isError, false, JSON.stringify(localMatchup));
  assert.ok(localMatchup.value.lines?.en?.length, 'offline matchup lines from bundled snapshots');

  // Verify Typert Remote service (`ctx.dota2ai`) and Typert registry endpoints work for page requests, streams, and profile sync!
  const remoteSvc = ctx.get('dota2ai');
  assert.ok(remoteSvc, 'Dota2AiRemote mounted on Cordis context');
  assert.ok(ctx.typert.local.get('dota2ai/request'), 'dota2ai/request registered in Typert');
  assert.ok(ctx.typert.local.get('dota2ai/stream'), 'dota2ai/stream registered in Typert');
  const patchOverview = await remoteSvc.request({ method: 'GET', url: '/api/patch?lang=en' });
  assert.equal(patchOverview.status, 200);
  assert.equal(patchOverview.body.advisor, true, 'patch overview sees mock DSH host model');

  const savedProfile = await remoteSvc.saveProfile({ accountId: '86745912', reviewed: ['9100904020'] });
  assert.equal(savedProfile.accountId, '86745912');
  assert.deepEqual((await remoteSvc.getProfile()).reviewed, ['9100904020']);

  const streamFrames = [];
  for await (const frame of remoteSvc.stream({ method: 'POST', url: '/api/patch/chat', body: JSON.stringify({ lang: 'en', question: 'How is Beastmaster?' }) })) {
    streamFrames.push(frame);
  }
  assert.equal(streamFrames.at(-1)?.done, true, 'patch advisor stream completes cleanly');
  assert.ok(streamFrames.some((f) => typeof f.text === 'string' && f.text.includes('Beastmaster')), 'patch advisor streamed answer from host llm');

  // Arguments are checked by DSH before anything leaves the machine.
  const bad = await call('dota2ai_coach_report', {});
  assert.equal(bad.isError, true, 'missing match_id is refused');

  if (live) {
    const roster = await call('dota2ai_coach_report', { match_id: 9100904020 });
    assert.equal(roster.isError, false, JSON.stringify(roster));
    assert.equal(roster.value.roster.length, 10);
  }

  await fiber.restart();
  await fiber.inertia;
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(ctx.tools.get('dota2ai_replay_review'), 'tools come back after a reload');
  assert.ok(ctx.get('dota2ai'), 'Dota2AiRemote comes back after a reload');
  await fiber.dispose();
  fiber = null;

  // 3. Real `dsh web` + headless Playwright browser smoke check.
  if (browserCheck) {
    const { chromium } = await import('playwright');
    const port = await freePort();
    const child = spawn(process.execPath, [cli, 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let webUrl = null;
    let logs = '';
    try {
      webUrl = await new Promise((resolveUrl, rejectUrl) => {
        const timer = setTimeout(() => rejectUrl(new Error(`Timed out waiting for dsh web to listen. Output:\n${logs.replace(/token=[^&\s]+/g, 'token=[REDACTED]')}`)), 45_000);
        const onChunk = (buf) => {
          logs += buf.toString('utf8');
          const m = logs.match(/https?:\/\/127\.0\.0\.1:\d+\S*/);
          if (m) {
            clearTimeout(timer);
            resolveUrl(m[0]);
          }
        };
        child.stdout.on('data', onChunk);
        child.stderr.on('data', onChunk);
        child.once('exit', (code) => {
          clearTimeout(timer);
          rejectUrl(new Error(`dsh web exited early (${code})`));
        });
      });

      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const pageErrors = [];
        page.on('pageerror', (err) => pageErrors.push(err.message));

        await page.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        // Click our `dota2.ai` sidebar panel button!
        const navBtn = page.getByRole('button', { name: 'dota2.ai' }).or(page.locator('[title="dota2.ai"], [aria-label="dota2.ai"]')).first();
        await navBtn.waitFor({ state: 'visible', timeout: 20_000 });
        await navBtn.click();

        const panel = page.getByTestId('dota2ai-dsh-panel');
        await panel.waitFor({ state: 'visible', timeout: 15_000 });
        // Verify CoachHome rendered inside DSH without web-only install blocks (`<AccessModes>`) or page errors!
        await panel.locator('input, [role="textbox"]').first().waitFor({ state: 'visible', timeout: 10_000 });
        assert.equal(await panel.locator('.hm-ways').count(), 0, 'web install instructions hidden in DSH panel');
        assert.equal(await panel.locator('.hm-feedback').count(), 0, 'web feedback form hidden in DSH panel');
        assert.deepEqual(pageErrors, [], `no browser pageerror:\n${pageErrors.join('\n')}`);
      } finally {
        await browser.close();
      }
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => {
        const t = setTimeout(() => { child.kill('SIGKILL'); r(); }, 5000);
        child.once('exit', () => { clearTimeout(t); r(); });
      });
    }
  }

  console.log(`DSH install, composed profile, Config under DSH resolution, ${names.length} tools, skill, Typert Remote, offline snapshots${live ? ', live calls' : ''}${browserCheck ? ', real dsh web Playwright UI' : ''} and reload passed`);
} finally {
  await fiber?.dispose();
  rmSync(home, { recursive: true, force: true });
}
