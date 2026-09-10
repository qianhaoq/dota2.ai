#!/usr/bin/env node
/**
 * Dota2.ai Tactical Coach V3 验证 CLI。
 * 只杀掉本 CLI 写入 state 的 PID；cleanup 不删除 evidence/。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
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
  readState,
  writeState,
} from './paths.mjs';
import {
  ariaDump,
  clickHandle,
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

function portFree(port, host = DEFAULT_HOST) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host }, () => {
      srv.close(() => resolve(true));
    });
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

function killPid(pid, label) {
  if (!pid || !pidAlive(pid)) return;
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
  return child.pid;
}

async function cmdLaunch() {
  const existing = readState();
  if (existing?.pids) {
    const doctor = await inspect(existing);
    if (doctor.ok) {
      log(`already running runId=${existing.runId} ui=${existing.uiOrigin} api=${existing.apiOrigin}`);
      printDoctor(doctor);
      return;
    }
    log('stale state detected; cleaning before relaunch');
    await cmdCleanup({ keepStateIfMissing: true });
  }

  if (!fs.existsSync(path.join(REPO_ROOT, 'node_modules'))) {
    fail('node_modules missing. From the repo root run: npm ci');
  }

  const mode = process.env.VERIFY_MODE === 'prod' ? 'prod' : 'dev';
  const host = process.env.VERIFY_HOST || DEFAULT_HOST;
  const apiPort = Number(process.env.VERIFY_API_PORT || (mode === 'prod' ? 18080 : DEFAULT_API_PORT));
  const vitePort = Number(process.env.VERIFY_VITE_PORT || DEFAULT_VITE_PORT);
  const runId = nowId();

  if (mode === 'dev') {
    if (!(await portFree(apiPort, host))) {
      fail(`refuse to launch: ${host}:${apiPort} is already in use. Do not drive a shared Express instance. Stop the other process or use VERIFY_MODE=prod VERIFY_API_PORT=<free-port>.`);
    }
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
    const distIndex = path.join(REPO_ROOT, 'dist', 'index.html');
    if (!fs.existsSync(distIndex)) {
      log('VERIFY_MODE=prod: running npm run build');
      const build = spawn('npm', ['run', 'build'], { cwd: REPO_ROOT, env, stdio: 'inherit' });
      const code = await new Promise((resolve) => build.on('exit', resolve));
      if (code !== 0) fail('vite build failed');
    }
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
  for (const [name, pid] of Object.entries(state.pids || {})) {
    const alive = pidAlive(pid);
    report.pids[name] = { pid, alive };
    if (!alive) report.errors.push(`${name} pid ${pid} is not running`);
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
    report.deepseekConfigured = Boolean(report.apiHealth.json?.apiKeyConfigured);
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
  const report = await inspect(state);
  printDoctor(report);
  if (!report.ok) process.exit(2);
}

const FEATURES = {
  'tactical-room-entry': {
    title: '战术室入口',
    needsDeepseek: false,
    async run(cdp) {
      const shots = {};
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
      await waitForText(cdp, '把下一次判断');
      await clickHandle(cdp, { role: 'tab', name: '复盘' });
      await waitForText(cdp, '先还原你当时掌握的信息。');
      await waitForText(cdp, '复盘一局');
      const text = await pageText(cdp);
      if (!text.includes('输入比赛 ID') && !text.includes('8985182860')) {
        await clickHandle(cdp, { role: 'button', textIncludes: '复盘一局' });
        await waitForText(cdp, '8985182860');
      }
      await waitForText(cdp, '拉取比赛');
      const after = await pageText(cdp);
      if (!after.includes('拉取比赛')) throw new Error('review intake missing 拉取比赛');
      await screenshotPng(cdp, 'after.png');
      return { shots: { after: 'after.png' }, observed: ['review tab', 'match-id intake', 'no analysis started'] };
    },
  },
  'hero-codex-search': {
    title: '英雄图鉴搜索',
    needsDeepseek: false,
    async run(cdp, { uiOrigin }) {
      await navigate(cdp, `${uiOrigin}/#knowledge`);
      await waitForText(cdp, '资料应该回答“怎么用”');
      await waitFor(async () => {
        const text = await pageText(cdp);
        if (text.includes('搜索英雄名称或别名')) return text;
        return null;
      }, { timeoutMs: 45000, label: 'hero search box' });
      await fillHandle(cdp, { placeholder: '搜索英雄名称或别名...' }, '剑圣');
      await waitFor(async () => {
        const text = await pageText(cdp);
        if (text.includes('未找到匹配的英雄')) return 'empty';
        if (text.includes('主宰') || text.includes('Juggernaut') || text.includes('剑圣')) return text;
        return null;
      }, { timeoutMs: 20000, label: 'search results for 剑圣' });
      const after = await pageText(cdp);
      if (after.includes('未找到匹配的英雄') && !after.includes('主宰') && !after.includes('Juggernaut')) {
        throw new Error('codex search for 剑圣 returned empty — /api/meta/heroes or OpenDota likely failed');
      }
      await screenshotPng(cdp, 'after.png');
      return { shots: { after: 'after.png' }, observed: ['#knowledge', 'placeholder search 剑圣'] };
    },
  },
  'tactical-journal': {
    title: '战术笔记',
    needsDeepseek: false,
    async run(cdp, { uiOrigin }) {
      await navigate(cdp, `${uiOrigin}/#journal`);
      await waitForText(cdp, '下一局，只带走一个能执行的动作。');
      const empty = await pageText(cdp);
      if (!empty.includes('还没有保存的动作。') && !empty.includes('触发')) {
        throw new Error('journal workspace did not render empty or list state');
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
      await waitForText(cdp, '已自我检查');
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
      await waitForText(cdp, '把下一次判断');
      const zh = await pageText(cdp);
      if (!zh.includes('战术室') || !zh.includes('英雄图鉴')) {
        throw new Error('default language is not 中文');
      }
      await screenshotPng(cdp, 'zh.png');
      await clickHandle(cdp, { role: 'button', name: 'Switch language' });
      await waitForText(cdp, 'Tactical Room');
      const en = await pageText(cdp);
      if (!en.includes('Make the next call') || !en.includes('Hero Codex')) {
        throw new Error('English toggle did not swap primary nav/copy');
      }
      await screenshotPng(cdp, 'en.png');
      await clickHandle(cdp, { role: 'button', name: '切换语言' });
      await waitForText(cdp, '战术室');
      await screenshotPng(cdp, 'zh-back.png');
      return { shots: { zh: 'zh.png', en: 'en.png', back: 'zh-back.png' }, observed: ['zh default', 'EN', 'back to 中'] };
    },
  },
};

async function cmdDrive(featureId) {
  if (!featureId || featureId === '--list') {
    log(Object.entries(FEATURES).map(([id, f]) => `${id}\t${f.title}`).join('\n'));
    return;
  }
  const feature = FEATURES[featureId];
  if (!feature) fail(`unknown feature ${featureId}. Known: ${Object.keys(FEATURES).join(', ')}`);

  const state = readState();
  const report = await inspect(state);
  if (!report.ok) {
    printDoctor(report);
    fail('doctor failed; refuse to drive');
  }
  if (feature.needsDeepseek && !report.deepseekConfigured) {
    fail(`${featureId} needs a live DeepSeek stream. DEEPSEEK_API_KEY is not configured. Pick tactical-room-entry, language-toggle, or tactical-journal instead.`);
  }

  const debugPort = Number(process.env.VERIFY_CDP_PORT || 9333);
  if (!(await portFree(debugPort, '127.0.0.1'))) {
    fail(`Chrome debug port ${debugPort} is in use. Set VERIFY_CDP_PORT to a free port.`);
  }

  const chrome = await launchChrome({ runId: state.runId, debugPort });
  state.pids.chrome = chrome.chromePid;
  state.chrome = { pid: chrome.chromePid, debugPort, userDataDir: chrome.userDataDir, path: chrome.chromePath };
  writeState(state);

  const evidenceRoot = path.join(EVIDENCE_DIR, featureId, state.runId);
  ensureDir(evidenceRoot);
  const prevCwd = process.cwd();
  process.chdir(evidenceRoot);

  let result;
  try {
    await navigate(chrome.cdp, `${state.uiOrigin}/`);
    result = await feature.run(chrome.cdp, { uiOrigin: state.uiOrigin, apiOrigin: state.apiOrigin });
    const text = await pageText(chrome.cdp);
    fs.writeFileSync(path.join(evidenceRoot, 'page.txt'), text);
    fs.writeFileSync(path.join(evidenceRoot, 'aria.txt'), await ariaDump(chrome.cdp));
    const meta = {
      featureId,
      title: feature.title,
      runId: state.runId,
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
    process.chdir(prevCwd);
    chrome.cdp.close();
    fail(`drive ${featureId} failed: ${err.message}`);
  }
  process.chdir(prevCwd);
  chrome.cdp.close();
}

async function cmdCleanup() {
  const state = readState();
  if (!state) {
    log(`nothing to clean (${STATE_PATH} absent)`);
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
