import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const { steps, sitePatch, onlyDateChanged, body } = createRequire(import.meta.url)('../../.github/scripts/data-refresh.cjs');

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
    expect(s.map((x: any) => x.cmd[0])).toEqual(['scripts/refresh-data.mjs', 'scripts/coach-matchups.mjs', 'scripts/coach-item-vs.mjs', 'scripts/coach-patch-notes.mjs', 'scripts/coach-matchups-rank.mjs', 'scripts/coach-hero-timing.mjs', 'scripts/coach-patch-meta.mjs']);
    expect(s.find((x: any) => x.cmd[0] === 'scripts/coach-patch-notes.mjs').cmd).toEqual(['scripts/coach-patch-notes.mjs', '7.42']);
    expect(s.filter((x: any) => x.stratz).map((x: any) => x.cmd[0])).toEqual(['scripts/coach-matchups-rank.mjs', 'scripts/coach-hero-timing.mjs', 'scripts/coach-patch-meta.mjs']);
    expect(s.find((x: any) => x.cmd[0] === 'scripts/refresh-data.mjs').cmd).toContain('--all');
    // Every script it names exists.
    for (const x of s) expect(() => readFileSync(x.cmd[0])).not.toThrow();
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
