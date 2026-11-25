import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { steps, sitePatch, onlyDateChanged, body, bumpReviewVersion } = createRequire(import.meta.url)('../../.github/scripts/data-refresh.cjs');

describe('data refresh: what counts as a change', () => {
  it('a file whose only change is its fetch date is no change; any data change is', () => {
    const a = JSON.stringify({ source: 's', fetched: '2026-11-24', patch: '7.42', heroes: { 1: [1, 2] } });
    expect(onlyDateChanged(a, JSON.stringify({ source: 's', fetched: '2026-12-01', patch: '7.42', heroes: { 1: [1, 2] } }))).toBe(true);
    expect(onlyDateChanged(a, a)).toBe(true);
    expect(onlyDateChanged(a, JSON.stringify({ source: 's', fetched: '2026-12-01', patch: '7.42', heroes: { 1: [1, 3] } }))).toBe(false);
    // A window that moved (weeks, days) is a change even with the same numbers.
    const w = (to: string) => JSON.stringify({ fetched: to, weeks: { from: '2026-10-15', to }, heroes: {} });
    expect(onlyDateChanged(w('2026-11-11'), w('2026-11-18'))).toBe(false);
    // Only the top-level fetch date is ignored: one nested deeper is data.
    expect(onlyDateChanged(JSON.stringify({ x: { fetched: 'a' } }), JSON.stringify({ x: { fetched: 'b' } }))).toBe(false);
    // A key added or dropped is a change.
    expect(onlyDateChanged(a, JSON.stringify({ source: 's', fetched: '2026-11-24', patch: '7.42', heroes: { 1: [1, 2] }, extra: 1 }))).toBe(false);
    // Anything unreadable is a change: a file is never undone on a guess.
    expect(onlyDateChanged('{', a)).toBe(false);
    expect(onlyDateChanged(a, 'not json')).toBe(false);
    expect(onlyDateChanged('[1,2]', '[1,2]')).toBe(true);
    expect(onlyDateChanged('[1,2]', '[1,3]')).toBe(false);
  });
});

describe('data refresh: the steps', () => {
  it('runs every data script once, Valve\'s notes before the numbers that read them, STRATZ marked', () => {
    const s = steps('7.42');
    expect(s.map((x: any) => x.cmd[0])).toEqual(['scripts/refresh-data.mjs', 'scripts/patch-match-ids.mjs', 'scripts/coach-matchups.mjs', 'scripts/coach-item-vs.mjs', 'scripts/coach-patch-notes.mjs', 'scripts/coach-matchups-rank.mjs', 'scripts/coach-hero-timing.mjs', 'scripts/coach-patch-meta.mjs']);
    expect(s.find((x: any) => x.cmd[0] === 'scripts/coach-patch-notes.mjs').cmd).toEqual(['scripts/coach-patch-notes.mjs', '7.42']);
    expect(s.filter((x: any) => x.stratz).map((x: any) => x.cmd[0])).toEqual(['scripts/patch-match-ids.mjs', 'scripts/coach-matchups-rank.mjs', 'scripts/coach-hero-timing.mjs', 'scripts/coach-patch-meta.mjs']);
    expect(s.find((x: any) => x.cmd[0] === 'scripts/refresh-data.mjs').cmd).toContain('--all');
    // Every script it names exists.
    for (const x of s) expect(() => readFileSync(x.cmd[0])).not.toThrow();
  });

  it('the release snapshots can run: the workflow checks out OpenDota\'s builder and hands it over', () => {
    // refresh-data.mjs --all refuses to start without DOTACONSTANTS_DIR (and writes nothing): the weekly run must set it.
    const wf = readFileSync('.github/workflows/data-refresh.yml', 'utf8');
    expect(wf).toContain('git clone --quiet https://github.com/odota/dotaconstants');
    expect(wf).toMatch(/DOTACONSTANTS_DIR: \$\{\{ runner\.temp \}\}\/dotaconstants/);
    // The pinned builder commit is the one the snapshot script documents.
    const pinned = wf.match(/checkout --quiet ([0-9a-f]{7,40})/)![1];
    expect(readFileSync('scripts/coach-patch-snapshots.mjs', 'utf8')).toContain(`git checkout ${pinned}`);
    // When Valve's release list was read, and when a snapshot was built, are dates only: no weekly change on their own.
    expect(onlyDateChanged(JSON.stringify({ releases_checked_at: '2026-11-24T13:41:11Z', releases: [1] }), JSON.stringify({ releases_checked_at: '2026-12-01T06:10:00Z', releases: [1] }))).toBe(true);
  });

  it('reads the patch the site presents from src/coach/patch.ts', () => {
    const fromFile = readFileSync('src/coach/patch.ts', 'utf8').match(/version:\s*'([^']+)'/)![1];
    expect(sitePatch()).toBe(fromFile);
  });
});

