import { describe, expect, it, vi } from 'vitest';
import { requestCopilotReview, isCopilotReview, isCopilotAck, normalizeCopilotBot } from './copilot-request-review.mjs';

const realReview = { user: { login: 'copilot-pull-request-reviewer[bot]' } };
function fixture({ before = [], after = [], events = [], priorEvents = [], error } = {}) {
  const listReviews = vi.fn();
  const listEvents = vi.fn();
  let reviewCalls = 0;
  let eventCalls = 0;
  const github = {
    rest: { pulls: { listReviews, requestReviewers: vi.fn() }, issues: { listEvents } },
    paginate: vi.fn(async method => method === listReviews
      ? (++reviewCalls === 1 ? before : after)
      : (++eventCalls === 1 ? priorEvents : events)),
    graphql: error ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue({
      requestReviewsByLogin: { pullRequest: { number: 123, reviewRequests: { nodes: [] } } },
    }),
  };
  return { github, owner: 'owner', repo: 'repo', pull_number: 123, pullRequestId: 'PR_123',
    attempts: 3, intervalMs: 5000, sleep: vi.fn().mockResolvedValue(undefined) };
}

describe('honest Copilot review requests', () => {
  it.each([
    [422, 'invalid_reviewer', 'Review cannot be requested from collaborator copilot-pull-request-reviewer'],
    [403, 'permission_denied', 'Resource not accessible by integration'],
  ])('fails for HTTP %i', async (status, reason, message) => {
    const deps = fixture({ error: Object.assign(new Error(message), { status }) });
    expect(await requestCopilotReview(deps)).toMatchObject({ ok: false, outcome: 'request_failed', reason });
  });

  it('accepts an existing real review without re-requesting', async () => {
    const deps = fixture({ before: [realReview] });
    expect(await requestCopilotReview(deps)).toMatchObject({ ok: true, outcome: 'already_reviewed' });
    expect(deps.github.graphql).not.toHaveBeenCalled();
  });

  it('requires the Copilot marker for the display login', () => {
    expect(isCopilotReview({ user: { login: 'Copilot' } })).toBe(false);
    expect(isCopilotReview({ user: { login: 'Copilot' }, is_copilot_code_review: true })).toBe(true);
    expect(isCopilotReview({ user: { login: 'copilot-pull-request-reviewer', type: 'Organization' } })).toBe(false);
  });

  it.each([
    { id: 2, event: 'review_requested', requested_reviewer: { login: 'Copilot', type: 'Bot' } },
    { id: 2, event: 'review_requested', requested_reviewer: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' } },
    { id: 2, event: 'review_requested', requested_reviewer: { login: 'copilot-pull-request-reviewer', type: 'Bot' } },
  ])('accepts a new acknowledgment: $event', async event => {
    const deps = fixture({ events: [event] });
    expect(await requestCopilotReview(deps)).toMatchObject({ ok: true, outcome: 'request_ack' });
  });

  it('does not acknowledge an old review request when Copilot starts work', async () => {
    const prior = { id: 1, event: 'review_requested', requested_reviewer: { login: 'Copilot' } };
    const deps = fixture({ priorEvents: [prior], events: [prior, { id: 2, event: 'copilot_work_started' }] });
    expect(await requestCopilotReview(deps)).toMatchObject({ ok: false, outcome: 'no_ack' });
    expect(deps.sleep).toHaveBeenCalledTimes(2);
  });

  it('does not acknowledge a new Copilot work event without a review request', async () => {
    const event = { id: 2, event: 'copilot_work_started' };
    expect(isCopilotAck(event)).toBe(false);
    expect(await requestCopilotReview(fixture({ events: [event] })))
      .toMatchObject({ ok: false, outcome: 'no_ack' });
  });

  it('accepts a real review arriving during polling', async () => {
    expect(await requestCopilotReview(fixture({ after: [realReview] })))
      .toMatchObject({ ok: true, outcome: 'already_reviewed' });
  });

  it('fails on API success with empty reviewRequests and no events', async () => {
    const deps = fixture();
    expect(await requestCopilotReview(deps)).toMatchObject({ ok: false, outcome: 'no_ack' });
    expect(deps.sleep).toHaveBeenCalledTimes(2);
  });

  it('does not use old acknowledgment events as proof of a new request', async () => {
    const events = [{ id: 1, event: 'review_requested', requested_reviewer: { login: 'Copilot', type: 'Bot' } }];
    expect(await requestCopilotReview(fixture({ priorEvents: events, events })))
      .toMatchObject({ ok: false, outcome: 'no_ack' });
  });

  it.each(['copilot-pull-request-reviewer', 'copilot-pull-request-reviewer[bot]'])(
    'routes %s only through GraphQL botLogins', async botLogin => {
      const deps = fixture();
      await requestCopilotReview({ ...deps, botLogin });
      expect(normalizeCopilotBot(botLogin)).toBe('copilot-pull-request-reviewer[bot]');
      expect(deps.github.graphql).toHaveBeenCalledWith(expect.stringContaining('requestReviewsByLogin'), {
        pullRequestId: 'PR_123', botLogins: ['copilot-pull-request-reviewer[bot]'],
      });
      expect(deps.github.graphql.mock.calls[0][0]).toMatch(/union:\s*true/);
      expect(deps.github.rest.pulls.requestReviewers).not.toHaveBeenCalled();
    });

  it('defaults to the suffixed bot login and preserves existing review requests', async () => {
    const deps = fixture();
    await requestCopilotReview(deps);
    expect(deps.github.graphql).toHaveBeenCalledWith(expect.stringMatching(/union:\s*true/), {
      pullRequestId: 'PR_123', botLogins: ['copilot-pull-request-reviewer[bot]'],
    });
  });

  it('rejects Organization and unrelated reviewer events', () => {
    expect(isCopilotAck({ event: 'review_requested', requested_reviewer: {
      login: 'copilot-pull-request-reviewer', type: 'Organization',
    } })).toBe(false);
    expect(isCopilotAck({ event: 'review_requested', requested_reviewer: { login: 'someone' } })).toBe(false);
  });

  it.each(['Copilot', 'copilot-pull-request-reviewer[bot]', 'copilot-pull-request-reviewer']
    .flatMap(login => ['User', 'Organization', undefined].map(type => ({ login, type }))))(
    'rejects acknowledgment from $type reviewer $login', async reviewer => {
      const event = { id: 2, event: 'review_requested', requested_reviewer: reviewer };
      expect(isCopilotAck(event)).toBe(false);
      expect(await requestCopilotReview(fixture({ events: [event] })))
        .toMatchObject({ ok: false, outcome: 'no_ack' });
    });

  it('fails on polling errors rather than masking them', async () => {
    const deps = fixture();
    deps.github.paginate.mockImplementationOnce(async () => []).mockImplementationOnce(async () => [])
      .mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));
    expect(await requestCopilotReview(deps)).toMatchObject({ ok: false, outcome: 'request_failed' });
  });
});
