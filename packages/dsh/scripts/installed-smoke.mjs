// Install the release archive into a clean DSH profile through DSH's own CLI and
// check what a real DSH session gets:
//   1. DSH composes the web profile (both host & client bundles), reads Config under
//      DSH's runtime module resolution (--dump-config / --dump-config-schema), and
//      validates the shipped `./typert` artifact with DSH's real `validateTypertManifest()`;
//   2. the installed plugin, loaded in a Cordis context where @deepseek-ai/* come from
//      the DSH installation and the Typert manifest is registered by the host harness
//      (never manually by the plugin), registers its 7 tools, skill, and `Dota2AiRemote`
//      service, streams against a mock host `ctx.llm`, refuses bad arguments, and
//      survives `fiber.restart()`;
//   3. boots a real `dsh web --no-open --host 127.0.0.1 --port 0` profile by default,
//      asserts zero Typert loader / duplicate-registration / plugin activation errors,
//      authenticates via the startup URL (redacting tokens & cookies from logs), verifies
//      the client bootstrap includes `@qianhaoq/dsh-dota2ai`, calls real authenticated
//      HTTP RPCs (`dota2ai/getProfile`, `dota2ai/saveProfile`, `dota2ai/request` -> `/api/patch`),
//      optionally runs headless Playwright UI checks (`--browser`), and verifies plugin
//      remove + re-add (`unmount/remount`) restores RPC capability cleanly.
//
// Usage:
//   node packages/dsh/scripts/installed-smoke.mjs <archive.tgz> --dsh <@deepseek-ai/dsh>/lib/bin.js [--live] [--browser]
// Needs Node >= 24.9 and pnpm on PATH (DSH installs plugins with pnpm).
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
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

