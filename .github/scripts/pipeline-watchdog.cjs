/**
 * Pipeline watchdog: keeps every open PR moving through
 *   @codex review → required checks → auto-merge → deploy
 * without anyone watching it. Run every 10 minutes by
 * .github/workflows/pipeline-watchdog.yml.
 *
 * `plan()` is pure (state in, actions out) and unit-tested in
 * src/utils/pipelineWatchdog.test.ts. `run()` gathers state with the
 * GitHub API and applies the actions.
 *
 * It only ever repeats steps the pipeline would have taken anyway
 * (request a Codex review, re-run a cancelled or stuck gate, bring a
 * branch up to date, re-evaluate auto-merge). It never approves, labels,
 * resolves threads, or merges by itself. When retries run out it mentions
 * the repo owner on the PR, once per head commit, with the reason.
 */

const DEFAULTS = {
  required: ['ci / Build & Test', 'ci / Secret Scan', 'e2e', 'codex / Codex Review Gate'],
  codexWaitMin: 10, // between "@codex review" requests
  maxCodexRequests: 3, // per head commit, including the automatic first one
  missingCheckMin: 5, // a required check that never appeared
  stuckQueuedMin: 15, // queued with no runner picking it up: a stalled runner
  // Running is healthy until the job's own timeout (e2e 30 min, Codex gate
  // waits up to 20); only past this is an in-progress check treated as hung.
  stuckRunningMin: 45,
  maxRunAttempts: 3, // re-runs of one cancelled workflow run
  // All green this long but still open. Auto Merge's workflow_run sweeps
  // share one concurrency group and can sit pending for good (seen on #144,
  // #145); a per-PR dispatch uses its own group and goes through.
  autoMergeNudgeMin: 2,
  // The watchdog also runs when Auto Merge completes; without a cooldown a PR
  // that cannot merge would bounce watchdog ↔ auto-merge every minute.
  autoMergeCooldownMin: 10,
  escalateAfterMin: 45, // head age before telling a human
  holdLabel: 'no-auto-merge',
  codexLogin: 'chatgpt-codex-connector',
};

const MIN = 60_000;
const CODEX_REQUEST = '@codex review';
const marker = (sha) => `<!-- pipeline-watchdog:escalated:${sha} -->`;
const reopenMarker = (sha) => `<!-- pipeline-watchdog:reopened:${sha} -->`;
// Written before closing, swapped for reopenMarker once the PR is open again.
// A pending marker without its done marker on a closed PR means the reopen
// failed mid-way; recoverClosed() reopens it on the next pass.
const reopenPendingMarker = (sha) => `<!-- pipeline-watchdog:reopen-pending:${sha} -->`;

/** A closed PR the watchdog closed but never managed to reopen. */
/**
 * Accounts whose comments count as watchdog state: the Actions bot (default
 * token) and the repo owner (whose PAT is PIPELINE_TOKEN). Markers posted by
 * anyone else are ignored, so a commenter cannot forge watchdog state, e.g.
 * a reopen-pending marker that would make the privileged token reopen a PR
 * a maintainer closed on purpose.
 */
const trustedLogins = (owner) => new Set(['github-actions[bot]', 'github-actions', owner]);
const byTrusted = (comments, trusted) => comments.filter((c) => trusted.has(c.login));

function needsReopenRecovery(comments, sha, trusted) {
  const mine = byTrusted(comments, trusted);
  return mine.some((c) => c.body.includes(reopenPendingMarker(sha)))
    && !mine.some((c) => c.body.includes(reopenMarker(sha)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(fn, tries = 3, delayMs = 2000) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) { if (i >= tries) throw e; await sleep(delayMs * i); }
  }
}

const isCodex = (login, cfg) => String(login || '').replace(/\[bot\]$/, '') === cfg.codexLogin;

/**
 * When the head commit arrived, from server-recorded times only. The commit's
 * own date is author-controlled (could be far in the future to suppress
 * retries, or long before the PR to trigger early escalation), so prefer the
 * first check run GitHub created for the head; otherwise clamp the commit
 * date to the PR's lifetime.
 */
