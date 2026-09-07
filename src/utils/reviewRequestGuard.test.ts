import { describe, it, expect } from 'vitest';
import { validateReviewPostRequest } from '../../lib/matchReview/reviewRequestGuard.js';

describe('validateReviewPostRequest', () => {
  it('allows same-origin POST with application/json', () => {
    const result = validateReviewPostRequest({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: 'dota2.ai',
        origin: 'https://dota2.ai',
      },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects POST without application/json content-type', () => {
    const result = validateReviewPostRequest({
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        'content-type': 'text/plain',
        host: 'dota2.ai',
      },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(415);
  });

  it('rejects cross-origin POST even with SSE accept', () => {
    const result = validateReviewPostRequest({
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        host: 'dota2.ai',
        origin: 'https://evil.example',
      },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });
});