describe('data refresh: the pull request body', () => {
  const report = (extra: any = {}) => ({
    version: '7.42', game_patch: '7.42', changed: ['lib/coach/data/patch-meta.json'], date_only: ['lib/coach/data/names.json'],
    steps: [
      { name: 'Pro matchups and lanes', source: 'OpenDota explorer', outcome: 'ok', seconds: 41 },
      { name: 'Win rate by game length', source: 'STRATZ', outcome: 'failed', seconds: 3, detail: 'Error: STRATZ rejected the token (401)' },
      { name: 'Win and pick rates', source: 'STRATZ', outcome: 'skipped', detail: 'no STRATZ_API_TOKEN secret' },
    ],
    ...extra,
  });

  it('says how each step went, what changed, and how the tests went', () => {
    const b = body(report(), 'ok');
    expect(b).toContain('| ✓ ok | OpenDota explorer | Pro matchups and lanes | 41s |');
    expect(b).toContain('| ✗ failed | STRATZ | Win rate by game length — Error: STRATZ rejected the token (401) | 3s |');
    expect(b).toContain('| – skipped | STRATZ | Win and pick rates — no STRATZ_API_TOKEN secret |  |');
    expect(b).toContain('Changed: `lib/coach/data/patch-meta.json`.');
    expect(b).toContain('add the `STRATZ_API_TOKEN` repository secret');
    expect(b).toContain('→  passed');
    expect(b).not.toContain('A new game patch');
    // The repository's PR template sections and the attribution line are there.
    for (const h of ['## 变更说明 | What Changed', '## 风险评估 | Risk Assessment', '## 测试情况 | How Tested', '🤖 Generated with [Claude Code](https://claude.com/claude-code)']) expect(b).toContain(h);
  });

  it('says plainly when tests failed, and when the game has a patch the site does not present yet', () => {
    expect(body(report(), 'failed')).toContain('FAILED (see the run); held as a draft with no-auto-merge');
    const b = body(report({ game_patch: '7.43' }), 'ok');
    expect(b).toContain('**A new game patch: 7.43.** The site still presents 7.42');
    expect(body(report({ changed: [] }), 'ok')).toContain('Changed: nothing.');
    // A detail with a pipe does not break the table.
    expect(body(report({ steps: [{ name: 'x', source: 's', outcome: 'failed', detail: 'a|b' }] }), 'ok')).toContain('x — a\\|b');
  });
});

describe('data refresh: the workflow keeps its one PR moving (review of #289)', () => {
  const yml = readFileSync('.github/workflows/data-refresh.yml', 'utf8');
  const prStep = yml.slice(yml.indexOf('- name: Open or update the pull request'), yml.indexOf('- name: Nothing changed'));
  it('a failed gate holds the PR as a draft; a passing one makes it ready again and lifts the hold', () => {
    const failed = prStep.slice(prStep.indexOf('if [ "$TESTS" != "ok" ]; then'), prStep.indexOf('else', prStep.indexOf('if [ "$TESTS" != "ok" ]; then')));
    const passed = prStep.slice(prStep.indexOf('else', prStep.indexOf('if [ "$TESTS" != "ok" ]; then')), prStep.indexOf('fi', prStep.lastIndexOf('gh pr ready')));
    expect(failed).toContain('--add-label no-auto-merge');
    expect(failed).toContain('gh pr ready "$pr" --undo');
    // codex-request and the watchdog skip drafts: a draft left behind would never be reviewed or merged.
    expect(passed).toMatch(/gh pr ready "\$pr" \|\| true/);
    expect(passed).not.toContain('--undo');
    expect(passed).toContain('--remove-label no-auto-merge');
  });
  it('opens nothing without PIPELINE_TOKEN, since a PR made with GITHUB_TOKEN starts no checks', () => {
    expect(prStep).toContain('GH_TOKEN: ${{ secrets.PIPELINE_TOKEN }}');
    expect(prStep).toMatch(/if \[ -z "\$GH_TOKEN" \]; then[\s\S]*?exit 0/);
  });
});


describe('data refresh: new data raises the review version', () => {
  it('the version, its pin and every test that states it go up by one; nothing else changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'refresh-'));
    try {
      cpSync('lib/agent/review/schema.js', join(root, 'lib/agent/review/schema.js'));
      cpSync('src/utils', join(root, 'src/utils'), { recursive: true });
      const now = Number(readFileSync('lib/agent/review/schema.js', 'utf8').match(/DEEP_REVIEW_PROMPT_VERSION = (\d+)/)![1]);
      expect(bumpReviewVersion(root)).toEqual({ from: now, to: now + 1 });
      expect(readFileSync(join(root, 'lib/agent/review/schema.js'), 'utf8')).toContain(`export const DEEP_REVIEW_PROMPT_VERSION = ${now + 1};`);
      const pin = readFileSync(join(root, 'src/utils/agentPromptPin.test.ts'), 'utf8');
      expect(pin).toContain(`const PIN = { version: ${now + 1}, `);
      // The hash is the prompt's: unchanged, since the prompt text did not change.
      expect(pin.match(/hash: '([0-9a-f]+)'/)![1]).toBe(readFileSync('src/utils/agentPromptPin.test.ts', 'utf8').match(/hash: '([0-9a-f]+)'/)![1]);
      for (const f of readdirSync(join(root, 'src/utils')).filter((x) => x.endsWith('.test.ts'))) expect([f, readFileSync(join(root, 'src/utils', f), 'utf8').includes(`expect(DEEP_REVIEW_PROMPT_VERSION).toBe(${now});`)]).toEqual([f, false]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('the pull request says so', () => {
    const text = body({ version: '7.42', steps: [], changed: ['lib/coach/data/item-vs.json'], review_version: { from: 35, to: 36 } }, 'ok');
    expect(text).toContain('Review version raised from 35 to 36');
    expect(body({ version: '7.42', steps: [], changed: [] }, 'ok')).not.toContain('Review version');
  });
});