function headTime({ commitAt, prCreatedAt, firstCheckAt }, now) {
  if (Number.isFinite(firstCheckAt)) return Math.min(Math.max(firstCheckAt, prCreatedAt), now);
  // A future-dated (or unreadable) commit falls back to the PR creation time,
  // which is stable across passes; clamping to `now` would reset the clock
  // on every run and disable recovery until that date arrives.
  const t = Number.isFinite(commitAt) && commitAt <= now ? commitAt : prCreatedAt;
  return Math.max(t, prCreatedAt);
}

/**
 * True only when Codex finished a code review of this head: either its
 * Review Summary state says code_review.status "completed" for this SHA, or
 * it posted a completion receipt naming the commit. A summary that is still
 * running, or ended failed / cancelled / error, does not count (the gate
 * rejects those too), so the watchdog keeps retrying and can escalate.
 */
function hasCodexReview(comments, sha, cfg) {
  return comments.some((c) => {
    if (!isCodex(c.login, cfg)) return false;
    const state = c.body.match(/<!-- codex-review-state:v1 (\{.*?\}) -->/);
    if (state) {
      try {
        const cr = JSON.parse(state[1]).code_review || {};
        return cr.commit_sha === sha && cr.status === 'completed';
      } catch { return false; }
    }
    return /Codex Review:/.test(c.body) && /Reviewed commit/.test(c.body) && c.body.includes(sha.slice(0, 10));
  });
}

/**
 * @param {object} pr  { number, draft, labels[], headSha, headRef, fork, mergeableState,
 *                       headAt (ms), comments[{login, body, at}], checks{name: {status,
 *                       conclusion, at, runId, runAttempt}} }
 * @returns {{actions: object[], stuck: string[]}}
 */
function plan(pr, now, cfg = DEFAULTS) {
  const actions = [];
  const stuck = [];
  if (pr.draft || pr.labels.includes(cfg.holdLabel)) return { actions, stuck };
  const sha = pr.headSha;
  const age = (t) => (now - t) / MIN;
  const headAge = age(pr.headAt);

  if (pr.mergeableState === 'dirty') {
    stuck.push('merge conflict with main: needs a manual merge or rebase');
  } else if (pr.mergeableState === 'behind') {
    // Strict protection: bring the branch up to date; the new head restarts
    // the flow. Only with PIPELINE_TOKEN: a GITHUB_TOKEN push fires no
    // pull_request workflows, and checks dispatched afterwards are not
    // PR-associated, so branch protection never counts them (#142, #133).
    if (pr.fork) stuck.push('branch is behind main (fork PR: the author must update it)');
    else if (pr.hasToken) return { actions: [{ type: 'update-branch' }], stuck };
    else stuck.push('branch is behind main: click "Update branch", or set the PIPELINE_TOKEN secret so the watchdog can');
  }

  // 1. Codex review for this head.
  const codexDone = hasCodexReview(pr.comments, sha, cfg);
  if (!codexDone) {
    const requests = pr.comments.filter((c) => c.at >= pr.headAt && c.body.trim() === CODEX_REQUEST);
    const last = requests.reduce((m, c) => Math.max(m, c.at), pr.headAt);
    if (age(last) >= cfg.codexWaitMin) {
      if (requests.length < cfg.maxCodexRequests) actions.push({ type: 'request-codex' });
      else stuck.push(`Codex has not reviewed ${sha.slice(0, 7)} after ${requests.length} requests`);
    }
  }

  // 2. Required checks.
  // `checks` holds only PR-associated runs (the commit's statusCheckRollup),
  // i.e. what branch protection counts. A missing one cannot be fixed by a
  // workflow_dispatch (not PR-associated); closing and reopening the PR with
  // PIPELINE_TOKEN fires the PR events again, once per head.
  let allGreen = true;
  const missing = [];
  for (const name of cfg.required) {
    const c = pr.checks[name];
    if (!c || c.conclusion !== 'success') allGreen = false;
    if (!c) { missing.push(name); continue; }
    if (c.status !== 'completed') {
      const limit = c.status === 'in_progress' ? cfg.stuckRunningMin : cfg.stuckQueuedMin;
      if (age(c.at) >= limit && c.runId) actions.push({ type: 'cancel-run', runId: c.runId, check: name });
      continue;
    }
    if (c.conclusion === 'cancelled' || c.conclusion === 'timed_out') {
      if ((c.runAttempt || 1) < cfg.maxRunAttempts && c.runId) actions.push({ type: 'rerun', runId: c.runId, check: name });
      else stuck.push(`required check "${name}" keeps ending ${c.conclusion}`);
    }
    // Real failures are the author's to fix; the gate's own message says why.
  }
  if (missing.length && headAge >= cfg.missingCheckMin) {
    const reopened = byTrusted(pr.comments, pr.trusted || new Set()).some((c) => c.body.includes(reopenMarker(sha)) || c.body.includes(reopenPendingMarker(sha)));
    if (pr.hasToken && !pr.fork && !reopened) actions.push({ type: 'reopen' });
    else stuck.push(`required check(s) never started for ${sha.slice(0, 7)}: ${missing.join(', ')}${pr.hasToken ? '' : ' (set PIPELINE_TOKEN, or close and reopen the PR)'}`);
  }

  // 3. Everything green but still open: ask auto-merge to look again.
  if (allGreen && codexDone && ['clean', 'unstable', 'has_hooks'].includes(pr.mergeableState)) {
    const greenSince = Math.max(...cfg.required.map((n) => pr.checks[n].at));
    const cooled = !pr.lastAutoMergeDispatchAt || age(pr.lastAutoMergeDispatchAt) >= cfg.autoMergeCooldownMin;
    if (age(greenSince) >= cfg.autoMergeNudgeMin && cooled) actions.push({ type: 'dispatch', workflow: 'auto-merge.yml', ref: null, inputs: { pr_number: String(pr.number) } });
  }

  // 4. Out of retries: tell a human, once per head commit.
  if (stuck.length && headAge >= cfg.escalateAfterMin && !byTrusted(pr.comments, pr.trusted || new Set()).some((c) => c.body.includes(marker(sha)))) {
    actions.push({ type: 'escalate', reasons: stuck });
  }
  return { actions, stuck };
}

