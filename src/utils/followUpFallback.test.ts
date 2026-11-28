import { describe, it, expect } from 'vitest';
import {
  decideFollowUpOutcome,
  reviewFollowUpFallbackNotice,
} from '../../lib/matchReview/followUpFallback.js';

describe('reviewFollowUpFallbackNotice', () => {
  it('is a short localized hint', () => {
    expect(reviewFollowUpFallbackNotice('zh')).toContain('追问');
    expect(reviewFollowUpFallbackNotice('zh')).toContain('比赛数据');
    expect(reviewFollowUpFallbackNotice('en')).toMatch(/match data/i);
    expect(reviewFollowUpFallbackNotice('en').length).toBeLessThan(120);
  });
});

describe('decideFollowUpOutcome', () => {
  it('ends normally on a clean provider finish with a terminal finish_reason', () => {
    for (const finishReason of ['stop', 'length', 'content_filter']) {
      expect(decideFollowUpOutcome({ status: 'done', finishReason, forwarded: true }))
        .toEqual({ action: 'end' });
    }
  });

  it('treats text-forwarded EOF without a terminal finish_reason as incomplete — template appended', () => {
    expect(decideFollowUpOutcome({ status: 'done', finishReason: null, forwarded: true }))
      .toEqual({ action: 'fallback', reason: 'incomplete', append: true });
    expect(decideFollowUpOutcome({ status: 'done', finishReason: undefined, forwarded: true }))
      .toEqual({ action: 'fallback', reason: 'incomplete', append: true });
    expect(decideFollowUpOutcome({ status: 'done', finishReason: 'tool_calls', forwarded: true }))
      .toEqual({ action: 'fallback', reason: 'incomplete', append: true });
  });

  it('ends on a non-terminal finish when no text was forwarded (empty streams are handled upstream)', () => {
    expect(decideFollowUpOutcome({ status: 'done', finishReason: null, forwarded: false }))
      .toEqual({ action: 'end' });
    expect(decideFollowUpOutcome({ status: 'done', finishReason: 'stop', forwarded: false }))
      .toEqual({ action: 'end' });
  });

  it('ends without writing when the caller stopped the stream (client gone)', () => {
    expect(decideFollowUpOutcome({ status: 'stopped', finishReason: 'stop', forwarded: true }))
      .toEqual({ action: 'end' });
    expect(decideFollowUpOutcome({ status: 'stopped', finishReason: null, forwarded: false }))
      .toEqual({ action: 'end' });
  });

  it('replaces the whole answer when every provider failed before any text', () => {
    expect(decideFollowUpOutcome({ status: 'failed', finishReason: null }))
      .toEqual({ action: 'fallback', reason: 'all_failed', append: false });
  });

  it('appends the template when the stream broke after partial text', () => {
    expect(decideFollowUpOutcome({ status: 'incomplete', finishReason: null }))
      .toEqual({ action: 'fallback', reason: 'incomplete', append: true });
  });

  it('defaults to a full-replacement fallback with no arguments', () => {
    expect(decideFollowUpOutcome()).toEqual({ action: 'fallback', reason: 'all_failed', append: false });
  });
});
