import { describe, it, expect } from 'vitest';
import {
  validateReviewPostRequest,
  validateReviewFollowUp,
} from '../../lib/matchReview/reviewRequestGuard.js';
import { CHAT_MESSAGE_MAX_CHARS } from '../../lib/chatRequest.js';

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

describe('validateReviewFollowUp (QA P2: shares chat message cap)', () => {
  it('accepts card requests and any follow-up within the cap', () => {
    expect(validateReviewFollowUp('')).toEqual({ ok: true });
    expect(validateReviewFollowUp('why did we lose the lane?')).toEqual({ ok: true });
    expect(validateReviewFollowUp('x'.repeat(CHAT_MESSAGE_MAX_CHARS))).toEqual({ ok: true });
  });

  it('rejects follow-ups longer than the chat message cap with message_too_long', () => {
    const result = validateReviewFollowUp('x'.repeat(CHAT_MESSAGE_MAX_CHARS + 1));
    expect(result).toEqual({ ok: false, status: 400, error: 'message_too_long' });
  });
});
