import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { plan, headTime, DEFAULTS, marker } = require('../../.github/scripts/pipeline-watchdog.cjs');

const MIN = 60_000;
const NOW = Date.parse('2026-11-18T15:00:00Z');
const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const ago = (m: number) => NOW - m * MIN;
const green = (m = 20) => ({ status: 'completed', conclusion: 'success', at: ago(m), runId: 1, runAttempt: 1 });
const review = { login: 'chatgpt-codex-connector[bot]', body: `Codex Review: no issues\n**Reviewed commit:** \`${SHA.slice(0, 10)}\``, at: ago(25) };

function pr(over: Record<string, unknown> = {}) {
  return {
    number: 7, draft: false, labels: [] as string[], headSha: SHA, headRef: 'feat/x', fork: false,
    mergeableState: 'blocked', headAt: ago(30), comments: [] as unknown[],
    checks: Object.fromEntries(DEFAULTS.required.map((n: string) => [n, green()])),
    ...over,
  };
}
const types = (p: ReturnType<typeof pr>) => plan(p, NOW).actions.map((a: { type: string }) => a.type);

describe('pipeline watchdog plan', () => {
  it('leaves drafts and no-auto-merge PRs alone', () => {
    expect(types(pr({ draft: true, comments: [] }))).toEqual([]);
    expect(types(pr({ labels: ['no-auto-merge'] }))).toEqual([]);
  });

  it('updates a branch that fell behind main, and does nothing else that pass', () => {
    expect(types(pr({ mergeableState: 'behind' }))).toEqual(['update-branch']);
  });

  it('re-requests a Codex review after the wait, up to the cap, then escalates', () => {
    const req = (m: number) => ({ login: 'github-actions[bot]', body: '@codex review', at: ago(m) });
    expect(types(pr({ comments: [req(5)] }))).not.toContain('request-codex');
    expect(types(pr({ comments: [req(12)] }))).toContain('request-codex');
    const capped = plan(pr({ headAt: ago(60), comments: [req(50), req(35), req(15)] }), NOW);
    expect(capped.actions.map((a: { type: string }) => a.type)).toEqual(['escalate']);
    expect(capped.stuck[0]).toMatch(/Codex has not reviewed abcdef1 after 3 requests/);
  });

  it('treats a Codex task reply (no Reviewed commit) as no review', () => {
    const task = { login: 'chatgpt-codex-connector[bot]', body: '## Review Result\n**No findings.**', at: ago(20) };
    expect(types(pr({ comments: [task] }))).toContain('request-codex');
  });

  it('only counts a review that names the current head', () => {
    const old = { ...review, body: '**Reviewed commit:** `0000000000`' };
    expect(types(pr({ comments: [old] }))).toContain('request-codex');
    expect(types(pr({ comments: [review] }))).not.toContain('request-codex');
  });

  it('re-runs a cancelled required check, then gives up after the attempt cap', () => {
    const cancelled = (runAttempt: number) => ({ status: 'completed', conclusion: 'cancelled', at: ago(20), runId: 99, runAttempt });
    const checks = (c: unknown) => ({ ...pr().checks, 'codex / Codex Review Gate': c });
    expect(plan(pr({ comments: [review], checks: checks(cancelled(1)) }), NOW).actions).toEqual([{ type: 'rerun', runId: 99, check: 'codex / Codex Review Gate' }]);
    const out = plan(pr({ headAt: ago(60), comments: [review], checks: checks(cancelled(3)) }), NOW);
    expect(out.actions.map((a: { type: string }) => a.type)).toEqual(['escalate']);
  });

  it('cancels a check stuck in the queue so the next pass can re-run it', () => {
    const queued = { status: 'queued', conclusion: null, at: ago(20), runId: 5, runAttempt: 1 };
    expect(types(pr({ comments: [review], checks: { ...pr().checks, e2e: queued } }))).toEqual(['cancel-run']);
  });

  it('never re-runs a real failure', () => {
    const failed = { status: 'completed', conclusion: 'failure', at: ago(20), runId: 5, runAttempt: 1 };
    expect(types(pr({ comments: [review], checks: { ...pr().checks, 'ci / Build & Test': failed } }))).toEqual([]);
  });

  it('dispatches missing checks once per workflow, on the PR branch', () => {
    const out = plan(pr({ comments: [review], checks: {} }), NOW).actions;
    expect(out).toEqual([
      { type: 'dispatch', workflow: 'ci.yml', ref: 'feat/x', inputs: {} },
      { type: 'dispatch', workflow: 'e2e.yml', ref: 'feat/x', inputs: {} },
      { type: 'dispatch', workflow: 'codex-gate.yml', ref: 'feat/x', inputs: { pr_number: '7' } },
    ]);
    expect(types(pr({ headAt: ago(2), comments: [review], checks: {} }))).toEqual([]);
  });

  it('nudges auto-merge when everything is green and mergeable but the PR is still open', () => {
    expect(types(pr({ comments: [review], mergeableState: 'clean' }))).toEqual(['dispatch']);
    expect(types(pr({ comments: [review], mergeableState: 'clean', checks: Object.fromEntries(DEFAULTS.required.map((n: string) => [n, green(2)])) }))).toEqual([]);
  });

  it('escalates once per head commit, with a hidden marker', () => {
    const p = pr({ headAt: ago(60), mergeableState: 'dirty', comments: [review] });
    expect(types(p)).toEqual(['escalate']);
    expect(types({ ...p, comments: [review, { login: 'github-actions[bot]', body: `${marker(SHA)}\n@owner …`, at: ago(5) }] })).toEqual([]);
  });

  it('does not touch fork branches', () => {
    expect(types(pr({ fork: true, mergeableState: 'behind', comments: [review] }))).toEqual([]);
    expect(types(pr({ fork: true, comments: [review], checks: {} }))).toEqual([]);
  });
});

describe('pipeline watchdog head time', () => {
  const prCreatedAt = ago(120);
  it('prefers the first server-recorded check run over the commit date', () => {
    expect(headTime({ commitAt: ago(5000), prCreatedAt, firstCheckAt: ago(30) }, NOW)).toBe(ago(30));
  });
  it('clamps a forged future commit date to now', () => {
    expect(headTime({ commitAt: NOW + 365 * 24 * 60 * MIN, prCreatedAt, firstCheckAt: Infinity }, NOW)).toBe(NOW);
  });
  it('clamps a commit dated before the PR to the PR creation time', () => {
    expect(headTime({ commitAt: ago(10_000), prCreatedAt, firstCheckAt: Infinity }, NOW)).toBe(prCreatedAt);
  });
  it('falls back to PR creation when the commit date is unreadable', () => {
    expect(headTime({ commitAt: NaN, prCreatedAt, firstCheckAt: Infinity }, NOW)).toBe(prCreatedAt);
  });
});

describe('codex-request workflow', () => {
  it('posts exactly "@codex review" (extra text turns it into a Codex task)', () => {
    const yml = readFileSync(join(__dirname, '../../.github/workflows/codex-request.yml'), 'utf8');
    const bodies = [...yml.matchAll(/--body\s+"([^"]*)"/g)].map((m) => m[1]);
    expect(bodies).toEqual(['@codex review']);
  });
});
