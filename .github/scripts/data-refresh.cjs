/**
 * Data refresh: runs every snapshot script the coach reads, keeps only the
 * files whose data changed, and writes the pull request's body. Used by
 * .github/workflows/data-refresh.yml; tests in src/utils/dataRefresh.test.ts.
 *
 *   node .github/scripts/data-refresh.cjs refresh <report.json>   run the scripts, record how each went
 *   node .github/scripts/data-refresh.cjs settle  <report.json>   undo files whose only change is the fetch date
 *   node .github/scripts/data-refresh.cjs body    <report.json> <tests: ok|failed>   the PR body, on stdout
 *
 * One source failing never stops the others: each script's outcome is
 * recorded and reported. A failed script is tried again after 2 and 10
 * minutes (upstreams come back, #419); what a failed try wrote is put back, so
 * a source that keeps failing keeps its last good data. The STRATZ scripts are skipped, and said so, when no
 * STRATZ_API_TOKEN is set.
 */
const { spawnSync, execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

/** The scripts, in the order they must run (patch-meta reads patch-notes). */
function steps(version) {
  return [
    { name: 'OpenDota constants, names, abilities, pro mid-game items, past-patch snapshots', cmd: ['scripts/refresh-data.mjs', '--all'], source: 'OpenDota, Valve, GitHub' },
    // After the snapshots: the match ids on either side of each new release and hotfix rollout they listed.
    { name: 'Match ids at each release and hotfix rollout', cmd: ['scripts/patch-match-ids.mjs'], source: 'STRATZ', stratz: true },
    { name: 'Pro matchups and lanes', cmd: ['scripts/coach-matchups.mjs'], source: 'OpenDota explorer' },
    { name: 'Pro counter items', cmd: ['scripts/coach-item-vs.mjs'], source: 'OpenDota explorer' },
    { name: `Valve's ${version} patch notes`, cmd: ['scripts/coach-patch-notes.mjs', version], source: 'Valve' },
    { name: 'Public matchups and lanes by bracket', cmd: ['scripts/coach-matchups-rank.mjs'], source: 'STRATZ', stratz: true },
    { name: 'Win rate by game length', cmd: ['scripts/coach-hero-timing.mjs'], source: 'STRATZ', stratz: true },
    { name: `Win and pick rates before and since ${version}`, cmd: ['scripts/coach-patch-meta.mjs'], source: 'STRATZ', stratz: true },
    { name: 'Public mid-game items by bracket and position', cmd: ['scripts/coach-bracket-items.mjs'], source: 'STRATZ', stratz: true },
  ];
}

/** The patch the site presents (src/coach/patch.ts), which the patch notes and their numbers are made for. */
function sitePatch(root = '.') {
  const m = readFileSync(`${root}/src/coach/patch.ts`, 'utf8').match(/version:\s*'(\d+\.\d+[a-z]?)'/);
  if (!m) throw new Error('no version in src/coach/patch.ts');
  return m[1];
}

/** Top-level fields that only say when a file was made. */
// releases_checked_at: when Valve's release list was read (lib/data/constants/patches/index.json).
const DATE_ONLY = ['fetched', 'releases_checked_at'];

/**
 * True when two versions of a JSON data file differ only in when they were
 * fetched. Anything unreadable counts as changed: a file is never undone on a
 * guess.
 */
function onlyDateChanged(before, after) {
  let a; let b;
  try { a = JSON.parse(before); b = JSON.parse(after); } catch { return false; }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  for (const k of DATE_ONLY) { delete a[k]; delete b[k]; }
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Seconds to wait before each new try of a step that failed: upstreams fail for a while and come back (#419). */
const RETRY_WAITS = [120, 600];

/** Files that differ from HEAD (changed, added or deleted), as `git status --porcelain` lists them. */
function dirtyFiles() {
  return new Set(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, '')));
}
/** Put back what a failed try wrote: a file it changed returns to HEAD, a file it added goes. */
function undo(files) {
  for (const f of files) {
    try { execFileSync('git', ['checkout', 'HEAD', '--', f], { stdio: 'ignore' }); } catch { try { require('node:fs').rmSync(f, { force: true }); } catch { /* gone already */ } }
  }
}
const sleepSync = (seconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
/** A step may run this long; then it and every process it started are stopped. */
const STEP_SECONDS = 25 * 60;
/**
 * Run one step under GNU timeout: on expiry it signals the step's whole process group, then kills it 30 s later,
 * so a script a step started (refresh-data.mjs → coach-patch-snapshots.mjs) cannot go on writing after the files
 * were put back, or race the next try (Codex P1 on #422). Where there is no `timeout` (not the Linux runner), the
 * step runs as before with Node's own timeout.
 */
function spawnStep(s, env, seconds = STEP_SECONDS) {
  const timeoutBin = process.platform === 'linux' ? '/usr/bin/timeout' : null;
  if (timeoutBin && require('node:fs').existsSync(timeoutBin)) {
    const r = spawnSync(timeoutBin, ['--kill-after=30s', `${seconds}s`, process.execPath, ...s.cmd], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    // 124: timed out (and the group was signalled); 137: it had to be killed.
    return r.status === 124 || r.status === 137 ? { ...r, stderr: `${r.stderr ?? ''}\ntimed out after ${seconds} s (the step and the processes it started were stopped)` } : r;
  }
  return spawnSync(process.execPath, s.cmd, { encoding: 'utf8', timeout: seconds * 1000, env, maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Run every step. A step that fails is tried again after each of `waits`; what a failed try wrote is put back
 * first, so a step that never succeeds leaves its files as they were (the last good data), never half written.
 * `deps` are for the tests: the steps, how a step runs, how to wait, and the working tree.
 */
function refresh(reportPath, env = process.env, deps = {}) {
  const version = deps.version ?? sitePatch();
  const filter = env.DATA_REFRESH_ONLY ? String(env.DATA_REFRESH_ONLY).trim() : '';
  const { list = steps(version), run = spawnStep, sleep = sleepSync, waits = filter ? [15] : RETRY_WAITS, dirty = dirtyFiles, restore = undo } = deps;
  const active = filter ? list.filter((s) => s.cmd.join(' ').includes(filter)) : list;
  if (filter && !active.length) throw new Error(`no refresh step matches DATA_REFRESH_ONLY=${filter}`);
  const out = { version, steps: [] };
  for (const s of active) {
    if (s.stratz && !env.STRATZ_API_TOKEN) { out.steps.push({ name: s.name, source: s.source, outcome: 'skipped', detail: 'no STRATZ_API_TOKEN secret' }); continue; }
    const began = Date.now();
    let r; let tries = 0;
    for (;;) {
      const before = dirty();
      r = run(s, env);
      tries += 1;
      if (r.status === 0) break;
      // Only what this try wrote: files an earlier step changed stay.
      restore([...dirty()].filter((f) => !before.has(f)));
      if (tries > waits.length) break;
      sleep(waits[tries - 1]);
    }
    const errLines = `${r.stderr ?? ''}`.trim().split('\n').filter(Boolean);
    const errHead = errLines.find((l) => /^\s*(?:[A-Za-z]*Error|ERROR): /.test(l))?.trim();
    const lastTwo = errLines.slice(-2);
    const tail = (errHead && !lastTwo.some((l) => l.includes(errHead)) ? [errHead, ...lastTwo] : lastTwo).join(' / ').slice(0, 300);
    out.steps.push({ name: s.name, source: s.source, outcome: r.status === 0 ? 'ok' : 'failed', tries, seconds: Math.round((Date.now() - began) / 1000), detail: r.error ? String(r.error.message) : tail });
  }
  // A new game patch is not taken up here: the site's patch page (highlights, new items) is written by hand.
  try { out.game_patch = JSON.parse(readFileSync('lib/data/constants/meta.json', 'utf8')).patch ?? null; } catch { out.game_patch = null; }
  if (reportPath) writeFileSync(reportPath, JSON.stringify(out, null, 2));
  return out;
}

// Data files run to several megabytes: the default 1 MB buffer is far too small for `git show`.
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

/**
 * Every data file under lib/ is read by a review tool, so a refresh that changes one changes what the tools answer.
 * Stored reviews are kept per review version (AGENTS.md, "What the model is told is pinned"): the version goes up
 * with the data, or reviews written against the old numbers would stay current while their evidence is recomputed
 * from the new ones.
 */
const TOOL_DATA = /^lib\//;
const VERSION_FILE = 'lib/agent/review/schema.js';
const PIN_FILE = 'src/utils/agentPromptPin.test.ts';

/** Raises DEEP_REVIEW_PROMPT_VERSION by one, with its pin and every test that states it: the new version. */
function bumpReviewVersion(root = '.') {
  const at = (f) => path.join(root, f);
  const src = readFileSync(at(VERSION_FILE), 'utf8');
  const m = src.match(/export const DEEP_REVIEW_PROMPT_VERSION = (\d+);/);
  if (!m) throw new Error(`no DEEP_REVIEW_PROMPT_VERSION in ${VERSION_FILE}`);
  const from = Number(m[1]); const to = from + 1;
  writeFileSync(at(VERSION_FILE), src.replace(m[0], `export const DEEP_REVIEW_PROMPT_VERSION = ${to};`));
  const pin = readFileSync(at(PIN_FILE), 'utf8');
  const pinned = pin.replace(`const PIN = { version: ${from}, `, `const PIN = { version: ${to}, `);
  if (pinned === pin) throw new Error(`${PIN_FILE} does not pin version ${from}`);
  writeFileSync(at(PIN_FILE), pinned);
  // Other tests that state the exact version (a feature's "the prompt version moved").
  const dir = at('src/utils');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.test.ts'))) {
    const text = readFileSync(path.join(dir, f), 'utf8');
    const next = text.split(`expect(DEEP_REVIEW_PROMPT_VERSION).toBe(${from});`).join(`expect(DEEP_REVIEW_PROMPT_VERSION).toBe(${to});`);
    if (next !== text) writeFileSync(path.join(dir, f), next);
  }
  return { from, to };
}

function settle(reportPath) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const changed = git('diff', '--name-only').split('\n').filter(Boolean);
  const added = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
  const kept = []; const undone = [];
  for (const f of changed) {
    const before = git('show', `HEAD:${f}`);
    const after = readFileSync(f, 'utf8');
    if (f.endsWith('.json') && onlyDateChanged(before, after)) { git('checkout', '--', f); undone.push(f); } else kept.push(f);
  }
  report.changed = [...kept, ...added];
  report.date_only = undone;
  if (report.changed.some((f) => TOOL_DATA.test(f))) report.review_version = bumpReviewVersion();
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return report;
}

function body(report, tests) {
  const icon = { ok: '✓', failed: '✗', skipped: '–' };
  const lines = [
    '## 变更说明 | What Changed',
    '',
    'Scheduled refresh of the data snapshots the coach reads (`.github/workflows/data-refresh.yml`). Files whose only change was the fetch date were left out.',
    '',
    '| | source | step | time |',
    '|---|---|---|---|',
    ...report.steps.map((s) => `| ${icon[s.outcome] ?? '?'} ${s.outcome} | ${s.source} | ${s.name}${s.outcome !== 'ok' && s.detail ? ` — ${s.detail.replace(/\|/g, '\\|')}` : ''} | ${s.seconds != null ? `${s.seconds}s` : ''} |`),
    '',
    `Changed: ${report.changed?.length ? report.changed.map((f) => `\`${f}\``).join(', ') : 'nothing'}.`,
    '',
  ];
  if (report.review_version) lines.push(`Review version raised from ${report.review_version.from} to ${report.review_version.to} (\`${VERSION_FILE}\` and its pin): the tools now answer from the new data, so stored reviews are written again on their next request.`, '');
  if (report.game_patch && report.game_patch !== report.version) {
    lines.push(`> **A new game patch: ${report.game_patch}.** The site still presents ${report.version} (\`src/coach/patch.ts\`), and the patch notes and their win rates follow it. Write ${report.game_patch}'s highlights and new items there; the next refresh then fetches its notes and numbers.`, '');
  }
  const failed = report.steps.filter((s) => s.outcome === 'failed');
  if (failed.length) lines.push(`> ${failed.length} step(s) still failed after ${Math.max(...failed.map((s) => s.tries ?? 1))} tries (${failed.map((s) => s.source).join(', ')}): their files were put back as they were, so those numbers stay at their last good refresh and the next run tries again. The rest is new.`, '');
  const retried = report.steps.filter((s) => s.outcome === 'ok' && (s.tries ?? 1) > 1);
  if (retried.length) lines.push(`> Succeeded on a later try: ${retried.map((s) => `${s.name} (${s.tries})`).join(', ')}.`, '');
  if (report.steps.some((s) => s.outcome === 'skipped')) lines.push('> Some steps were skipped: add the `STRATZ_API_TOKEN` repository secret to run them.', '');
  lines.push(
    '## 风险评估 | Risk Assessment',
    '',
    '- [ ] UI/流式展示 | UI/Streaming display',
    '- [ ] API 调用 | API calls',
    '- [ ] 部署相关 | Deployment',
    '- [x] 无高风险 | Low risk',
    '',
    'Data only. Each script checks what it fetched before writing (see its header) and writes nothing when a check fails. Merging deploys the new numbers.',
    '',
    '## 测试情况 | How Tested',
    '',
    '```text',
    `npx tsc --noEmit && npm run build && npm test  →  ${tests === 'ok' ? 'passed' : 'FAILED (see the run); held as a draft with no-auto-merge'}`,
    '```',
    '',
    '- [ ] CI 通过 | CI passes',
    '- [x] 本地测试 | Local testing',
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  );
  return lines.join('\n');
}

module.exports = { steps, sitePatch, onlyDateChanged, refresh, settle, body, bumpReviewVersion, RETRY_WAITS, spawnStep };

if (require.main === module) {
  const [cmd, report, tests] = process.argv.slice(2);
  if (cmd === 'refresh') { const r = refresh(report); for (const s of r.steps) console.log(`${s.outcome}\t${s.name}${s.detail ? `\t${s.detail}` : ''}`); } else if (cmd === 'settle') { const r = settle(report); console.log(`changed=${r.changed.length}`); } else if (cmd === 'body') process.stdout.write(body(JSON.parse(readFileSync(report, 'utf8')), tests));
  else { console.error('usage: data-refresh.cjs refresh|settle|body <report.json> [ok|failed]'); process.exit(2); }
}
