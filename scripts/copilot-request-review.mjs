// Bot slugs belong in GraphQL botLogins, never REST reviewers (human logins).
export function normalizeCopilotBot(login) {
  const slug = String(login).toLowerCase().replace(/\[bot\]$/, '');
  if (slug !== 'copilot-pull-request-reviewer') throw new Error('Invalid Copilot bot identity');
  return `${slug}[bot]`;
}

export function isCopilotReview(review) {
  return review.user?.login?.toLowerCase() === 'copilot-pull-request-reviewer[bot]' ||
    (review.user?.login?.toLowerCase() === 'copilot' && review.is_copilot_code_review === true);
}

export function isCopilotAck(event) {
  if (event.event !== 'review_requested') return false;
  const reviewer = event.requested_reviewer;
  const login = reviewer?.login?.toLowerCase();
  // Logins alone cannot establish the Copilot app identity.
  if (reviewer?.type !== 'Bot') return false;
  return ['copilot', 'copilot-pull-request-reviewer[bot]', 'copilot-pull-request-reviewer']
    .includes(login);
}

export function classifyRequestError(error) {
  const status = error.status ?? error.response?.status;
  const reason = status === 422 ? 'invalid_reviewer' : status === 403 ? 'permission_denied' : 'api_error';
  return { outcome: 'request_failed', ok: false, reason,
    message: `Copilot request failed (${reason}${status ? `, HTTP ${status}` : ''}): ${error.message}` };
}

export async function requestCopilotReview({ github, owner, repo, pull_number, pullRequestId,
  botLogin = 'copilot-pull-request-reviewer[bot]', attempts = 13, intervalMs = 5000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const params = { owner, repo, pull_number, per_page: 100 };
  const reviews = () => github.paginate(github.rest.pulls.listReviews, params);
  const events = () => github.paginate(github.rest.issues.listEvents,
    { owner, repo, issue_number: pull_number, per_page: 100 });
  try {
    if ((await reviews()).some(isCopilotReview)) {
      return { outcome: 'already_reviewed', ok: true, message: 'A real Copilot review already exists.' };
    }
    // Snapshot IDs so an old, possibly removed request cannot acknowledge this call.
    const priorIds = new Set((await events()).map(event => event.id));
    await github.graphql(`mutation($pullRequestId: ID!, $botLogins: [String!]!) {
      requestReviewsByLogin(input: {pullRequestId: $pullRequestId, botLogins: $botLogins, union: true}) {
        pullRequest { number }
      }
    }`, { pullRequestId, botLogins: [normalizeCopilotBot(botLogin)] });
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(intervalMs);
      if ((await events()).some(event => !priorIds.has(event.id) && isCopilotAck(event))) {
        return { outcome: 'request_ack', ok: true, message: 'Copilot request acknowledged by a new issue event.' };
      }
      if ((await reviews()).some(isCopilotReview)) {
        return { outcome: 'already_reviewed', ok: true, message: 'A real Copilot review arrived while polling.' };
      }
    }
    return { outcome: 'no_ack', ok: false,
      message: 'API returned successfully, but no new Copilot review_requested event or real review appeared within the polling window.' };
  } catch (error) {
    return classifyRequestError(error);
  }
}
