import { describe, it, expect } from 'vitest';
import { incompleteReviewStreamMessage, isReviewSseTerminal } from './reviewSse';
import { isTerminalStreamFinish, reviewAiUnavailableNotice } from '../../lib/matchReview/reviewStream.js';
import {
  buildFollowUpFallbackText,
  followUpFallbackLeadLine,
  reviewFollowUpFallbackNotice,
} from '../../lib/matchReview/followUpFallback.js';

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
    expect(reviewAiUnavailableNotice('zh', 'invalid')).toContain('未通过校验');
    expect(reviewAiUnavailableNotice('en', 'invalid')).toMatch(/failed validation/i);
  });

  it('reviewNotice SSE is nonterminal and preserves grounded through DONE', () => {
    let isGrounded = false;
    let notice = '';
    let sawComplete = false;
    const lines = [
      'data: {"matchFact":{"summary":{}},"grounded":true}',
      'data: {"reviewCards":{},"grounded":true}',
      `data: {"reviewNotice":"${reviewAiUnavailableNotice('zh', 'unconfigured')}"}`,
      'data: [DONE]',
    ];
    for (const line of lines) {
      const data = line.slice(6).trim();
      if (data === '[DONE]') {
        sawComplete = true;
        break;
      }
      const parsed = JSON.parse(data);
      if (parsed.error) throw new Error('terminal error');
      if (parsed.reviewNotice) notice = parsed.reviewNotice;
      if (parsed.grounded !== undefined) isGrounded = parsed.grounded;
    }
    expect(sawComplete).toBe(true);
    expect(isGrounded).toBe(true);
    expect(notice).toContain('API Key');
  });
});

describe('review follow-up fallback SSE frames', () => {
  // Mirrors geminiService.processLine dispatch: text frames (with or without
  // fallback:true) append to the streamed message, reviewNotice frames are
  // nonterminal, and the sequence completes without an error frame.
  const drain = (lines: string[]) => {
    let chunks = '';
    let notice = '';
    let isGrounded: boolean | undefined;
    let sawComplete = false;
    let errored = false;
    for (const line of lines) {
      const data = line.slice(6).trim();
      if (isReviewSseTerminal(data)) {
        sawComplete = true;
        break;
      }
      const parsed = JSON.parse(data);
      if (parsed.error) {
        errored = true;
        break;
      }
      if (parsed.reviewNotice) notice = parsed.reviewNotice;
      if (typeof parsed.text === 'string' && parsed.text) chunks += parsed.text;
      if (parsed.grounded !== undefined) isGrounded = parsed.grounded;
    }
    return { chunks, notice, isGrounded, sawComplete, errored };
  };

  it('displays the full fallback template without erroring (no body streamed)', () => {
    const fallbackText = buildFollowUpFallbackText(null, null, 'en');
    const result = drain([
      `data: ${JSON.stringify({ text: fallbackText, grounded: true, fallback: true })}`,
      `data: ${JSON.stringify({ reviewNotice: reviewFollowUpFallbackNotice('en') })}`,
      'data: [DONE]',
    ]);
    expect(result.errored).toBe(false);
    expect(result.sawComplete).toBe(true);
    expect(result.chunks).toBe(fallbackText);
    expect(result.chunks).toContain('temporarily unavailable');
    expect(result.notice).toMatch(/match data/i);
    expect(result.isGrounded).toBe(true);
  });

  it('appends the fallback lead line after partial AI text without erroring', () => {
    const appendFrame = `\n${followUpFallbackLeadLine('zh')}`;
    const result = drain([
      'data: {"text":"前 12 分钟你方经济领先，","grounded":true}',
      `data: ${JSON.stringify({ text: appendFrame, grounded: true, fallback: true })}`,
      'data: [DONE]',
    ]);
    expect(result.errored).toBe(false);
    expect(result.sawComplete).toBe(true);
    expect(result.chunks).toBe(`前 12 分钟你方经济领先，${appendFrame}`);
    expect(result.chunks).toContain('AI 追问暂时不可用');
  });
});
