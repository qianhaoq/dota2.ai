import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { trustedLogins, plan, gather, apply, configure, recoverClosed, needsReopenRecovery, headTime, DEFAULTS, marker, reopenMarker, reopenPendingMarker } = require('../../.github/scripts/pipeline-watchdog.cjs');

const MIN = 60_000;
const NOW = Date.parse('2026-11-18T15:00:00Z');
const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const ago = (m: number) => NOW - m * MIN;
const green = (m = 20) => ({ status: 'completed', conclusion: 'success', at: ago(m), runId: 1, runAttempt: 1 });
const review = { login: 'chatgpt-codex-connector[bot]', body: `Codex Review: no issues\n**Reviewed commit:** \`${SHA.slice(0, 10)}\``, at: ago(25) };

function pr(over: Record<string, unknown> = {}) {
  return {
    number: 7, draft: false, labels: [] as string[], headSha: SHA, headRef: 'feat/x', fork: false,
    mergeableState: 'blocked', headAt: ago(30), comments: [] as unknown[], hasToken: true, trusted: trustedLogins('owner'),
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

  it('without PIPELINE_TOKEN, does not update a branch (its checks would never count) and says why', () => {
    const out = plan(pr({ mergeableState: 'behind', hasToken: false, headAt: ago(60), comments: [review] }), NOW);
    expect(out.actions.map((a: { type: string }) => a.type)).toEqual(['escalate']);
    expect(out.stuck[0]).toMatch(/Update branch.*PIPELINE_TOKEN/);
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

  it('lets a running check use its own timeout before treating it as hung', () => {
    const running = (m: number) => ({ status: 'in_progress', conclusion: null, at: ago(m), runId: 5, runAttempt: 1 });
    expect(types(pr({ headAt: ago(60), comments: [review], checks: { ...pr().checks, e2e: running(25) } }))).toEqual([]);
    expect(types(pr({ headAt: ago(60), comments: [review], checks: { ...pr().checks, e2e: running(50) } }))).toEqual(['cancel-run']);
  });

  it('only counts a Codex summary whose code review completed for this head', () => {
    const summary = (status: string, sha = SHA) => ({
      login: 'chatgpt-codex-connector[bot]',
      body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${sha}","has_any_findings":false,"status":"${status}"}} -->\nCodex Review Summary`,
      at: ago(25),
    });
    expect(types(pr({ comments: [summary('completed')] }))).not.toContain('request-codex');
    for (const st of ['running', 'failed', 'cancelled', 'error']) expect(types(pr({ comments: [summary(st)] }))).toContain('request-codex');
    expect(types(pr({ comments: [summary('completed', '0'.repeat(40))] }))).toContain('request-codex');
  });

  it('never re-runs a real failure', () => {
    const failed = { status: 'completed', conclusion: 'failure', at: ago(20), runId: 5, runAttempt: 1 };
    expect(types(pr({ comments: [review], checks: { ...pr().checks, 'ci / Build & Test': failed } }))).toEqual([]);
  });

  it('reopens the PR once per head when required checks never started (dispatch would not count)', () => {
    expect(types(pr({ comments: [review], checks: {} }))).toEqual(['reopen']);
    expect(types(pr({ headAt: ago(2), comments: [review], checks: {} }))).toEqual([]);
    const after = { login: 'github-actions[bot]', body: `${reopenMarker(SHA)}\nReopened…`, at: ago(10) };
    const out = plan(pr({ headAt: ago(60), comments: [review, after], checks: {} }), NOW);
    expect(out.actions.map((a: { type: string }) => a.type)).toEqual(['escalate']);
    expect(out.stuck[0]).toMatch(/never started for abcdef1/);
    expect(types(pr({ hasToken: false, comments: [review], checks: {} }))).toEqual([]);
  });

  it('nudges auto-merge when everything is green and mergeable but the PR is still open', () => {
    expect(types(pr({ comments: [review], mergeableState: 'clean' }))).toEqual(['dispatch']);
    expect(types(pr({ comments: [review], mergeableState: 'clean', checks: Object.fromEntries(DEFAULTS.required.map((n: string) => [n, green(1)])) }))).toEqual([]);
  });

  it('does not re-nudge auto-merge within the cooldown (no watchdog ↔ auto-merge loop)', () => {
    expect(types(pr({ comments: [review], mergeableState: 'clean', lastAutoMergeDispatchAt: ago(3) }))).toEqual([]);
    expect(types(pr({ comments: [review], mergeableState: 'clean', lastAutoMergeDispatchAt: ago(11) }))).toEqual(['dispatch']);
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
  it('falls back to the stable PR creation time for a future-dated commit', () => {
    const future = NOW + 24 * 60 * MIN;
    expect(headTime({ commitAt: future, prCreatedAt, firstCheckAt: Infinity }, NOW)).toBe(prCreatedAt);
    // same answer on a later pass: the clock does not reset
    expect(headTime({ commitAt: future, prCreatedAt, firstCheckAt: Infinity }, NOW + 10 * MIN)).toBe(prCreatedAt);
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

describe('pipeline watchdog gather', () => {
  it('re-reads a PR whose mergeable state GitHub has not computed yet', async () => {
    const states = ['unknown', 'unknown', 'behind'];
    let reads = 0;
    const github = {
      rest: {
        pulls: { get: async () => ({ data: { mergeable_state: states[Math.min(reads++, 2)], head: { sha: SHA, ref: 'feat/x', repo: { full_name: 'o/r' } }, labels: [], draft: false, created_at: new Date(ago(60)).toISOString(), updated_at: new Date(ago(1)).toISOString() } }) },
        repos: { getCommit: async () => ({ data: { commit: { committer: { date: new Date(ago(30)).toISOString() } } } }) },
        issues: { listComments: () => [] },
        actions: { getWorkflowRun: async () => ({ data: { run_attempt: 1 } }) },
      },
      paginate: async (fn: (o: unknown) => unknown, o: unknown) => fn(o),
      graphql: async () => ({ repository: { pullRequest: { commits: { nodes: [{ commit: { oid: SHA, statusCheckRollup: { contexts: { nodes: [
        { __typename: 'CheckRun', name: 'e2e', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: new Date(ago(20)).toISOString(), completedAt: new Date(ago(19)).toISOString(), detailsUrl: 'https://github.com/o/r/actions/runs/11/job/22' },
        { __typename: 'StatusContext' },
      ] } } } }] } } } }),
    };
    const state = await gather(github, 'o', 'r', 7, { ...DEFAULTS, mergeableRetryMs: 0 });
    expect(reads).toBe(3);
    expect(state.mergeableState).toBe('behind');
    expect(state.checks.e2e).toMatchObject({ status: 'completed', conclusion: 'success', runId: 11 });
    expect(Object.keys(state.checks)).toEqual(['e2e']);
    expect(state.headAt).toBe(ago(20));
    expect(plan({ ...state, hasToken: true }, NOW).actions).toEqual([{ type: 'update-branch' }]);
  });
});

describe('pipeline watchdog check rollup pagination', () => {
  it('follows every page of contexts before calling a required check missing', async () => {
    const run = (name: string) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: new Date(ago(20)).toISOString(), completedAt: new Date(ago(19)).toISOString(), detailsUrl: '' });
    const pages: Record<string, { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }> = {
      first: { nodes: [run('ci / Build & Test'), run('ci / Secret Scan'), run('e2e')], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
      c1: { nodes: [run('codex / Codex Review Gate')], pageInfo: { hasNextPage: false, endCursor: null } },
    };
    const seen: (string | null)[] = [];
    const github = {
      rest: {
        pulls: { get: async () => ({ data: { mergeable_state: 'blocked', head: { sha: SHA, ref: 'feat/x', repo: { full_name: 'o/r' } }, labels: [], draft: false, created_at: new Date(ago(60)).toISOString(), updated_at: new Date(ago(1)).toISOString() } }) },
        repos: { getCommit: async () => ({ data: { commit: { committer: { date: new Date(ago(30)).toISOString() } } } }) },
        issues: { listComments: () => [] },
        actions: { getWorkflowRun: async () => ({ data: { run_attempt: 1 } }) },
      },
      paginate: async (fn: (o: unknown) => unknown, o: unknown) => fn(o),
      graphql: async (_q: string, v: { after: string | null }) => {
        seen.push(v.after);
        return { repository: { pullRequest: { commits: { nodes: [{ commit: { oid: SHA, statusCheckRollup: { contexts: pages[v.after ?? 'first'] } } }] } } } };
      },
    };
    const state = await gather(github, 'o', 'r', 7, DEFAULTS);
    expect(seen).toEqual([null, 'c1']);
    expect(Object.keys(state.checks).sort()).toEqual([...DEFAULTS.required].sort());
    expect(plan({ ...state, hasToken: true, comments: [review] }, NOW).actions.map((a: { type: string }) => a.type)).not.toContain('reopen');
  });
});

describe('pipeline watchdog reopen recovery', () => {
  configure({ retryMs: 0 });
  const core = { info: () => {}, warning: () => {} };

  it('leaves a recoverable marker when reopening fails, and the next pass reopens the PR', async () => {
    const comments: { id: number; body: string; login?: string }[] = [];
    const events: { event: string; actor: { login: string } }[] = [];
    let state = 'open';
    let failReopen = true;
    const github = {
      rest: {
        issues: {
          createComment: async ({ body }: { body: string }) => { const c = { id: comments.length + 1, body }; comments.push(c); return { data: c }; },
          updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => { comments.find((c) => c.id === comment_id)!.body = body; return {}; },
          listComments: () => comments.map((c) => ({ ...c, user: { login: (c as { login?: string }).login ?? 'github-actions[bot]' } })),
          listEvents: () => events,
        },
        pulls: {
          update: async ({ state: s }: { state: string }) => { if (s === 'open' && failReopen) throw new Error('503'); state = s; if (s === 'closed') events.push({ event: 'closed', actor: { login: 'github-actions[bot]' } }); return {}; },
          list: async () => ({ data: [{ number: 7, merged_at: null, updated_at: new Date(NOW).toISOString(), head: { sha: SHA, repo: { full_name: 'o/r' } } }] }),
        },
      },
      paginate: async (fn: (o: unknown) => unknown, o: unknown) => fn(o),
    };
    const pr = { number: 7, headSha: SHA };
    await expect(apply(github, core, 'o', 'r', pr, { type: 'reopen' }, 'main')).rejects.toThrow('503');
    expect(state).toBe('closed');
    const trusted = trustedLogins('o');
    expect(needsReopenRecovery(comments.map((c) => ({ ...c, login: 'github-actions[bot]' })), SHA, trusted)).toBe(true);
    // the same head is not closed again by plan() while recovery is pending
    expect(types(pr0({ comments: comments.map((c) => ({ login: 'github-actions[bot]', body: c.body, at: ago(1) })) }))).not.toContain('reopen');

    failReopen = false;
    await recoverClosed(github, core, 'o', 'r', 'main', NOW, false);
    expect(state).toBe('open');
    expect(comments[0].body).toContain(reopenMarker(SHA));
    expect(comments[0].body).not.toContain(reopenPendingMarker(SHA));
    expect(needsReopenRecovery(comments.map((c) => ({ ...c, login: 'github-actions[bot]' })), SHA, trusted)).toBe(false);
  });

  it('ignores a forged pending marker and a PR a maintainer closed', async () => {
    const make = (commentLogin: string, closer: string, fork = false) => {
      let reopened = false;
      const github = {
        rest: {
          issues: {
            listComments: () => [{ id: 1, user: { login: commentLogin }, body: `${reopenPendingMarker(SHA)}\nforged` }],
            listEvents: () => [{ event: 'closed', actor: { login: closer } }],
            updateComment: async () => ({}),
          },
          pulls: {
            update: async ({ state: s }: { state: string }) => { if (s === 'open') reopened = true; return {}; },
            list: async () => ({ data: [{ number: 9, merged_at: null, updated_at: new Date(NOW).toISOString(), head: { sha: SHA, repo: { full_name: fork ? 'evil/r' : 'o/r' } } }] }),
          },
        },
        paginate: async (fn: (o: unknown) => unknown, o: unknown) => fn(o),
      };
      return { github, wasReopened: () => reopened };
    };
    for (const [who, closer, fork] of [['mallory', 'github-actions[bot]', false], ['github-actions[bot]', 'maintainer', false], ['github-actions[bot]', 'github-actions[bot]', true]] as const) {
      const t = make(who, closer, fork);
      await recoverClosed(t.github, core, 'o', 'r', 'main', NOW, false);
      expect(t.wasReopened()).toBe(false);
    }
    const ok = make('github-actions[bot]', 'github-actions[bot]');
    await recoverClosed(ok.github, core, 'o', 'r', 'main', NOW, false);
    expect(ok.wasReopened()).toBe(true);
  });

  it('plan ignores watchdog markers posted by untrusted accounts', () => {
    const forgedEscalation = { login: 'mallory', body: marker(SHA), at: ago(5) };
    expect(types(pr({ headAt: ago(60), mergeableState: 'dirty', comments: [review, forgedEscalation] }))).toEqual(['escalate']);
    const forgedReopen = { login: 'mallory', body: reopenMarker(SHA), at: ago(5) };
    expect(types(pr({ comments: [review, forgedReopen], checks: {} }))).toEqual(['reopen']);
  });

  function pr0(over: Record<string, unknown>) { return pr({ review: undefined, checks: {}, ...over, comments: [review, ...((over.comments as unknown[]) || [])] }); }
});
