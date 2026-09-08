import { describe, it, expect } from 'vitest';
import {
  findPrimaryReviewSession,
  getReviewSurfacePhase,
  reviewSurfaceProgressLabel,
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

describe('getReviewSurfacePhase', () => {
  it('progresses facts → insight → drill → complete', () => {
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
});

describe('reviewSurfaceProgressLabel', () => {
  it('returns Chinese progress copy for active phases', () => {
    expect(reviewSurfaceProgressLabel('insight', 'zh')).toContain('失误');
    expect(reviewSurfaceProgressLabel('complete', 'zh')).toBeNull();
  });
});
