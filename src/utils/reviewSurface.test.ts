import { describe, it, expect } from 'vitest';
import {
  findPrimaryReviewSession,
  getReviewSurfacePhase,
  reviewSurfaceProgressLabel,
  isPrimaryReviewReadyForFollowUp,
  reviewNoticeBlocks,
  reviewFactSpineBlocks,
  findStreamingReviewFollowUp,
  isReviewFollowUpAllowed,
  isReviewAiFollowUpAvailable,
  canSubmitReviewFollowUp,
  canSubmitReviewFollowUpForContext,
  findReviewSessionById,
  findInflightCoachSession,
  primaryReviewFollowUpContext,
  shouldShowReviewSurfaceProgress,
  isReviewSurfaceStoppedEarly,
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

describe('shouldShowReviewSurfaceProgress', () => {
  const partialReview = {
    id: '1', type: 'coach' as const, action: 'review' as const, content: '',
    isStreaming: true,
    reviewCards: { match_summary: { matchId: 1 } as never, phases: [] },
  };

  it('hides progress after matchFact arrives but stream is terminal', () => {
    expect(shouldShowReviewSurfaceProgress(
      { ...partialReview, isStreaming: false },
      'insight',
      false,
    )).toBe(false);
  });

  it('hides progress when session has an error even if isStreaming is stale', () => {
    expect(shouldShowReviewSurfaceProgress(
      { ...partialReview, error: '已取消' },
      'insight',
      true,
    )).toBe(false);
  });

  it('shows progress only for active streaming insight phase', () => {
    expect(shouldShowReviewSurfaceProgress(partialReview, 'insight', true)).toBe(true);
  });
});

describe('isReviewSurfaceStoppedEarly', () => {
  it('is true for terminal review with summary but no mistake/drill', () => {
    expect(isReviewSurfaceStoppedEarly({
      id: '1', type: 'coach', action: 'review', content: '', isStreaming: false,
      reviewCards: { match_summary: { matchId: 1 } as never, phases: [] },
    })).toBe(true);
  });

  it('is false while streaming', () => {
    expect(isReviewSurfaceStoppedEarly({
      id: '1', type: 'coach', action: 'review', content: '', isStreaming: true,
      reviewCards: { match_summary: { matchId: 1 } as never },
    })).toBe(false);
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

describe('reviewFactSpineBlocks', () => {
  it('returns review section blocks only', () => {
    const blocks = [
      { id: 'a', type: 'review' as const, reviewSection: 'summary' as const, markdown: 'x' },
      { id: 'b', type: 'reviewInsight' as const, reviewCardKind: 'match_summary' as const },
    ];
    expect(reviewFactSpineBlocks(blocks)).toHaveLength(1);
    expect(reviewFactSpineBlocks(blocks)[0].id).toBe('a');
  });
});

describe('findStreamingReviewFollowUp', () => {
  it('finds in-flight follow-up session', () => {
    const sessions = [
      reviewSession({ reviewCards: { drill: { title: 'd', steps: [], duration: '5m' }, primary_mistake: { headline: 'x' } as never, match_summary: { matchId: 1 } as never } }, 'primary'),
      reviewSession({ reviewFollowUp: true, isStreaming: true, content: 'partial' }, 'fu'),
    ];
    expect(findStreamingReviewFollowUp(sessions)?.id).toBe('fu');
  });
});

describe('isReviewFollowUpAllowed', () => {
  it('blocks while a follow-up is streaming', () => {
    const sessions = [
      reviewSession({
        reviewCards: {
          match_summary: { matchId: 1 } as never,
          primary_mistake: { headline: 'x' } as never,
          drill: { title: 'd', steps: [], duration: '5m' },
        },
      }, 'primary'),
      reviewSession({ reviewFollowUp: true, isStreaming: true, content: '…' }, 'fu'),
    ];
    expect(isReviewFollowUpAllowed(sessions)).toBe(false);
  });

  it('allows when primary complete and no streaming follow-up', () => {
    const sessions = [
      reviewSession({
        reviewCards: {
          match_summary: { matchId: 1 } as never,
          primary_mistake: { headline: 'x' } as never,
          drill: { title: 'd', steps: [], duration: '5m' },
          followups: ['q'],
        },
      }),
    ];
    expect(isReviewFollowUpAllowed(sessions)).toBe(true);
  });
});

describe('primaryReviewFollowUpContext', () => {
  it('derives matchId and heroId from the displayed primary session', () => {
    const session = reviewSession({
      reviewCards: {
        match_summary: { matchId: 8985182860, heroId: 54 } as never,
        primary_mistake: { headline: 'x' } as never,
        drill: { title: 'd', steps: [], duration: '5m' },
      },
    });
    expect(primaryReviewFollowUpContext(session)).toEqual({
      sessionId: 'r1',
      matchId: 8985182860,
      heroId: 54,
    });
  });

  it('falls back to matchFact when summary card is missing', () => {
    const session = reviewSession({
      matchFact: { summary: { matchId: 123 }, focusHeroId: 7 } as never,
    });
    expect(primaryReviewFollowUpContext(session)).toEqual({
      sessionId: 'r1',
      matchId: 123,
      heroId: 7,
    });
  });
});

describe('canSubmitReviewFollowUp', () => {
  it('returns false when review notice blocks AI follow-ups', () => {
    const sessions = [
      {
        ...reviewSession({
          reviewCards: {
            match_summary: { matchId: 1 } as never,
            primary_mistake: { headline: 'x' } as never,
            drill: { title: 'd', steps: [], duration: '5m' },
            followups: ['q'],
          },
        }),
        blocks: [
          { id: 'r1-review-notice', type: 'markdown' as const, markdown: 'AI unavailable' },
        ],
      },
    ];
    expect(canSubmitReviewFollowUp(sessions)).toBe(false);
  });

  it('returns true when primary complete, AI available, no streaming follow-up', () => {
    const sessions = [
      reviewSession({
        reviewCards: {
          match_summary: { matchId: 1 } as never,
          primary_mistake: { headline: 'x' } as never,
          drill: { title: 'd', steps: [], duration: '5m' },
          followups: ['q'],
        },
      }),
    ];
    expect(canSubmitReviewFollowUp(sessions)).toBe(true);
  });
});

const completeReviewCards = {
  match_summary: { matchId: 8985182860, heroId: 54 } as never,
  primary_mistake: { headline: 'x' } as never,
  drill: { title: 'd', steps: [], duration: '5m' },
  followups: ['q'],
};

describe('findReviewSessionById', () => {
  it('returns the exact primary review session', () => {
    const sessions = [
      reviewSession({ reviewCards: completeReviewCards }, 'older'),
      reviewSession({
        reviewCards: { ...completeReviewCards, match_summary: { matchId: 2, heroId: 7 } as never },
      }, 'newer'),
    ];
    expect(findReviewSessionById(sessions, 'older')?.id).toBe('older');
    expect(findReviewSessionById(sessions, 'missing')).toBeNull();
  });
});

describe('canSubmitReviewFollowUpForContext', () => {
  const ctxA = { sessionId: 'review-a', matchId: 8985182860, heroId: 54 };

  it('allows follow-up on older completed review when latest primary is partial', () => {
    const sessions = [
      reviewSession({ reviewCards: completeReviewCards }, 'review-a'),
      reviewSession({
        isStreaming: false,
        reviewCards: { match_summary: { matchId: 2 } as never, phases: [] },
      }, 'review-b'),
    ];
    expect(canSubmitReviewFollowUp(sessions)).toBe(false);
    expect(canSubmitReviewFollowUpForContext(sessions, ctxA)).toBe(true);
  });

  it('validates the exact session when the same match is reviewed twice', () => {
    const sessions = [
      reviewSession({ reviewCards: completeReviewCards }, 'review-first'),
      reviewSession({
        isStreaming: false,
        reviewCards: {
          match_summary: completeReviewCards.match_summary,
          phases: [],
        },
      }, 'review-second'),
    ];
    expect(canSubmitReviewFollowUpForContext(sessions, {
      sessionId: 'review-first',
      matchId: 8985182860,
      heroId: 54,
    })).toBe(true);
    expect(canSubmitReviewFollowUpForContext(sessions, {
      sessionId: 'review-second',
      matchId: 8985182860,
      heroId: 54,
    })).toBe(false);
  });

  it('allows follow-up on older completed review when latest primary is fallback-only', () => {
    const sessions = [
      reviewSession({ reviewCards: completeReviewCards }, 'review-a'),
      {
        ...reviewSession({
          reviewCards: {
            match_summary: { matchId: 2 } as never,
            primary_mistake: { headline: 'x' } as never,
            drill: { title: 'd', steps: [], duration: '5m' },
          },
        }, 'review-b'),
        blocks: [{ id: 'r2-review-notice', type: 'markdown' as const, markdown: 'AI unavailable' }],
      },
    ];
    expect(canSubmitReviewFollowUpForContext(sessions, ctxA)).toBe(true);
    expect(canSubmitReviewFollowUpForContext(sessions, {
      sessionId: 'review-b',
      matchId: 2,
    })).toBe(false);
  });

  it('blocks all follow-ups while a review follow-up is streaming', () => {
    const sessions = [
      reviewSession({ reviewCards: completeReviewCards }, 'review-a'),
      reviewSession({ reviewFollowUp: true, isStreaming: true, content: '…' }, 'follow-up'),
    ];
    expect(canSubmitReviewFollowUpForContext(sessions, ctxA)).toBe(false);
  });

  it('blocks follow-up when targeted review is incomplete', () => {
    const sessions = [
      reviewSession({
        reviewCards: { match_summary: { matchId: 8985182860 } as never, phases: [] },
      }, 'review-a'),
    ];
    expect(canSubmitReviewFollowUpForContext(sessions, ctxA)).toBe(false);
  });
});

describe('findInflightCoachSession', () => {
  it('returns the latest streaming session', () => {
    const sessions = [
      reviewSession({ isStreaming: false }, 'done'),
      { id: 'meta', action: 'meta' as const, message: { id: 'meta', type: 'coach' as const, action: 'meta' as const, content: '', isStreaming: true }, blocks: [] },
    ];
    expect(findInflightCoachSession(sessions)?.id).toBe('meta');
  });
});

describe('isReviewAiFollowUpAvailable', () => {
  it('returns false when review notice is present', () => {
    const message = {
      id: '1', type: 'coach' as const, action: 'review' as const, content: '',
      reviewCards: { followups: ['a'], drill: { title: 'd', steps: [], duration: '5m' }, primary_mistake: { headline: 'x' } as never, match_summary: { matchId: 1 } as never },
    };
    const notices = [{ id: 'c1-review-notice', type: 'markdown' as const, markdown: 'AI unavailable' }];
    expect(isReviewAiFollowUpAvailable(message, notices)).toBe(false);
  });

  it('returns false when followups array is empty', () => {
    const message = {
      id: '1', type: 'coach' as const, action: 'review' as const, content: '',
      reviewCards: { followups: [], drill: { title: 'd', steps: [], duration: '5m' }, primary_mistake: { headline: 'x' } as never, match_summary: { matchId: 1 } as never },
    };
    expect(isReviewAiFollowUpAvailable(message, [])).toBe(false);
  });

  it('returns true when followups exist and no notice', () => {
    const message = {
      id: '1', type: 'coach' as const, action: 'review' as const, content: '',
      reviewCards: { followups: ['展开节点'], drill: { title: 'd', steps: [], duration: '5m' }, primary_mistake: { headline: 'x' } as never, match_summary: { matchId: 1 } as never },
    };
    expect(isReviewAiFollowUpAvailable(message, [])).toBe(true);
  });
});