async function gather(github, owner, repo, number, cfg) {
  // GitHub computes mergeability lazily: the first read after a push (or
  // after main moves) often says "unknown". Ask again a few times.
  let { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  for (let i = 0; i < 3 && pr.mergeable_state === 'unknown'; i++) {
    await new Promise((r) => setTimeout(r, cfg.mergeableRetryMs ?? 3000));
    ({ data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number }));
  }
  const sha = pr.head.sha;
  const { data: commit } = await github.rest.repos.getCommit({ owner, repo, ref: sha });
  const comments = (await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 }))
    .map((c) => ({ login: c.user?.login, body: c.body || '', at: Date.parse(c.created_at) }));
  // Only PR-associated check runs: the same rollup branch protection uses.
  // `contexts` is a paginated connection: follow every page before deciding
  // that a required check is missing.
  const q = `query($o:String!,$r:String!,$n:Int!,$after:String){repository(owner:$o,name:$r){pullRequest(number:$n){commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{__typename ... on CheckRun{name status conclusion startedAt completedAt detailsUrl}}}}}}}}}}`;
  const runs = [];
  for (let after = null, page = 0; page < 20; page++) {
    const res = await github.graphql(q, { o: owner, r: repo, n: number, after });
    const node = res.repository.pullRequest.commits.nodes[0]?.commit;
    // A push landed between the REST read and this query: the snapshot mixes
    // two heads, so skip the PR this pass rather than act on stale data.
    if (node && node.oid !== sha) throw new Error(`head moved during gather (${sha.slice(0, 7)} → ${node.oid.slice(0, 7)}); skipping this pass`);
    if (!node) break;
    const ctx = node.statusCheckRollup?.contexts;
    runs.push(...(ctx?.nodes || []).filter((x) => x.__typename === 'CheckRun'));
    if (!ctx?.pageInfo?.hasNextPage) break;
    after = ctx.pageInfo.endCursor;
  }
  const checks = {};
  for (const name of cfg.required) {
    const latest = runs.filter((r) => r.name === name)
      .sort((a, b) => Date.parse(b.startedAt || 0) - Date.parse(a.startedAt || 0))[0];
    if (!latest) continue;
    const status = String(latest.status).toLowerCase();
    const conclusion = latest.conclusion ? String(latest.conclusion).toLowerCase() : null;
    const runId = Number((latest.detailsUrl || '').match(/\/actions\/runs\/(\d+)/)?.[1]) || null;
    let runAttempt = 1;
    if (runId && status === 'completed' && conclusion !== 'success') {
      try { runAttempt = (await github.rest.actions.getWorkflowRun({ owner, repo, run_id: runId })).data.run_attempt; } catch { /* keep 1 */ }
    }
    checks[name] = {
      status,
      conclusion,
      at: Date.parse(latest.completedAt || latest.startedAt || pr.updated_at),
      runId,
      runAttempt,
    };
  }
  return {
    number,
    draft: pr.draft,
    labels: pr.labels.map((l) => l.name),
    headSha: sha,
    headRef: pr.head.ref,
    fork: pr.head.repo?.full_name !== `${owner}/${repo}`,
    mergeableState: pr.mergeable_state,
    headAt: headTime({
      commitAt: Date.parse(commit.commit.committer?.date),
      prCreatedAt: Date.parse(pr.created_at),
      firstCheckAt: runs.reduce((m, r) => Math.min(m, Date.parse(r.startedAt || r.completedAt) || Infinity), Infinity),
    }, Date.now()),
    comments,
    checks,
  };
}

