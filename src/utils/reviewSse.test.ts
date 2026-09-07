import { describe, it, expect } from 'vitest';
import { incompleteReviewStreamMessage, isReviewSseTerminal } from './reviewSse';

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
});
