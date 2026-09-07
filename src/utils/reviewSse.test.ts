import { describe, it, expect } from 'vitest';
import { incompleteReviewStreamMessage, isReviewSseTerminal } from './reviewSse';
import { isTerminalStreamFinish, reviewAiUnavailableNotice } from '../../lib/matchReview/reviewStream.js';

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

  it('localizes non-destructive fallback notices for missing AI', () => {
    expect(reviewAiUnavailableNotice('zh', 'unconfigured')).toContain('未配置 API Key');
    expect(reviewAiUnavailableNotice('en', 'unconfigured')).toMatch(/API key not configured/i);
    expect(reviewAiUnavailableNotice('zh', 'provider')).toContain('AI 洞察生成失败');
    expect(reviewAiUnavailableNotice('en', 'provider')).toMatch(/AI insight generation failed/i);
  });
});
