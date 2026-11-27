#!/usr/bin/env node
// A real review through a real DSH, on a real model — what a user gets after following the home page's steps.
// Installs the archive into a fresh DSH_HOME, boots `dsh web` with the caller's DEEPSEEK_API_KEY (DSH's own
// default credential), and drives the plugin over DSH's authenticated web RPC the way its panel does:
// availability → prepare (the site's parsed trace) → review on the DSH model → evidence → the tool answer.
// `--browser` also opens the panel's review page in headless Chromium and saves a screenshot.
//
// Spends the key's account: one deep review (a few hundred thousand input tokens). Marked internal on dota2.ai.
//
//   DEEPSEEK_API_KEY=… node packages/dsh/scripts/live-review.mjs <archive.tgz> --dsh <@deepseek-ai/dsh>/lib/bin.js \
//     [--match 9100904020] [--hero beastmaster] [--lang zh] [--browser <screenshot dir>] [--home <DSH_HOME to keep>]
// `--home`: use (and keep) this DSH_HOME; a second run finds its review there and spends nothing.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : fallback);
const archive = resolve(args[0] ?? '');
const cli = opt('--dsh', null) && resolve(opt('--dsh'));
const matchId = opt('--match', '9100904020');
const hero = opt('--hero', 'beastmaster');
const lang = opt('--lang', 'zh');
const shots = opt('--browser', null);
const keptHome = opt('--home', null);
if (!archive.endsWith('.tgz') || !cli || !process.env.DEEPSEEK_API_KEY) {
  console.error('usage: DEEPSEEK_API_KEY=… live-review.mjs <archive.tgz> --dsh <dsh bin.js> [--match id] [--hero key] [--lang zh|en] [--browser dir]');
  process.exit(2);
}

