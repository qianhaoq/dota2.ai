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
  // Which workflow produces each required check, for dispatching a missing one.
  producers: {
    'ci / Build & Test': { workflow: 'ci.yml' },
    'ci / Secret Scan': { workflow: 'ci.yml' },
    e2e: { workflow: 'e2e.yml' },
    'codex / Codex Review Gate': { workflow: 'codex-gate.yml', prInput: true },
  },
  codexWaitMin: 10, // between "@codex review" requests
  maxCodexRequests: 3, // per head commit, including the automatic first one
  missingCheckMin: 5, // a required check that never appeared
  stuckQueuedMin: 15, // a required check queued/in progress this long
  maxRunAttempts: 3, // re-runs of one cancelled workflow run
  autoMergeNudgeMin: 5, // all green this long but still open
  escalateAfterMin: 45, // head age before telling a human
  holdLabel: 'no-auto-merge',
  codexLogin: 'chatgpt-codex-connector',
};

const MIN = 60_000;
const CODEX_REQUEST = '@codex review';
const marker = (sha) => `<!-- pipeline-watchdog:escalated:${sha} -->`;

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
  const t = Number.isFinite(commitAt) ? commitAt : prCreatedAt;
  return Math.min(Math.max(t, prCreatedAt), now);
}

/** A Codex review summary or receipt that names this head commit. */
function hasCodexReview(comments, sha, cfg) {
  return comments.some((c) => isCodex(c.login, cfg)
    && /codex-review-state|codex-pull-request-review-summary|Reviewed commit/.test(c.body)
    && (c.body.includes(sha) || c.body.includes(sha.slice(0, 10))));
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
    // Strict protection: bring the branch up to date; the new head restarts the flow.
    if (!pr.fork) return { actions: [{ type: 'update-branch' }], stuck };
    stuck.push('branch is behind main (fork PR: the author must update it)');
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
  const dispatched = new Set();
  let allGreen = true;
  for (const name of cfg.required) {
    const c = pr.checks[name];
    if (!c || c.conclusion !== 'success') allGreen = false;
    if (!c) {
      const p = cfg.producers[name];
      if (headAge < cfg.missingCheckMin || !p) continue;
      if (pr.fork) { stuck.push(`required check "${name}" never started`); continue; }
      if (!dispatched.has(p.workflow)) {
        dispatched.add(p.workflow);
        actions.push({ type: 'dispatch', workflow: p.workflow, ref: pr.headRef, inputs: p.prInput ? { pr_number: String(pr.number) } : {} });
      }
      continue;
    }
    if (c.status !== 'completed') {
      if (age(c.at) >= cfg.stuckQueuedMin && c.runId) actions.push({ type: 'cancel-run', runId: c.runId, check: name });
      continue;
    }
    if (c.conclusion === 'cancelled' || c.conclusion === 'timed_out') {
      if ((c.runAttempt || 1) < cfg.maxRunAttempts && c.runId) actions.push({ type: 'rerun', runId: c.runId, check: name });
      else stuck.push(`required check "${name}" keeps ending ${c.conclusion}`);
    }
    // Real failures are the author's to fix; the gate's own message says why.
  }

  // 3. Everything green but still open: ask auto-merge to look again.
  if (allGreen && codexDone && ['clean', 'unstable', 'has_hooks'].includes(pr.mergeableState)) {
    const greenSince = Math.max(...cfg.required.map((n) => pr.checks[n].at));
    if (age(greenSince) >= cfg.autoMergeNudgeMin) actions.push({ type: 'dispatch', workflow: 'auto-merge.yml', ref: null, inputs: { pr_number: String(pr.number) } });
  }

  // 4. Out of retries: tell a human, once per head commit.
  if (stuck.length && headAge >= cfg.escalateAfterMin && !pr.comments.some((c) => c.body.includes(marker(sha)))) {
    actions.push({ type: 'escalate', reasons: stuck });
  }
  return { actions, stuck };
}

async function gather(github, owner, repo, number, cfg) {
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: number });
  const sha = pr.head.sha;
  const { data: commit } = await github.rest.repos.getCommit({ owner, repo, ref: sha });
  const comments = (await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 }))
    .map((c) => ({ login: c.user?.login, body: c.body || '', at: Date.parse(c.created_at) }));
  const runs = await github.paginate(github.rest.checks.listForRef, { owner, repo, ref: sha, per_page: 100 });
  const checks = {};
  for (const name of cfg.required) {
    const latest = runs.filter((r) => r.name === name)
      .sort((a, b) => Date.parse(b.started_at || 0) - Date.parse(a.started_at || 0))[0];
    if (!latest) continue;
    const runId = Number((latest.details_url || '').match(/\/actions\/runs\/(\d+)/)?.[1]) || null;
    let runAttempt = 1;
    if (runId && latest.status === 'completed' && latest.conclusion !== 'success') {
      try { runAttempt = (await github.rest.actions.getWorkflowRun({ owner, repo, run_id: runId })).data.run_attempt; } catch { /* keep 1 */ }
    }
    checks[name] = {
      status: latest.status,
      conclusion: latest.conclusion,
      at: Date.parse(latest.completed_at || latest.started_at || pr.updated_at),
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
      firstCheckAt: runs.reduce((m, r) => Math.min(m, Date.parse(r.started_at || r.completed_at) || Infinity), Infinity),
    }, Date.now()),
    comments,
    checks,
  };
}

async function apply(github, core, owner, repo, pr, action, defaultBranch) {
  const n = pr.number;
  switch (action.type) {
    case 'update-branch':
      return github.rest.pulls.updateBranch({ owner, repo, pull_number: n, expected_head_sha: pr.headSha });
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

async function run({ github, context, core }, cfg = DEFAULTS, { dryRun = false } = {}) {
  const { owner, repo } = context.repo;
  const { data: repoInfo } = await github.rest.repos.get({ owner, repo });
  const base = repoInfo.default_branch;
  const prs = await github.paginate(github.rest.pulls.list, { owner, repo, state: 'open', base, per_page: 50 });
  const now = Date.now();
  for (const { number, draft } of prs) {
    if (draft) continue;
    try {
      const pr = await gather(github, owner, repo, number, cfg);
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

module.exports = { DEFAULTS, plan, run, headTime, hasCodexReview, CODEX_REQUEST, marker };