let cfgRetryMs = 2000;
/** Tests shorten the retry back-off. */
function configure({ retryMs } = {}) { if (Number.isFinite(retryMs)) cfgRetryMs = retryMs; }

async function reopenAndRecord(github, owner, repo, n, sha, commentId) {
  await withRetry(() => github.rest.pulls.update({ owner, repo, pull_number: n, state: 'open' }), 3, cfgRetryMs);
  return github.rest.issues.updateComment({ owner, repo, comment_id: commentId, body: `${reopenMarker(sha)}\nReopened to re-run the required checks for \`${sha.slice(0, 7)}\` (pipeline watchdog).` });
}

/** Reopen PRs the watchdog closed but failed to reopen (see 'reopen'). */
async function recoverClosed(github, core, owner, repo, base, now, dryRun) {
  const trusted = trustedLogins(owner);
  const closed = await github.rest.pulls.list({ owner, repo, state: 'closed', base, sort: 'updated', direction: 'desc', per_page: 30 });
  for (const pr of closed.data || closed) {
    if (pr.merged_at || now - Date.parse(pr.updated_at) > 24 * 60 * MIN) continue;
    if (pr.head.repo?.full_name !== `${owner}/${repo}`) continue; // never act on forks
    const comments = (await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr.number, per_page: 100 }))
      .map((c) => ({ id: c.id, login: c.user?.login, body: c.body || '' }));
    if (!needsReopenRecovery(comments, pr.head.sha, trusted)) continue;
    // Second proof: the most recent close was done by a trusted account.
    const events = await github.paginate(github.rest.issues.listEvents, { owner, repo, issue_number: pr.number, per_page: 100 });
    const lastClose = events.filter((e) => e.event === 'closed').pop();
    if (!lastClose || !trusted.has(lastClose.actor?.login)) continue;
    core.info(`#${pr.number} closed by the watchdog but not reopened: reopening`);
    if (dryRun) continue;
    const note = byTrusted(comments, trusted).find((c) => c.body.includes(reopenPendingMarker(pr.head.sha)));
    try { await reopenAndRecord(github, owner, repo, pr.number, pr.head.sha, note.id); } catch (e) { core.warning(`#${pr.number} reopen recovery failed: ${e.message}`); }
  }
}