/** Never allow launch tokens or session cookies into error messages or CI logs. */
function redactSecrets(text) {
  return String(text ?? '')
    .replace(/([?&]token=)[^&\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]');
}

function assertCleanWebLogs(rawLogs, stage) {
  const safe = redactSecrets(rawLogs);
  const fatalPatterns = [
    /typert-loader:/i,
    /already registered/i,
    /required plugins? did not activate/i,
    /did not activate/i,
    /EADDRINUSE/i,
  ];
  for (const pat of fatalPatterns) {
    assert.doesNotMatch(safe, pat, `unexpected DSH startup/runtime error (${stage}):\n${safe}`);
  }
}

async function authenticateWebSession(startupUrl) {
  const parsed = new URL(startupUrl);
  const origin = parsed.origin;
  const authRes = await fetch(startupUrl, { redirect: 'manual' });
  assert.ok(
    authRes.status === 303 || authRes.status === 302,
    `expected auth redirect from startup URL, got HTTP ${authRes.status}`,
  );
  const rawCookies = typeof authRes.headers.getSetCookie === 'function'
    ? authRes.headers.getSetCookie()
    : [authRes.headers.get('set-cookie')].filter(Boolean);
  assert.ok(rawCookies.length > 0, 'startup URL auth response must mint a session cookie');
  const cookieHeader = rawCookies.map((c) => c.split(';', 1)[0].trim()).filter(Boolean).join('; ');
  assert.ok(cookieHeader.includes('='), 'parsed non-empty session cookie pair');

  const indexRes = await fetch(`${origin}/`, {
    headers: { cookie: cookieHeader },
    redirect: 'manual',
  });
  assert.equal(indexRes.status, 200, `authenticated GET / returned HTTP ${indexRes.status}`);
  const indexHtml = await indexRes.text();
  return { origin, cookieHeader, indexHtml };
}

async function callWebRpc({ origin, cookieHeader, rpcId, method, rpcArgs }) {
  const endpointPath = `/api/${method}`;
  const res = await fetch(`${origin}${endpointPath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      cookie: cookieHeader,
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method,
      payload: { args: rpcArgs },
    }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, `RPC ${method} HTTP ${res.status}: ${redactSecrets(text)}`);
  const json = JSON.parse(text);
  assert.equal(json.type, 'server-response', `RPC ${method} envelope type`);
  assert.equal(json.rpcId, rpcId, `RPC ${method} correlation id`);
  assert.equal(json.result?.ok, true, `RPC ${method} failed: ${redactSecrets(text)}`);
  return json.result.value;
}

async function withDshWeb({ env, label }, fn) {
  const child = spawn(process.execPath, [cli, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  try {
    const startupUrl = await new Promise((resolveUrl, rejectUrl) => {
      const timer = setTimeout(() => {
        rejectUrl(new Error(`Timed out waiting for dsh web (${label}) to listen.\n${redactSecrets(logs)}`));
      }, 45_000);
      const onChunk = (buf) => {
        logs += buf.toString('utf8');
        const m = logs.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s"'<>]+/) ?? logs.match(/https?:\/\/127\.0\.0\.1:\d+\S*/);
        if (m) {
          clearTimeout(timer);
          resolveUrl(m[0]);
        }
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);
      child.once('exit', (code) => {
        clearTimeout(timer);
        rejectUrl(new Error(`dsh web (${label}) exited early (${code}):\n${redactSecrets(logs)}`));
      });
    });

    // Allow asynchronous Cordis & typert-loader microtasks/imports to settle after URL print.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(child.exitCode, null, `dsh web (${label}) stayed alive after startup:\n${redactSecrets(logs)}`);
    assertCleanWebLogs(logs, `${label}:post-start`);

    const result = await fn({ startupUrl, getLogs: () => logs });
    assertCleanWebLogs(logs, `${label}:post-rpc`);
    return result;
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((r) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          r();
        }, 5_000);
        child.once('exit', () => {
          clearTimeout(t);
          r();
        });
      });
    }
  }
}

const home = mkdtempSync(join(tmpdir(), 'dsh-dota2ai-smoke-'));
const env = { ...process.env, DSH_HOME: home };
const dsh = (...a) => execFileSync(process.execPath, [cli, ...a], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
let fiber;
let disposeTypert;
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
  assert.doesNotMatch(dump.stderr, /dota2ai/, `no DSH diagnostic about the plugin:\n${redactSecrets(dump.stderr)}`);

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

  // Validate the packed `./typert` manifest with the target DSH host's real `validateTypertManifest()`.
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
  const { validateTypertManifest } = await fromHost('@deepseek-ai/dsh-typert-loader');
  const installedTypertMod = await import(pathToFileURL(installedTypert).href);
  const validatedManifest = validateTypertManifest('@qianhaoq/dsh-dota2ai', installedTypertMod.TYPERT);
  assert.equal(validatedManifest.package, '@qianhaoq/dsh-dota2ai');
  assert.deepEqual(validatedManifest.model.services[0].types, [], 'service.types is a validated array');
  assert.deepEqual(
    validatedManifest.invocations.map((d) => d.id),
    [
      '@qianhaoq/dsh-dota2ai#dota2ai/request',
      '@qianhaoq/dsh-dota2ai#dota2ai/stream',
      '@qianhaoq/dsh-dota2ai#dota2ai/getProfile',
      '@qianhaoq/dsh-dota2ai#dota2ai/saveProfile',
    ],
    'all 4 RPC invocation descriptors pass DSH typert-loader validation',
  );

  // 2. Isolated Cordis context for deterministic MockLlm streaming & tool execution.
  // Manifest registration is owned by the host harness (matching `typert-loader` in GUI profiles).
  const { Context, Service } = await fromHost('@deepseek-ai/cordis');
  const Tools = (await fromHost('@deepseek-ai/dsh-tools')).default;
  const SystemPrompt = (await fromHost('@deepseek-ai/dsh-system-prompt')).default;
  const Skills = (await fromHost('@deepseek-ai/dsh-skill')).default;
  const TypertMod = await fromHost('@deepseek-ai/dsh-typert-registry');
  const Typert = TypertMod.default ?? TypertMod.TypertRegistryService;
  const plugin = await import(pathToFileURL(installedMain).href);

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
  if (Typert) {
    const typertFiber = ctx.plugin(Typert, {});
    await typertFiber.inertia;
    disposeTypert = ctx.typert.register(validatedManifest);
  }
  new MockLlm(ctx);
  new MockDefaultModel(ctx);

  if (live) process.env.DOTA2AI_INTERNAL = '1';
  fiber = ctx.plugin(plugin, { enabled: true, lang: 'en', apiBase: 'https://dota2.ai', skillEnabled: true });
  await fiber.inertia;
  await new Promise((r) => setTimeout(r, 50));

  const names = ['replay_review', 'recent_matches', 'coach_report', 'coach_cases', 'coach_ask', 'goal_check', 'hero_matchup'].map((n) => `dota2ai_${n}`);
  for (const n of names) assert.ok(ctx.tools.get(n), `${n} registered`);
  // DSH 0.2.2 dispatches tool calls as batches through a loaded executor (dsh-tool-executor-native, which a
  // real profile composes); 0.2.1 executes one call directly. Same result either way.
  const Native = await fromHost('@deepseek-ai/dsh-tool-executor-native').catch(() => null);
  if (Native) { const nativeFiber = ctx.plugin(Native.default ?? Native, {}); await nativeFiber.inertia; }
  const call = async (name, a) => {
    const signal = new AbortController().signal;
    if (!Native) return ctx.tools.execute({ callId: `smoke-${name}`, name, arguments: a, signal });
    const out = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: `smoke-${name}`, name, arguments: JSON.stringify(a) }], signal });
    return out.results[0].result;
  };

  const skill = await ctx.skills.get('dota2ai');
  assert.match(skill?.content ?? '', /dota2ai_replay_review/, 'the dota2ai skill is registered');
  assert.doesNotMatch(skill.content, /^---/, 'skill body without frontmatter');

  const localMatchup = await call('dota2ai_hero_matchup', { hero: 'tidehunter', vs: 'ursa' });
  assert.equal(localMatchup.isError, false, JSON.stringify(localMatchup));
  assert.ok(localMatchup.value.lines?.en?.length, 'offline matchup lines from bundled snapshots');

  const remoteSvc = ctx.get('dota2ai');
  assert.ok(remoteSvc, 'Dota2AiRemote mounted on Cordis context');
  assert.ok(ctx.typert.local.get('dota2ai/request'), 'dota2ai/request registered in Typert');
  assert.ok(ctx.typert.local.get('dota2ai/stream'), 'dota2ai/stream registered in Typert');
  assert.ok(ctx.typert.local.get('dota2ai/getProfile'), 'dota2ai/getProfile registered in Typert');
  assert.ok(ctx.typert.local.get('dota2ai/saveProfile'), 'dota2ai/saveProfile registered in Typert');
  const patchOverview = await remoteSvc.request({ method: 'GET', url: '/api/patch?lang=en' });
  assert.equal(patchOverview.status, 200);
  assert.equal(patchOverview.body.advisor, true, 'patch overview sees mock DSH host model');

  const streamFrames = [];
  for await (const frame of remoteSvc.stream({ method: 'POST', url: '/api/patch/chat', body: JSON.stringify({ lang: 'en', question: 'How is Beastmaster?' }) })) {
    streamFrames.push(frame);
  }
  assert.equal(streamFrames.at(-1)?.done, true, 'patch advisor stream completes cleanly');
  assert.ok(streamFrames.some((f) => typeof f.text === 'string' && f.text.includes('Beastmaster')), 'patch advisor streamed answer from host llm');

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
  disposeTypert?.();
  disposeTypert = null;

  // 3. Default real `dsh web --port 0` profile boot + authenticated HTTP RPC verification
  // (plus headless Playwright UI verification when `--browser` is passed).
  await withDshWeb({ env, label: 'initial-boot' }, async ({ startupUrl }) => {
    const { origin, cookieHeader, indexHtml } = await authenticateWebSession(startupUrl);
    assert.match(indexHtml, /@qianhaoq\/dsh-dota2ai/, 'authenticated index HTML bootstrap includes @qianhaoq/dsh-dota2ai client plugin');

    const initialProfile = await callWebRpc({
      origin,
      cookieHeader,
      rpcId: 'verify-profile',
      method: 'dota2ai/getProfile',
      rpcArgs: {},
    });
    for (const key of ['accountId', 'reviewed', 'seenUntil', 'goal', 'goalChecks']) {
      assert.ok(Object.hasOwn(initialProfile, key), `dota2ai/getProfile includes "${key}"`);
    }

    const updatedProfile = await callWebRpc({
      origin,
      cookieHeader,
      rpcId: 'verify-save-profile',
      method: 'dota2ai/saveProfile',
      rpcArgs: { patch: { accountId: '86745912', reviewed: ['9100904020'] } },
    });
    assert.equal(updatedProfile.accountId, '86745912');
    assert.deepEqual(updatedProfile.reviewed, ['9100904020']);

    const patchRpc = await callWebRpc({
      origin,
      cookieHeader,
      rpcId: 'verify-patch',
      method: 'dota2ai/request',
      rpcArgs: { req: { url: '/api/patch' } },
    });
    assert.equal(patchRpc.status, 200, 'dota2ai/request /api/patch inner status 200');
    assert.ok(patchRpc.body && typeof patchRpc.body === 'object' && Object.keys(patchRpc.body).length > 0, 'dota2ai/request /api/patch body non-empty');

    if (browserCheck) {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const pageErrors = [];
        page.on('pageerror', (err) => pageErrors.push(err.message));

        await page.goto(startupUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        const navBtn = page.getByRole('button', { name: 'dota2.ai' }).or(page.locator('[title="dota2.ai"], [aria-label="dota2.ai"]')).first();
        await navBtn.waitFor({ state: 'visible', timeout: 20_000 });

        // On a fresh DSH_HOME, DSH shows its first-run Preview Notice ("Continue") followed by
        // SignInDialog ("Close" / Escape) or API-key dialog ("Configure later"). Dismiss them cleanly.
        for (let step = 0; step < 3; step += 1) {
          const dialog = page.locator('[role="dialog"]').first();
          const shown = await dialog.waitFor({ state: 'visible', timeout: step === 0 ? 4_000 : 2_000 }).then(() => true, () => false);
          if (!shown) break;
          const actionBtn = dialog.locator(
            'button[aria-label="Close"], button[aria-label="关闭"], button:has-text("Continue"), button:has-text("继续"), button:has-text("Configure later"), button:has-text("稍后")',
          ).first();
          if (await actionBtn.waitFor({ state: 'visible', timeout: 2_000 }).then(() => true, () => false)) {
            await actionBtn.click({ timeout: 5_000 });
          } else {
            await page.keyboard.press('Escape');
          }
          await page.waitForTimeout(300);
        }
        await page.locator('[role="dialog"]').first().waitFor({ state: 'hidden', timeout: 5_000 });
        await navBtn.click();

        const panel = page.getByTestId('dota2ai-dsh-panel');
        await panel.waitFor({ state: 'visible', timeout: 15_000 });
        const searchInput = panel.locator('input, [role="textbox"]').first();
        await searchInput.waitFor({ state: 'visible', timeout: 10_000 });
        assert.equal(await panel.locator('.hm-ways').count(), 0, 'web install instructions hidden in DSH panel');
        assert.equal(await panel.locator('.hm-feedback').count(), 0, 'web feedback form hidden in DSH panel');
        // Submit match ID 9100904020 in the embedded SPA to verify in-panel /r/:matchId routing without page errors.
        await searchInput.fill('9100904020');
        await searchInput.press('Enter');
        await page.waitForTimeout(500);
        assert.deepEqual(pageErrors, [], `no browser pageerror:\n${pageErrors.join('\n')}`);
      } finally {
        await browser.close();
      }
    }
  });

  // 4. Unmount (`plugin remove`) & remount (`plugin add`) verification: confirm clean removal
  // and full RPC recovery on a fresh `dsh web` boot with zero duplicate-registration errors.
  dsh('plugin', '--profile', 'web', 'remove', '@qianhaoq/dsh-dota2ai');
  assert.doesNotMatch(dsh('--profile', 'web', '--dump-config'), /@qianhaoq\/dsh-dota2ai/, 'plugin removed from composed web profile');
  dsh('plugin', '--profile', 'web', 'add', archive);
  assert.match(dsh('--profile', 'web', '--dump-config'), /@qianhaoq\/dsh-dota2ai/, 'plugin re-added to composed web profile');

  await withDshWeb({ env, label: 'remount-boot' }, async ({ startupUrl }) => {
    const { origin, cookieHeader } = await authenticateWebSession(startupUrl);
    const remountProfile = await callWebRpc({
      origin,
      cookieHeader,
      rpcId: 'verify-profile-remount',
      method: 'dota2ai/getProfile',
      rpcArgs: {},
    });
    assert.equal(remountProfile.accountId, '86745912', 'persisted profile survives plugin remove + add');
    const remountPatch = await callWebRpc({
      origin,
      cookieHeader,
      rpcId: 'verify-patch-remount',
      method: 'dota2ai/request',
      rpcArgs: { req: { url: '/api/patch' } },
    });
    assert.equal(remountPatch.status, 200, 'RPC capability restored after remount');
  });

  console.log(
    `DSH install, typert-loader manifest validation, ${names.length} tools, skill, real dsh web RPCs (getProfile/saveProfile/request), unmount+remount${live ? ', live calls' : ''}${browserCheck ? ', Playwright UI' : ''} passed`,
  );
} finally {
  await fiber?.dispose();
  disposeTypert?.();
  rmSync(home, { recursive: true, force: true });
}
