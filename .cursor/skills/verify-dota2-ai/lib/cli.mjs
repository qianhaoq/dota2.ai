#!/usr/bin/env node
/**
 * Dota2.ai Tactical Coach V3 验证 CLI。
 * 只杀掉本 CLI 写入 state 的 PID；cleanup 不删除 evidence/。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  DEFAULT_API_PORT,
  DEFAULT_HOST,
  DEFAULT_VITE_PORT,
  EVIDENCE_DIR,
  LAST_RUN_PATH,
  REPO_ROOT,
  RUN_DIR,
  STATE_PATH,
  childEnv,
  ensureDir,
  findChrome,
  loadDotenv,
  readState,
  writeState,
} from './paths.mjs';
import {
  ariaDump,
  clickHandle,
  existsHandle,
  fillHandle,
  launchChrome,
  navigate,
  pageText,
  screenshotPng,
  waitFor,
  waitForText,
} from './cdp.mjs';

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg, code = 1) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}


function repoRevision() {
  try {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (head.status !== 0) return null;
    const sha = head.stdout.trim();
    const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const porcelain = dirty.status === 0 ? (dirty.stdout || '') : '';
    if (!porcelain.trim()) return sha;
    const diff = spawnSync('git', ['diff', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    const hash = createHash('sha256');
    hash.update(porcelain);
    hash.update('\n');
    hash.update(diff.status === 0 ? (diff.stdout || '') : '');
    // Untracked files are absent from `git diff HEAD`; hash their contents too.
    const untracked = spawnSync(
      'git',
      ['-c', 'core.quotepath=false', 'ls-files', '-z', '-o', '--exclude-standard'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    if (untracked.status === 0) {
      for (const rel of (untracked.stdout || '').split('\0').filter(Boolean)) {
        hash.update(rel);
        hash.update('\0');
        try { hash.update(fs.readFileSync(path.join(REPO_ROOT, rel))); } catch { hash.update('missing'); }
        hash.update('\n');
      }
    }
    return `${sha}+dirty:${hash.digest('hex').slice(0, 12)}`;
  } catch {
    return null;
  }
}

function launchEnvFingerprint() {
  const fromFile = loadDotenv();
  const deepseek = process.env.DEEPSEEK_API_KEY ?? fromFile.DEEPSEEK_API_KEY ?? '';
  const steam = process.env.STEAM_WEB_API_KEY ?? fromFile.STEAM_WEB_API_KEY ?? '';
  // Hash so state.json never stores raw secrets.
  return createHash('sha256')
    .update(`DEEPSEEK_API_KEY=${deepseek}\nSTEAM_WEB_API_KEY=${steam}`)
    .digest('hex')
    .slice(0, 12);
}



function requireValidState(state, { allowMissing = false } = {}) {
  if (!state) {
    if (allowMissing) return null;
    return null;
  }
  if (state.__invalidState) {
    fail(`refuse: malformed verifier state at ${STATE_PATH} (${state.parseError}). Delete ${STATE_PATH} / run cleanup after fixing, or remove the file manually if cleanup cannot parse it.`);
  }
  return state;
}

function nowId() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, text: body }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error(`timeout ${url}`)));
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: body }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error(`timeout ${url}`)));
  });
}


async function assertViteProxyTargetFree(apiPort, host, { ownedPids = null } = {}) {
  if (!(host === '127.0.0.1' || host === 'localhost')) return;
  // If we intentionally bound Express on ::1 via VERIFY_HOST=localhost, do not treat our own listener as conflict.
  if (host === 'localhost') return;
  if (!(await portFree(apiPort, '::1'))) {
    throw new Error(`[::1]:${apiPort} is in use (Vite localhost /api proxy may hit it)`);
  }
}

function portFree(port, host = DEFAULT_HOST) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    try {
      srv.listen({ port, host, ipv6Only: host === '::1' }, () => {
        srv.close(() => resolve(true));
      });
    } catch {
      resolve(false);
    }
  });
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}


function readBootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
  catch { return null; }
}

function readProcIdentity(pid) {
  if (!pid) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen < 0) return null;
    const after = stat.slice(closeParen + 2).trim().split(/\s+/);
    // fields after comm: state(1).. starttime is field 22 overall => index 19 in after (22-3)
    const starttime = after[19];
    let cmdline = '';
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } catch { /* ignore */ }
    return { pid: Number(pid), starttime, cmdline, bootId: readBootId() };
  } catch {
    return null;
  }
}

function pidEntryPid(entry) {
  if (entry == null) return null;
  if (typeof entry === 'number') return entry;
  if (typeof entry === 'object' && entry.pid != null) return Number(entry.pid);
  return null;
}

