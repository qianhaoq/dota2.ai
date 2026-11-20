/**
 * External PR guard: a pull request from a fork never reaches production
 * without the repository owner's review.
 *
 * Run by .github/workflows/external-pr-guard.yml on `pull_request_target`
 * (trusted YAML and script from main; PR code is never checked out or run).
 *
 * - Fork PR, new or re-pushed head → add `no-auto-merge` (Auto Merge skips
 *   any PR carrying it) and, once per PR, explain why in a comment.
 *   A new push re-adds the label, so an approval covers only the code that
 *   was reviewed.
 * - The owner approves by merging by hand, or by removing the label (Auto
 *   Merge then proceeds once every other gate is green).
 * - Same-repository PR (only people with write access can push branches) →
 *   nothing to do.
 *
 * The job's own check, "External PR Guard", is a required check of Auto
 * Merge: if this guard ever fails, nothing merges (fail-closed).
 *
 * `decide()` is pure and unit-tested in src/utils/externalPrGuard.test.ts.
 */

const LABEL = 'no-auto-merge';
const MARKER = '<!-- external-pr-guard -->';
// Events that put new, unreviewed code on the PR (or bring it back).
const CODE_EVENTS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review', 'edited']);

/**
 * @param {{ action: string, baseRepo: string, headRepo: string | null, labels: string[], commented: boolean }} s
 * @returns {{ external: boolean, addLabel: boolean, comment: boolean }}
 */
function decide(s) {
  // A deleted fork reports head.repo = null: still external.
  const external = !s.headRepo || s.headRepo.toLowerCase() !== s.baseRepo.toLowerCase();
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
感谢贡献！这个 PR 来自 fork，需要维护者人工审核后才会合并上线，所以已自动加上 \`${LABEL}\`。CI 和 Codex 审查照常运行；之后每次推送新提交都会重新加上这个标签。

Thanks for contributing! This PR comes from a fork, so it needs a maintainer's review before it can merge and deploy; \`${LABEL}\` was added automatically. CI and the Codex review still run, and the label is re-added on every new push.`;

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
    labels: (pr.labels ?? []).map((l) => l.name),
    commented: false,
  };
  if (decide(state).comment) {
    const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number, per_page: 100 });
    state.commented = comments.some((c) => c.body?.includes(MARKER));
  }
  const d = decide(state);
  core.info(`PR #${issue_number} head=${state.headRepo ?? '(deleted fork)'} action=${state.action} → ${JSON.stringify(d)}`);
  if (d.addLabel) await github.rest.issues.addLabels({ owner, repo, issue_number, labels: [LABEL] });
  if (d.comment) await github.rest.issues.createComment({ owner, repo, issue_number, body: COMMENT });
}

module.exports = { decide, run, LABEL, MARKER };