async function apply(github, core, owner, repo, pr, action, defaultBranch) {
  const n = pr.number;
  switch (action.type) {
    case 'update-branch':
      return github.rest.pulls.updateBranch({ owner, repo, pull_number: n, expected_head_sha: pr.headSha });
    case 'reopen': {
      // Record intent first, so a failure between close and reopen is
      // recoverable on the next pass (recoverClosed) instead of leaving the
      // PR closed and invisible to a watchdog that only lists open PRs.
      const { data: note } = await github.rest.issues.createComment({ owner, repo, issue_number: n, body: `${reopenPendingMarker(pr.headSha)}\nClosing and reopening to re-run the required checks for \`${pr.headSha.slice(0, 7)}\` (pipeline watchdog).` });
      try {
        await withRetry(() => github.rest.pulls.update({ owner, repo, pull_number: n, state: 'closed' }), 3, cfgRetryMs);
      } catch (e) {
        // Never closed: retire the pending marker so a later pass can try again.
        await github.rest.issues.updateComment({ owner, repo, comment_id: note.id, body: `Tried to close and reopen this PR to re-run checks for \`${pr.headSha.slice(0, 7)}\`, but closing failed (${e.message}); will retry (pipeline watchdog).` }).catch(() => {});
        throw e;
      }
      return reopenAndRecord(github, owner, repo, n, pr.headSha, note.id);
    }
    case 'request-codex':
      return github.rest.issues.createComment({ owner, repo, issue_number: n, body: CODEX_REQUEST });
    case 'dispatch':
      return github.rest.actions.createWorkflowDispatch({ owner, repo, workflow_id: action.workflow, ref: action.ref || defaultBranch, inputs: action.inputs });
    case 'cancel-run':
      return github.rest.actions.cancelWorkflowRun({ owner, repo, run_id: action.runId });
    case 'rerun':
      return github.rest.actions.reRunWorkflow({ owner, repo, run_id: action.runId });
    case 'escalate': {
      const body = [
        marker(pr.headSha),
        `@${owner} the pipeline watchdog could not move this PR forward on its own (head \`${pr.headSha.slice(0, 7)}\`):`,
        '',
        ...action.reasons.map((r) => `- ${r}`),
        '',
        'Retries are exhausted for this commit. A new push restarts the automatic flow.',
      ].join('\n');
      return github.rest.issues.createComment({ owner, repo, issue_number: n, body });
    }
    default:
      core.warning(`unknown action ${action.type}`);
  }
}

async function run({ github, context, core }, cfg = DEFAULTS, { dryRun = false, hasToken = process.env.HAS_PIPELINE_TOKEN === 'true' } = {}) {
  const { owner, repo } = context.repo;
  if (Number.isFinite(cfg.retryMs)) cfgRetryMs = cfg.retryMs;
  const { data: repoInfo } = await github.rest.repos.get({ owner, repo });
  const base = repoInfo.default_branch;
  try { await recoverClosed(github, core, owner, repo, base, Date.now(), dryRun); } catch (e) { core.warning(`closed-PR recovery failed: ${e.message}`); }
  const prs = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', base, per_page: 50 });
  const now = Date.now();
  // Last manual Auto Merge dispatch (any PR): the nudge cooldown.
  let lastAutoMergeDispatchAt = 0;
  try {
    const { data } = await github.rest.actions.listWorkflowRuns({ owner, repo, workflow_id: 'auto-merge.yml', event: 'workflow_dispatch', per_page: 1 });
    lastAutoMergeDispatchAt = Date.parse(data.workflow_runs[0]?.created_at) || 0;
  } catch (e) { core.warning(`auto-merge run lookup failed: ${e.message}`); }
  for (const { number, draft } of prs) {
    if (draft) continue;
    try {
      const pr = { ...(await gather(github, owner, repo, number, cfg)), lastAutoMergeDispatchAt, hasToken, trusted: trustedLogins(owner) };
      const { actions, stuck } = plan(pr, now, cfg);
      core.info(`#${number} ${pr.headSha.slice(0, 7)} ${pr.mergeableState}: ${actions.map((a) => a.type).join(', ') || 'no action'}${stuck.length ? ` | stuck: ${stuck.join('; ')}` : ''}`);
      for (const a of dryRun ? [] : actions) {
        try { await apply(github, core, owner, repo, pr, a, base); } catch (e) { core.warning(`#${number} ${a.type} failed: ${e.message}`); }
      }
    } catch (e) {
      core.warning(`#${number}: ${e.message}`);
    }
  }
}

module.exports = { trustedLogins, DEFAULTS, plan, run, gather, apply, configure, recoverClosed, needsReopenRecovery, headTime, hasCodexReview, CODEX_REQUEST, marker, reopenMarker, reopenPendingMarker };