function killPid(entry, label) {
  const pid = pidEntryPid(entry);
  if (!pid || !pidAlive(pid)) return;
  const expected = (entry && typeof entry === 'object' && entry.starttime != null && entry.bootId)
    ? { starttime: String(entry.starttime), cmdline: entry.cmdline || '', bootId: String(entry.bootId) }
    : null;
  if (!expected) {
    log(`skip kill ${label} pid=${pid}: no identity token (refuse bare PID / missing bootId — possible reuse)`);
    return;
  }
  const live = readProcIdentity(pid);
  if (!live?.bootId || String(live.starttime) !== String(expected.starttime) || String(live.bootId) !== String(expected.bootId)) {
    log(`skip kill ${label} pid=${pid}: identity mismatch (possible PID reuse / reboot)`);
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  }
  const start = Date.now();
  while (Date.now() - start < 4000 && pidAlive(pid)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  if (pidAlive(pid)) {
    try { process.kill(-pid, 'SIGKILL'); } catch {
      try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    }
  }
  log(`stopped ${label} pid=${pid}`);
}

function spawnLogged(bin, args, logFile, env) {
  ensureDir(RUN_DIR);
  const fd = fs.openSync(logFile, 'w');
  const child = spawn(bin, args, {
    cwd: REPO_ROOT,
    env,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  fs.closeSync(fd);
  let identity = null;
  for (let i = 0; i < 20 && !identity?.starttime; i++) {
    identity = readProcIdentity(child.pid);
    if (identity?.starttime) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return identity || { pid: child.pid, starttime: null, cmdline: `${bin} ${args.join(' ')}` };
}

async function cmdLaunch() {
  if (!fs.existsSync(path.join(REPO_ROOT, 'node_modules'))) {
    fail('node_modules missing. From the repo root run: npm ci');
  }

  const mode = process.env.VERIFY_MODE === 'prod' ? 'prod' : 'dev';
  const host = process.env.VERIFY_HOST || DEFAULT_HOST;
  const apiPort = Number(process.env.VERIFY_API_PORT || (mode === 'prod' ? 18080 : DEFAULT_API_PORT));
  const vitePort = Number(process.env.VERIFY_VITE_PORT || DEFAULT_VITE_PORT);
  const runId = nowId();
  const requestedUiOrigin = mode === 'prod' ? `http://${host}:${apiPort}` : `http://${host}:${vitePort}`;
  const requestedApiOrigin = `http://${host}:${apiPort}`;

  const existing = readState();
  if (existing?.__invalidState) {
    log(`malformed state detected (${existing.parseError}); removing before relaunch`);
    await cmdCleanup({});
  }
  if (existing?.pids && !existing.__invalidState) {
    const doctor = await inspect(existing);
    if (doctor.ok) {
      const revision = repoRevision();
      const envFingerprint = launchEnvFingerprint();
      const sameNetwork = existing.mode === mode
        && existing.host === host
        && Number(existing.apiPort) === apiPort
        && Number(existing.vitePort) === (mode === 'prod' ? apiPort : vitePort)
        && existing.uiOrigin === requestedUiOrigin
        && existing.apiOrigin === requestedApiOrigin;
      const sameRevision = !revision ? true : existing.revision === revision;
      const sameEnv = !existing.envFingerprint || existing.envFingerprint === envFingerprint;
      if (sameNetwork && sameRevision && sameEnv) {
        log(`already running runId=${existing.runId} ui=${existing.uiOrigin} api=${existing.apiOrigin} revision=${existing.revision || 'unknown'}`);
        printDoctor(doctor);
        return;
      }
      if (sameNetwork && sameRevision && !sameEnv) {
        fail(`refuse to launch: healthy instance already running with a different launch env fingerprint (e.g. DEEPSEEK_API_KEY/.env changed). Run cleanup first, then relaunch.`);
      }
      if (sameNetwork && !sameRevision) {
        fail(`refuse to launch: healthy instance already running for revision ${existing.revision}, but workspace is now ${revision}. Run cleanup first so prod rebuild / fresh launch can serve the current code.`);
      }
      fail(`refuse to launch: healthy instance already running (mode=${existing.mode} ui=${existing.uiOrigin} api=${existing.apiOrigin}) but requested mode=${mode} ui=${requestedUiOrigin} api=${requestedApiOrigin}. Run cleanup first, or reuse the existing instance without overrides.`);
    }
    log('stale state detected; cleaning before relaunch');
    await cmdCleanup({ keepStateIfMissing: true });
  }

  if (mode === 'dev') {
    // vite.config.ts proxies /api to hard-coded localhost:8080 — custom host/port desync UI→API.
    const localhostHosts = new Set(['127.0.0.1', 'localhost']);
    if (process.env.VERIFY_HOST && !localhostHosts.has(host)) {
      fail(`refuse to launch: VERIFY_HOST=${host} is incompatible with VERIFY_MODE=dev (Vite proxies /api to localhost:${DEFAULT_API_PORT}). Use 127.0.0.1/localhost, or VERIFY_MODE=prod.`);
    }
    if (process.env.VERIFY_API_PORT && apiPort !== DEFAULT_API_PORT) {
      fail(`refuse to launch: VERIFY_API_PORT=${apiPort} is incompatible with VERIFY_MODE=dev (Vite proxies /api to localhost:${DEFAULT_API_PORT}). Use default ${DEFAULT_API_PORT}, or VERIFY_MODE=prod VERIFY_API_PORT=<free-port>.`);
    }
    if (!(await portFree(apiPort, host))) {
      fail(`refuse to launch: ${host}:${apiPort} is already in use. Do not drive a shared Express instance. Stop the other process or use VERIFY_MODE=prod VERIFY_API_PORT=<free-port>.`);
    }
    try { await assertViteProxyTargetFree(apiPort, host); }
    catch (err) { fail(`refuse to launch: ${err.message}. Free that listener or use VERIFY_MODE=prod.`); }
    if (!(await portFree(vitePort, host))) {
      fail(`refuse to launch: ${host}:${vitePort} is already in use. Do not attach to someone else's Vite session.`);
    }
  } else if (!(await portFree(apiPort, host))) {
    fail(`refuse to launch: ${host}:${apiPort} is already in use.`);
  }

  const env = childEnv({
    HOST: host,
    PORT: String(apiPort),
  });

  const pids = {};
  if (mode === 'prod') {
    log('VERIFY_MODE=prod: running npm run build');
    const build = spawn('npm', ['run', 'build'], { cwd: REPO_ROOT, env, stdio: 'inherit' });
    const code = await new Promise((resolve) => build.on('exit', resolve));
    if (code !== 0) fail('vite build failed');
    pids.express = spawnLogged(process.execPath, ['server.js'], path.join(RUN_DIR, 'express.log'), env);
  } else {
    const viteBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'vite');
    pids.express = spawnLogged(process.execPath, ['server.js'], path.join(RUN_DIR, 'express.log'), env);
    pids.vite = spawnLogged(viteBin, ['--host', host, '--port', String(vitePort), '--strictPort'], path.join(RUN_DIR, 'vite.log'), env);
  }

  const apiOrigin = `http://${host}:${apiPort}`;
  const uiOrigin = mode === 'prod' ? apiOrigin : `http://${host}:${vitePort}`;
  const state = {
    runId,
    mode,
    host,
    apiPort,
    vitePort: mode === 'prod' ? apiPort : vitePort,
    apiOrigin,
    uiOrigin,
    pids,
    revision: repoRevision(),
    envFingerprint: launchEnvFingerprint(),
    startedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
  };
  writeState(state);

  try {
    await waitFor(async () => {
      try {
        const health = await fetchJson(`${apiOrigin}/health`);
        return health.status === 200 && health.json?.status === 'healthy' ? health : null;
      } catch { return null; }
    }, { timeoutMs: 60000, label: `${apiOrigin}/health` });
    await waitFor(async () => {
      try {
        const page = await fetchText(uiOrigin);
        return page.status === 200 && /Dota2\.ai|id="root"/.test(page.text) ? page : null;
      } catch { return null; }
    }, { timeoutMs: 90000, label: `${uiOrigin} HTML` });
  } catch (err) {
    await cmdCleanup({});
    fail(`launch failed: ${err.message}`);
  }

  writeState(state);
  log(`launched runId=${runId} mode=${mode}`);
  log(`ui=${uiOrigin}`);
  log(`api=${apiOrigin}`);
  log(`state=${STATE_PATH}`);
  if (!env.DEEPSEEK_API_KEY) {
    log('note: DEEPSEEK_API_KEY is unset — AI SSE routes will error; shell/nav/journal/codex still driveable');
  }
}

async function inspect(state) {
  const report = {
    ok: false,
    runId: state?.runId || null,
    uiOrigin: state?.uiOrigin || null,
    apiOrigin: state?.apiOrigin || null,
    pids: {},
    health: null,
    apiHealth: null,
    ui: null,
    chrome: findChrome(),
    deepseekConfigured: null,
    errors: [],
  };
  if (!state) {
    report.errors.push(`no state at ${STATE_PATH} — run launch first`);
    return report;
  }
  const required = state.mode === 'prod' ? ['express'] : ['express', 'vite'];
  for (const [name, entry] of Object.entries(state.pids || {})) {
    if (name === 'chrome') continue; // leftover chrome from a prior drive is optional
    const pid = pidEntryPid(entry);
    let alive = pidAlive(pid);
    let identityOk = true;
    if (alive && entry && typeof entry === 'object' && entry.starttime != null && entry.bootId) {
      const live = readProcIdentity(pid);
      identityOk = Boolean(live?.bootId && String(live.starttime) === String(entry.starttime) && String(live.bootId) === String(entry.bootId));
      if (!identityOk) {
        alive = false;
        report.errors.push(`${name} pid ${pid} is alive but identity mismatch (possible PID reuse)`);
      }
    } else if (alive && required.includes(name)) {
      // Required service recorded without full identity — treat as unsafe / not ours.
      alive = false;
      identityOk = false;
      report.errors.push(`${name} pid ${pid} lacks identity token (refuse to trust — possible PID reuse)`);
    }
    report.pids[name] = { pid, alive, identityOk, identity: typeof entry === 'object' ? { starttime: entry.starttime, cmdline: entry.cmdline } : null };
    if (required.includes(name) && !alive && identityOk) {
      report.errors.push(`${name} pid ${pid} is not running`);
    }
  }
  try {
    report.health = await fetchJson(`${state.apiOrigin}/health`);
    if (report.health.status !== 200 || report.health.json?.status !== 'healthy') {
      report.errors.push(`/health not healthy: ${JSON.stringify(report.health)}`);
    }
  } catch (err) {
    report.errors.push(`/health ${err.message}`);
  }
  try {
    report.apiHealth = await fetchJson(`${state.apiOrigin}/api/health`);
    const apiJson = report.apiHealth.json;
    const apiOk = report.apiHealth.status === 200
      && apiJson
      && typeof apiJson === 'object'
      && typeof apiJson.apiKeyConfigured === 'boolean';
    if (!apiOk) {
      report.errors.push(`/api/health not ok: ${JSON.stringify(report.apiHealth)}`);
      report.deepseekConfigured = null;
    } else {
      report.deepseekConfigured = Boolean(apiJson.apiKeyConfigured);
    }
  } catch (err) {
    report.errors.push(`/api/health ${err.message}`);
  }
  try {
    const page = await fetchText(state.uiOrigin);
    report.ui = { status: page.status, title: /<title>([^<]+)<\/title>/.exec(page.text)?.[1] || null };
    if (page.status !== 200) report.errors.push(`UI HTTP ${page.status}`);
  } catch (err) {
    report.errors.push(`UI ${err.message}`);
  }
  if (state.mode !== 'prod') {
    try {
      await assertViteProxyTargetFree(Number(state.apiPort), state.host || DEFAULT_HOST);
    } catch (err) {
      report.errors.push(err.message);
    }
  }
  report.ok = report.errors.length === 0;
  return report;
}

function printDoctor(report) {
  log(JSON.stringify({
    ok: report.ok,
    runId: report.runId,
    uiOrigin: report.uiOrigin,
    apiOrigin: report.apiOrigin,
    pids: report.pids,
    health: report.health?.json || report.health,
    apiKeyConfigured: report.deepseekConfigured,
    provider: report.apiHealth?.json?.provider || null,
    ui: report.ui,
    chrome: report.chrome,
    errors: report.errors,
  }, null, 2));
}

async function cmdDoctor() {
  const state = readState();
  if (state?.__invalidState) {
    fail(`malformed verifier state at ${STATE_PATH} (${state.parseError}). Run cleanup to remove it.`);
  }
  const report = await inspect(state);
  printDoctor(report);
  if (!report.ok) process.exit(2);
}


/** Product default is English; Chinese recipes toggle once via inverted aria-label. */
async function ensureZh(cdp) {
  const text = await pageText(cdp);
  if (text.includes('战术室') || text.includes('把下一次判断')) return;
  await clickHandle(cdp, { role: 'button', name: '切换语言' });
  await waitForText(cdp, '战术室');
}

const FEATURES = {
  'tactical-room-entry': {
    title: '战术室入口',
    needsDeepseek: false,
    async run(cdp) {
      const shots = {};
      await waitForText(cdp, 'Make the next call');
      await ensureZh(cdp);
      await waitForText(cdp, '把下一次判断');
      shots.landing = 'landing.png';
      await screenshotPng(cdp, shots.landing);
      const landing = await pageText(cdp);
      for (const snippet of [
        '把下一次判断',
        '练得更好。',
        '刚打完，复盘一局',
        '准备开局，推演阵容',
        '想变强，练一次判断',
        '这里没有虚构的胜率、段位或成长分',
        '战术室',
        'DOTA2.AI',
      ]) {
        if (!landing.includes(snippet)) throw new Error(`landing missing ${JSON.stringify(snippet)}`);
      }
      await clickHandle(cdp, { role: 'button', textIncludes: '刚打完，复盘一局' });
      await waitForText(cdp, '先还原你当时掌握的信息。');
      const review = await pageText(cdp);
      if (!review.includes('复盘一局')) throw new Error('review workspace missing 复盘一局');
      if (!review.includes('TACTICAL REVIEW')) throw new Error('review workspace missing TACTICAL REVIEW');
      shots.after = 'after-review.png';
      await screenshotPng(cdp, shots.after);
      await clickHandle(cdp, { role: 'tab', name: '入口' });
      await waitForText(cdp, '把下一次判断');
      shots.back = 'after-back.png';
      await screenshotPng(cdp, shots.back);
      return { shots, observed: ['landing motive cards', 'review workspace framing', 'return via 入口 tab'] };
    },
  },
  'match-review-entry': {
    title: '赛后复盘入口',
    needsDeepseek: false,
    async run(cdp) {
      await waitForText(cdp, 'Make the next call');
      await ensureZh(cdp);
      await waitForText(cdp, '把下一次判断');
      await clickHandle(cdp, { role: 'tab', name: '复盘' });
      await waitForText(cdp, '先还原你当时掌握的信息。');
      await waitForText(cdp, '复盘一局');
      const text = await pageText(cdp);
      if (!text.includes('输入比赛 ID') && !text.includes('8985182860')) {
        await clickHandle(cdp, { role: 'button', textIncludes: '复盘一局' });
        await waitForText(cdp, '8985182860');
      }
      // Require a quiet idle window: button present and no auto-fetch indicator across several samples.
      const quietMs = 1500;
      const deadline = Date.now() + 8000;
      let quietSince = null;
      while (Date.now() < deadline) {
        const text = await pageText(cdp);
        if (text.includes('正在拉取比赛')) {
          throw new Error('review entry auto-started facts fetch (正在拉取比赛)');
        }
        const hasBtn = await existsHandle(cdp, { role: 'button', name: '拉取比赛' });
        if (hasBtn) {
          if (quietSince == null) quietSince = Date.now();
          if (Date.now() - quietSince >= quietMs) break;
        } else {
          quietSince = null;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      if (quietSince == null || Date.now() - quietSince < quietMs) {
        throw new Error('timeout waiting for quiet idle 拉取比赛 button (no auto-fetch)');
      }
      const after = await pageText(cdp);
      if (!(await existsHandle(cdp, { role: 'button', name: '拉取比赛' }))) {
        throw new Error('review intake missing 拉取比赛 button');
      }
      for (const banned of [
        '正在分析', '分析中', 'Streaming', '教练拆解', '停止生成', 'Stop generating', 'facts request',
        '拉比克在看数据', '停止', '正在解读比赛', '解读比赛数据', '看数据…', '看数据...',
        '正在拉取比赛',
      ]) {
        if (after.includes(banned)) {
          throw new Error(`review entry unexpectedly started analysis/facts fetch (saw ${JSON.stringify(banned)})`);
        }
      }
      await screenshotPng(cdp, 'after.png');
      return { shots: { after: 'after.png' }, observed: ['review tab', 'match-id intake', 'no analysis started'] };
    },
  },
  'hero-codex-search': {
    title: '英雄图鉴搜索',
    needsDeepseek: false,
    async run(cdp, { uiOrigin }) {
      await navigate(cdp, `${uiOrigin}/#knowledge`);
      await waitForText(cdp, 'Reference should answer');
      await ensureZh(cdp);
      await waitForText(cdp, '资料应该回答“怎么用”');
      await waitFor(async () => {
        return (await existsHandle(cdp, { placeholder: '搜索英雄名称或别名...' })) || null;
      }, { timeoutMs: 45000, label: 'hero search box' });
      // HeroHub shows the search box + "共 0 位英雄" while /api/meta/heroes is still loading.
      const before = await waitFor(async () => {
        const text = await pageText(cdp);
        if (/Loading heroes/i.test(text)) return null;
        const count = Number(/共\s*(\d+)\s*位英雄/.exec(text)?.[1] || 0);
        return count >= 2 ? text : null;
      }, { timeoutMs: 45000, label: 'unfiltered hero catalog populated' });
      const beforeCount = Number(/共\s*(\d+)\s*位英雄/.exec(before)?.[1] || 0);
      const nonMatch = ['敌法师', '斧王', '水晶室女', '斯温', 'Anti-Mage', 'Axe', 'Sven']
        .find((name) => before.includes(name));
      await fillHandle(cdp, { placeholder: '搜索英雄名称或别名...' }, '剑圣');
      await waitFor(async () => {
        const text = await pageText(cdp);
        if (text.includes('未找到匹配的英雄')) return 'empty';
        const count = Number(/共\s*(\d+)\s*位英雄/.exec(text)?.[1] || 0);
        const hasMatch = text.includes('主宰') || text.includes('Juggernaut');
        if (hasMatch && count > 0 && count < beforeCount) return text;
        return null;
      }, { timeoutMs: 20000, label: 'search results for 剑圣' });
      const after = await pageText(cdp);
      const afterCount = Number(/共\s*(\d+)\s*位英雄/.exec(after)?.[1] || 0);
      if (after.includes('未找到匹配的英雄') && !after.includes('主宰') && !after.includes('Juggernaut')) {
        throw new Error('codex search for 剑圣 returned empty — /api/meta/heroes or OpenDota likely failed');
      }
      if (!(after.includes('主宰') || after.includes('Juggernaut'))) {
        throw new Error('codex search for 剑圣 did not show 主宰/Juggernaut');
      }
      if (!(afterCount > 0 && afterCount < beforeCount)) {
        throw new Error(`codex search did not narrow catalog: before=${beforeCount} after=${afterCount}`);
      }
      if (nonMatch && after.includes(nonMatch)) {
        throw new Error(`codex search still shows non-match ${JSON.stringify(nonMatch)} after filtering`);
      }
      await screenshotPng(cdp, 'after.png');
      return { shots: { after: 'after.png' }, observed: ['#knowledge', 'placeholder search 剑圣', `narrowed ${beforeCount}->${afterCount}`] };
    },
  },
  'tactical-journal': {
    title: '战术笔记',
    needsDeepseek: false,
    async run(cdp, { uiOrigin }) {
      await navigate(cdp, `${uiOrigin}/#journal`);
      await waitForText(cdp, 'Take exactly one executable action');
      await ensureZh(cdp);
      await waitForText(cdp, '下一局，只带走一个能执行的动作。');
      const empty = await pageText(cdp);
      const isEmpty = empty.includes('还没有保存的动作。');
      const isList = empty.includes('触发') && empty.includes('行动') && empty.includes('检查');
      if (!isEmpty && !isList) {
        throw new Error('journal workspace did not render empty panel (还没有保存的动作。) or a saved note list');
      }
      await screenshotPng(cdp, 'empty.png');
      await clickHandle(cdp, { role: 'button', name: '英雄修炼' });
      await waitForText(cdp, '先做决定，再看教练怎么拆解。');
      await clickHandle(cdp, { role: 'button', textIncludes: '等队友明确发起后，再选入口' });
      await clickHandle(cdp, { role: 'button', name: '确认判断 · 看拆解 →' });
      await waitForText(cdp, '加入计划 →', 20000);
      await clickHandle(cdp, { role: 'button', name: '加入计划 →' });
      await waitForText(cdp, '已保存到战术笔记');
      await clickHandle(cdp, { role: 'button', name: '战术笔记' });
      await waitForText(cdp, '信息不完整时，先说清一个缺口');
      const saved = await pageText(cdp);
      if (!saved.includes('触发') || !saved.includes('行动') || !saved.includes('检查')) {
        throw new Error('saved note missing trigger/action/check');
      }
      await screenshotPng(cdp, 'after.png');
      await clickHandle(cdp, { role: 'button', name: '标记已自我检查' });
      // Button flips to 标记待练; status tag shows 已自我检查 (not the pre-click button substring alone).
      await waitForText(cdp, '标记待练');
      const marked = await pageText(cdp);
      if (!marked.includes('已自我检查') || marked.includes('标记已自我检查') || marked.includes('待练习')) {
        throw new Error('journal note did not switch to done (expected 标记待练 + 已自我检查, no 待练习)');
      }
      await clickHandle(cdp, { role: 'button', name: '移除' });
      await waitForText(cdp, '撤销刚才的移除');
      await clickHandle(cdp, { role: 'button', name: '撤销刚才的移除' });
      await waitForText(cdp, '信息不完整时，先说清一个缺口');
      await screenshotPng(cdp, 'restored.png');
      return {
        shots: { empty: 'empty.png', after: 'after.png', restored: 'restored.png' },
        observed: ['empty journal', 'save from 英雄修炼', 'mark done', 'remove', 'undo'],
      };
    },
  },
  'language-toggle': {
    title: '语言切换',
    needsDeepseek: false,
    async run(cdp) {
      await waitForText(cdp, 'Make the next call');
      const en = await pageText(cdp);
      if (!en.includes('Tactical Room') || !en.includes('Hero Codex')) {
        throw new Error('default language is not English');
      }
      await screenshotPng(cdp, 'en.png');
      await clickHandle(cdp, { role: 'button', name: '切换语言' });
      await waitForText(cdp, '战术室');
      const zh = await pageText(cdp);
      if (!zh.includes('把下一次判断') || !zh.includes('英雄图鉴')) {
        throw new Error('Chinese toggle did not swap primary nav/copy');
      }
      await screenshotPng(cdp, 'zh.png');
      await clickHandle(cdp, { role: 'button', name: 'Switch language' });
      await waitForText(cdp, 'Tactical Room');
      const enBack = await pageText(cdp);
      for (const need of ['Tactical Room', 'Hero Codex', 'Make the next call']) {
        if (!enBack.includes(need)) throw new Error(`back to EN missing ${JSON.stringify(need)}`);
      }
      if (enBack.includes('战术室') || enBack.includes('英雄图鉴') || enBack.includes('把下一次判断')) {
        throw new Error('back to EN still shows Chinese primary copy');
      }
      // Toggle aria-label should be Chinese again when UI is English (inverted quirk).
      if (!(await existsHandle(cdp, { role: 'button', name: '切换语言' }))) {
        throw new Error('back to EN missing inverted toggle aria-label 切换语言');
      }
      await screenshotPng(cdp, 'en-back.png');
      return { shots: { en: 'en.png', zh: 'zh.png', back: 'en-back.png' }, observed: ['en default', '中', 'back to EN'] };
    },
  },
};


async function stopDriveChrome(state, chrome) {
  try { chrome?.cdp?.close(); } catch { /* ignore */ }
  if (state?.pids?.chrome) {
    killPid(state.pids.chrome, 'chrome');
    delete state.pids.chrome;
  }
  if (state?.chrome?.userDataDir && fs.existsSync(state.chrome.userDataDir)) {
    try { fs.rmSync(state.chrome.userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (state) {
    delete state.chrome;
    writeState(state);
  }
}

async function cmdDrive(featureId) {
  if (!featureId || featureId === '--list') {
    log(Object.entries(FEATURES).map(([id, f]) => `${id}\t${f.title}`).join('\n'));
    return;
  }
  const feature = FEATURES[featureId];
  if (!feature) fail(`unknown feature ${featureId}. Known: ${Object.keys(FEATURES).join(', ')}`);

  const state = readState();
  if (state?.__invalidState) {
    fail(`malformed verifier state at ${STATE_PATH} (${state.parseError}). Run cleanup to remove it.`);
  }
  const report = await inspect(state);
  if (!report.ok) {
    printDoctor(report);
    fail('doctor failed; refuse to drive');
  }
  if (feature.needsDeepseek && !report.deepseekConfigured) {
    fail(`${featureId} needs a live DeepSeek stream. DEEPSEEK_API_KEY is not configured. Pick tactical-room-entry, language-toggle, or tactical-journal instead.`);
  }

  const currentRevision = repoRevision();
  if (state.revision && currentRevision && state.revision !== currentRevision) {
    fail(`refuse to drive: launch revision ${state.revision} != workspace ${currentRevision}. Run cleanup + launch again so verification matches the current code.`);
  }

  const debugPort = Number(process.env.VERIFY_CDP_PORT || 9333);
  if (!(await portFree(debugPort, '127.0.0.1'))) {
    fail(`Chrome debug port ${debugPort} is in use. Set VERIFY_CDP_PORT to a free port.`);
  }

  // Allocate evidence BEFORE Chrome so launch failures still update LAST_RUN.
  const driveRunId = `${state.runId}-${nowId()}`;
  const evidenceRoot = path.join(EVIDENCE_DIR, featureId, driveRunId);
  ensureDir(evidenceRoot);
  fs.writeFileSync(LAST_RUN_PATH, `${evidenceRoot}\n`);
  fs.writeFileSync(path.join(evidenceRoot, 'meta.json'), `${JSON.stringify({
    featureId,
    title: feature.title,
    runId: driveRunId,
    launchRunId: state.runId,
    status: 'running',
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`);

  let chrome = null;
  const prevCwd = process.cwd();
  process.chdir(evidenceRoot);

  let result;
  try {
    chrome = await launchChrome({ runId: state.runId, debugPort });
    let chromeIdentity = null;
    for (let i = 0; i < 20 && !chromeIdentity?.starttime; i++) {
      chromeIdentity = readProcIdentity(chrome.chromePid);
      if (chromeIdentity?.starttime) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    chromeIdentity = chromeIdentity || { pid: chrome.chromePid, starttime: null, cmdline: chrome.chromePath };
    state.pids.chrome = chromeIdentity;
    state.chrome = { pid: chrome.chromePid, debugPort, userDataDir: chrome.userDataDir, path: chrome.chromePath, starttime: chromeIdentity.starttime, cmdline: chromeIdentity.cmdline };
    writeState(state);

    await navigate(chrome.cdp, `${state.uiOrigin}/`);
    result = await feature.run(chrome.cdp, { uiOrigin: state.uiOrigin, apiOrigin: state.apiOrigin });
    const text = await pageText(chrome.cdp);
    fs.writeFileSync(path.join(evidenceRoot, 'page.txt'), text);
    fs.writeFileSync(path.join(evidenceRoot, 'aria.txt'), await ariaDump(chrome.cdp));
    const meta = {
      featureId,
      title: feature.title,
      runId: driveRunId,
      launchRunId: state.runId,
      status: 'passed',
      uiOrigin: state.uiOrigin,
      apiOrigin: state.apiOrigin,
      capturedAt: new Date().toISOString(),
      apiKeyConfigured: report.deepseekConfigured,
      observed: result.observed,
      shots: result.shots,
      limitation: report.deepseekConfigured
        ? null
        : 'DEEPSEEK_API_KEY unset — this feature was chosen because it does not require live SSE.',
    };
    fs.writeFileSync(path.join(evidenceRoot, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
    fs.writeFileSync(LAST_RUN_PATH, `${evidenceRoot}\n`);
    log(`drove ${featureId}`);
    log(`evidence=${evidenceRoot}`);
    log(`apiKeyConfigured=${report.deepseekConfigured}`);
  } catch (err) {
    try {
      fs.writeFileSync(path.join(evidenceRoot, 'page.txt'), await pageText(chrome.cdp));
      await screenshotPng(chrome.cdp, path.join(evidenceRoot, 'failure.png'));
    } catch { /* ignore */ }
    try {
      fs.writeFileSync(path.join(evidenceRoot, 'meta.json'), `${JSON.stringify({
        featureId,
        title: feature.title,
        runId: driveRunId,
        launchRunId: state.runId,
        status: 'failed',
        error: err.message,
        failedAt: new Date().toISOString(),
      }, null, 2)}
`);
      fs.writeFileSync(LAST_RUN_PATH, `${evidenceRoot}
`);
    } catch { /* ignore */ }
    process.chdir(prevCwd);
    await stopDriveChrome(state, chrome);
    fail(`drive ${featureId} failed: ${err.message}`);
  }
  process.chdir(prevCwd);
  await stopDriveChrome(state, chrome);
}

async function cmdCleanup() {
  const state = readState();
  if (!state) {
    log(`nothing to clean (${STATE_PATH} absent)`);
    return;
  }
  if (state.__invalidState) {
    try { fs.rmSync(STATE_PATH, { force: true }); } catch { /* ignore */ }
    if (fs.existsSync(RUN_DIR)) {
      try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    log(`removed malformed state at ${STATE_PATH}; evidence kept under ${EVIDENCE_DIR}`);
    return;
  }
  for (const [name, pid] of Object.entries(state.pids || {})) {
    killPid(pid, name);
  }
  if (state.chrome?.userDataDir && fs.existsSync(state.chrome.userDataDir)) {
    fs.rmSync(state.chrome.userDataDir, { recursive: true, force: true });
  }
  if (fs.existsSync(RUN_DIR)) {
    fs.rmSync(RUN_DIR, { recursive: true, force: true });
  }
  log(`cleanup complete; evidence kept under ${EVIDENCE_DIR}`);
  if (fs.existsSync(LAST_RUN_PATH)) {
    log(`last evidence pointer: ${fs.readFileSync(LAST_RUN_PATH, 'utf8').trim()}`);
  }
}

function usage() {
  log(`Usage:
  verify-dota2-ai launch
  verify-dota2-ai doctor
  verify-dota2-ai drive <feature-id>
  verify-dota2-ai drive --list
  verify-dota2-ai cleanup

Features: ${Object.keys(FEATURES).join(', ')}
Env: VERIFY_MODE=dev|prod  VERIFY_HOST  VERIFY_API_PORT  VERIFY_VITE_PORT  VERIFY_CDP_PORT  CHROME_PATH`);
}

const [cmd, arg] = process.argv.slice(2);
const commands = {
  launch: () => cmdLaunch(),
  doctor: () => cmdDoctor(),
  drive: () => cmdDrive(arg),
  cleanup: () => cmdCleanup(),
  help: () => usage(),
  '-h': () => usage(),
  '--help': () => usage(),
};

if (!cmd || !commands[cmd]) {
  usage();
  process.exit(cmd ? 1 : 0);
}
await commands[cmd]();
