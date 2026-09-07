import { describe, it, expect } from 'vitest';
import { incompleteReviewStreamMessage, isReviewSseTerminal } from './reviewSse';
import { isTerminalStreamFinish } from '../../lib/matchReview/reviewStream.js';

describe('reviewSse', () => {
  it('detects terminal DONE marker', () => {
    expect(isReviewSseTerminal('[DONE]')).toBe(true);
    expect(isReviewSseTerminal(' [DONE] ')).toBe(true);
    expect(isReviewSseTerminal('{"text":"hi"}')).toBe(false);
  });

  it('localizes incomplete stream message', () => {
    expect(incompleteReviewStreamMessage('zh')).toContain('未完成');
    expect(incompleteReviewStreamMessage('en')).toContain('incomplete');
  });

  it('requires terminal upstream finish_reason before treating stream as complete', () => {
    expect(isTerminalStreamFinish('stop')).toBe(true);
    expect(isTerminalStreamFinish('length')).toBe(true);
    expect(isTerminalStreamFinish(null)).toBe(false);
    expect(isTerminalStreamFinish(undefined)).toBe(false);
  });
});
