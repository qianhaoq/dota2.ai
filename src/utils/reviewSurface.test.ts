import { describe, it, expect } from 'vitest';
import {
  findPrimaryReviewSession,
  getReviewSurfacePhase,
  reviewSurfaceProgressLabel,
  isPrimaryReviewReadyForFollowUp,
  reviewNoticeBlocks,
} from './reviewSurface';
import type { CoachSession } from '../components/coach/coachMessage';

const reviewSession = (over: Partial<CoachSession['message']> = {}, id = 'r1'): CoachSession => ({
  id,
  action: 'review',
  message: {
    id,
    type: 'coach',
    action: 'review',
    content: '',
    ...over,
  },
  blocks: [],
});

describe('findPrimaryReviewSession', () => {
  it('returns the latest non-follow-up review with matchFact or reviewCards', () => {
    const sessions = [
      reviewSession({ matchFact: { summary: { matchId: 1 } } as never }, 'a'),
      reviewSession({ reviewFollowUp: true, content: '追问' }, 'b'),
      reviewSession({ reviewCards: { match_summary: { matchId: 2 } } as never }, 'c'),
    ];
    expect(findPrimaryReviewSession(sessions)?.id).toBe('c');
  });

  it('skips follow-up-only sessions', () => {
    const sessions = [reviewSession({ reviewFollowUp: true, content: 'x' })];
    expect(findPrimaryReviewSession(sessions)).toBeNull();
  });
});

describe('isPrimaryReviewReadyForFollowUp', () => {
  it('blocks while primary review is streaming', () => {
    expect(isPrimaryReviewReadyForFollowUp({
      id: '1', type: 'coach', action: 'review', content: '', isStreaming: true,
      reviewCards: { match_summary: { matchId: 1 } as never },
    })).toBe(false);
  });

  it('blocks partial terminal review without mistake and drill', () => {
    expect(isPrimaryReviewReadyForFollowUp({
      id: '1', type: 'coach', action: 'review', content: '', isStreaming: false,
      reviewCards: { match_summary: { matchId: 1 } as never, phases: [] },
    })).toBe(false);
  });

  it('allows follow-up when mistake and drill are present', () => {
    expect(isPrimaryReviewReadyForFollowUp({
      id: '1', type: 'coach', action: 'review', content: '', isStreaming: false,
      reviewCards: {
        match_summary: { matchId: 1 } as never,
        primary_mistake: { headline: 'x' } as never,
        drill: { title: 'd', steps: [], duration: '5m' },
      },
    })).toBe(true);
  });
});

describe('getReviewSurfacePhase', () => {
  it('progresses facts → insight → drill → complete while streaming', () => {
    expect(getReviewSurfacePhase(null, true, true)).toBe('facts');
    expect(getReviewSurfacePhase({ match_summary: { matchId: 1 } as never }, true, true)).toBe('insight');
    expect(getReviewSurfacePhase({
      match_summary: { matchId: 1 } as never,
      primary_mistake: { headline: 'x' } as never,
    }, true, true)).toBe('drill');
    expect(getReviewSurfacePhase({
      match_summary: { matchId: 1 } as never,
      primary_mistake: { headline: 'x' } as never,
      drill: { title: 'd', steps: [], duration: '5m' },
      followups: ['a'],
    }, true, false)).toBe('complete');
  });

  it('returns complete when stream is terminal even with partial cards', () => {
    expect(getReviewSurfacePhase({ match_summary: { matchId: 1 } as never }, true, false)).toBe('complete');
    expect(getReviewSurfacePhase(null, true, false)).toBe('complete');
  });
});

describe('reviewSurfaceProgressLabel', () => {
  it('returns Chinese progress copy only while streaming', () => {
    expect(reviewSurfaceProgressLabel('insight', 'zh', true)).toContain('失误');
    expect(reviewSurfaceProgressLabel('insight', 'zh', false)).toBeNull();
    expect(reviewSurfaceProgressLabel('complete', 'zh', true)).toBeNull();
  });
});

describe('reviewNoticeBlocks', () => {
  it('extracts review notice markdown blocks', () => {
    const blocks = [
      { id: 'c1-review-notice', type: 'markdown' as const, title: '提示', markdown: 'AI unavailable' },
      { id: 'c1-ri-summary', type: 'reviewInsight' as const, reviewCardKind: 'match_summary' as const },
    ];
    expect(reviewNoticeBlocks(blocks)).toHaveLength(1);
    expect(reviewNoticeBlocks(blocks)[0].markdown).toBe('AI unavailable');
  });
});
