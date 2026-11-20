/**
 * External PR guard: only the repository owner's own pull requests may merge
 * and deploy without the owner's review. Everything else — forks, bots
 * (Dependabot, Copilot…), future collaborators' same-repo branches — waits.
 *
 * Run by .github/workflows/external-pr-guard.yml on `pull_request_target`
 * (trusted YAML and script from main; PR code is never checked out or run).
 *
 * - PR not authored by the owner, or from a fork, on a new or re-pushed
 *   head → add `no-auto-merge` (Auto Merge and the watchdog skip any PR
 *   carrying it) and, once per PR, explain why in a comment. A new push
 *   re-adds the label, so an approval covers only the code that was reviewed.
 * - The owner approves by merging by hand, or by removing the label (Auto
 *   Merge then proceeds once every other gate is green).
 * - The owner's own PR from a branch of this repository → nothing to hold.
 *
 * It then publishes a check run named "External PR Guard" on the PR head
 * commit (a pull_request_target job's own check lands on main's commit, not
 * the head, so it cannot be the gate). Auto Merge and the watchdog require
 * that head check: if the guard fails before publishing it, nothing merges
 * (fail-closed). The label, not the check, is what holds a PR.
 * Dependabot-triggered runs get a read-only token, so labelling fails and
 * the check is never published: still held (the watchdog's reopen re-runs
 * the guard as the owner, which then labels it).
 *
 * `decide()` is pure and unit-tested in src/utils/externalPrGuard.test.ts.
 */

const LABEL = 'no-auto-merge';
const CHECK_NAME = 'External PR Guard';
const MARKER = '<!-- external-pr-guard -->';
// Events that put new, unreviewed code on the PR (or bring it back).
const CODE_EVENTS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review', 'edited']);

/**
 * @param {{ action: string, baseRepo: string, headRepo: string | null, author: string | null, owner: string, labels: string[], commented: boolean }} s
 * @returns {{ external: boolean, addLabel: boolean, comment: boolean }}
 */
function decide(s) {
  // A deleted fork reports head.repo = null, a deleted account user = null: both held.
  const fork = !s.headRepo || s.headRepo.toLowerCase() !== s.baseRepo.toLowerCase();
  const notOwner = !s.author || s.author.toLowerCase() !== s.owner.toLowerCase();
  const external = fork || notOwner;
  if (!external) return { external, addLabel: false, comment: false };
  const newCode = CODE_EVENTS.has(s.action);
  // `edited` covers a base-branch change; plain text edits re-add an absent label, which is harmless.
  return {
    external,
    addLabel: newCode && !s.labels.includes(LABEL),
    comment: newCode && !s.commented,
  };
}

const COMMENT = `${MARKER}
感谢贡献！这个仓库只有所有者本人的 PR 会自动合并；其他人（包括 fork、机器人和协作者）的 PR 都需要所有者人工审核后才会合并上线，所以已自动加上 \`${LABEL}\`。CI 和 Codex 审查照常运行；之后每次推送新提交都会重新加上这个标签。

Thanks for contributing! Only the repository owner's own PRs merge automatically here. Every other PR (forks, bots, collaborators) needs the owner's review before it can merge and deploy, so \`${LABEL}\` was added automatically. CI and the Codex review still run, and the label is re-added on every new push.`;

async function run({ github, context, core }) {
  const pr = context.payload.pull_request;
  if (!pr) {
    core.info('No pull_request in payload — nothing to do');
    return;
  }
  const { owner, repo } = context.repo;
  const issue_number = pr.number;
  const state = {
    action: context.payload.action,
    baseRepo: `${owner}/${repo}`,
    headRepo: pr.head?.repo?.full_name ?? null,
    author: pr.user?.login ?? null,
    owner,
    labels: (pr.labels ?? []).map((l) => l.name),
    commented: false,
  };
  if (decide(state).comment) {
    const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number, per_page: 100 });
    state.commented = comments.some((c) => c.body?.includes(MARKER));
  }
  const d = decide(state);
  core.info(`PR #${issue_number} head=${state.headRepo ?? '(deleted fork)'} author=${state.author ?? '(none)'} action=${state.action} → ${JSON.stringify(d)}`);
  if (d.addLabel) await github.rest.issues.addLabels({ owner, repo, issue_number, labels: [LABEL] });
  if (d.comment) await github.rest.issues.createComment({ owner, repo, issue_number, body: COMMENT });
  // Only after the label is in place: the head check is what Auto Merge waits for.
  await github.rest.checks.create({
    owner, repo, name: CHECK_NAME, head_sha: pr.head.sha, status: 'completed', conclusion: 'success',
    output: d.external
      ? { title: 'Held for owner review', summary: `\`${LABEL}\` is on this PR. A maintainer merges by hand after review, or removes the label to let Auto Merge proceed. Every new push re-adds it.` }
      : { title: "Owner's own PR", summary: 'Authored by the repository owner from a branch of this repository; no review hold.' },
  });
}

module.exports = { decide, run, LABEL, MARKER, CHECK_NAME };