const redact = (text) => String(text ?? '')
  .replace(/([?&]token=)[^&\s"'<>]+/gi, '$1[REDACTED]')
  .replace(/((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
  .replace(/sk-[A-Za-z0-9]{8,}/g, 'sk-[REDACTED]');
const t0 = Date.now();
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${msg}`);

const home = keptHome ? resolve(keptHome) : mkdtempSync(join(tmpdir(), 'dsh-dota2ai-live-'));
const env = { ...process.env, DSH_HOME: home, DOTA2AI_INTERNAL: '1' };
let child = null;
try {
  try { execFileSync(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', archive], { env, stdio: 'pipe' }); } catch (e) {
    // Already installed in a kept home: fine.
    if (!keptHome) throw new Error(redact(String(e.stderr ?? e)));
  }
  log(`installed ${archive.split('/').pop()} on dsh ${execFileSync(process.execPath, [cli, '--version'], { env, encoding: 'utf8' }).trim()}`);

  child = spawn(process.execPath, [cli, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  const startupUrl = await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`dsh web did not start:\n${redact(logs)}`)), 60_000);
    const on = (b) => { logs += b; const m = logs.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s"'<>]+/); if (m) { clearTimeout(timer); ok(m[0]); } };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.once('exit', (code) => { clearTimeout(timer); fail(new Error(`dsh web exited (${code}):\n${redact(logs)}`)); });
  });
  await new Promise((r) => setTimeout(r, 1500));
  const origin = new URL(startupUrl).origin;
  const auth = await fetch(startupUrl, { redirect: 'manual' });
  const cookie = auth.headers.getSetCookie().map((c) => c.split(';', 1)[0]).join('; ');
  assert.ok(cookie.includes('='), 'dsh web session cookie');
  log('dsh web up');

  let rpcN = 0;
  /** One `/api/*` request to the plugin, as its panel sends it (`dota2ai/request`). */
  const api = async (method, url, body) => {
    const rpcId = `live-${++rpcN}`;
    const res = await fetch(`${origin}/api/dota2ai/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'dota2ai/request', payload: { args: { req: { method, url, ...(body ? { body: JSON.stringify(body) } : {}) } } } }),
    });
    const json = await res.json();
    assert.equal(json.result?.ok, true, `${method} ${url}: ${redact(JSON.stringify(json))}`);
    return json.result.value;
  };

  const avail = (await api('GET', `/api/agent/${matchId}`)).body;
  log(`availability: trace=${Boolean(avail.trace)} model_configured=${avail.model_configured} models=${(avail.models ?? []).map((m) => m.id ?? m).join(',') || '-'}`);
  assert.equal(avail.model_configured, true, 'DSH offers the plugin a model (DEEPSEEK_API_KEY)');

  if (!avail.trace) {
    const p = await api('POST', `/api/agent/${matchId}/prepare`, {});
    log(`prepare -> ${p.status} ${JSON.stringify(p.body).slice(0, 120)}`);
    for (let i = 0; ; i++) {
      const a = (await api('GET', `/api/agent/${matchId}`)).body;
      if (a.trace) break;
      assert.ok(i < 400 && a.parse?.status !== 'failed', `trace never arrived: ${JSON.stringify(a.parse)}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    log('trace ready');
  }

  const started = Date.now();
  const s = await api('POST', `/api/agent/${matchId}/review`, { hero, lang });
  // Already in a kept home: nothing is spent.
  log(`review start -> HTTP ${s.status} ${s.body.status}`);
  let state;
  for (let i = 0; ; i++) {
    state = (await api('GET', `/api/agent/${matchId}/review?hero=${hero}&lang=${lang}`)).body;
    if (state.status === 'ready' || state.status === 'failed' || state.status === 'unavailable') break;
    if (i % 10 === 0) log(`  ${state.status} steps=${state.steps?.length ?? 0}`);
    assert.ok(Date.now() - started < 25 * 60_000, 'review finished within 25 min');
    await new Promise((r) => setTimeout(r, 3000));
  }
  assert.equal(state.status, 'ready', `review: ${JSON.stringify(state).slice(0, 400)}`);
  const r = state.review;
  log(`review ready in ${((Date.now() - started) / 1000).toFixed(0)} s — model=${state.model} tools=${state.tool_calls} dropped=${state.verification?.dropped ?? 0} findings=${r.findings.length}`);
  log(`  verdict: ${r.verdict}`);
  for (const f of r.findings) log(`  · ${f.title} (${(f.evidence ?? []).length} evidence)`);
  assert.ok(r.findings.length > 0 && r.verdict, 'a verdict and findings');

  const ref = r.findings.flatMap((f) => f.evidence ?? []).flatMap((e) => e.refs ?? [])[0];
  if (ref) {
    const ev = await api('GET', `/api/agent/${matchId}/evidence?hero=${hero}&lang=${lang}&ref=${encodeURIComponent(ref)}`);
    assert.equal(ev.status, 200, `evidence ${ref}`);
    log(`evidence ${ref} -> ok`);
  }

  if (shots) {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(startupUrl, { waitUntil: 'domcontentloaded' });
      for (let step = 0; step < 3; step += 1) {
        const dialog = page.locator('[role="dialog"]').first();
        if (!(await dialog.waitFor({ state: 'visible', timeout: step === 0 ? 5000 : 2000 }).then(() => true, () => false))) break;
        await dialog.locator('button[aria-label="Close"], button[aria-label="关闭"], button:has-text("Continue"), button:has-text("继续"), button:has-text("Configure later"), button:has-text("稍后")').first().click({ timeout: 5000 }).catch(() => page.keyboard.press('Escape'));
      }
      await page.getByRole('button', { name: 'dota2.ai' }).or(page.locator('[title="dota2.ai"], [aria-label="dota2.ai"]')).first().click({ timeout: 20_000 });
      await page.waitForTimeout(2000);
      await page.screenshot({ path: join(shots, 'dsh-panel-home.png') });
      // The panel's own language toggle, then the match, then the hero: what a reader does.
      await page.getByRole('button', { name: lang === 'zh' ? '中文' : lang === 'ru' ? 'RU' : 'EN', exact: true }).first().click();
      const box = page.locator('.hm-ford input').first();
      await box.fill(matchId);
      await box.press('Enter');
      // The roster is known once the trace is there (the first availability may predate it).
      const h = (await api('GET', `/api/agent/${matchId}`)).body.heroes.find((x) => x.hero === hero);
      assert.ok(h, `${hero} is in the game`);
      await page.locator('.ag-pick button', { hasText: lang === 'zh' ? h.zh : h.en }).first().click({ timeout: 30_000 });
      await page.getByText(r.verdict.slice(0, 12)).first().waitFor({ timeout: 60_000 });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(shots, 'dsh-panel-review.png'), fullPage: false });
      assert.deepEqual(errors, [], 'no page errors');
      log(`panel shows the review; screenshots in ${shots}`);
    } finally { await browser.close(); }
  }
  log('PASS');
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => { const t = setTimeout(() => { child.kill('SIGKILL'); r(); }, 5000); child.once('exit', () => { clearTimeout(t); r(); }); }); }
  if (!keptHome) rmSync(home, { recursive: true, force: true });
}
