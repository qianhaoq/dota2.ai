import { describe, it, expect } from 'vitest';
import { resolveCoachComposerState, shouldSubmitReviewFollowUp } from './coachComposer';
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

const completeCards = {
  match_summary: { matchId: 1 } as never,
  primary_mistake: { headline: 'x' } as never,
  drill: { title: 'd', steps: [], duration: '5m' },
  followups: ['q'],
};

const partialCards = {
  match_summary: { matchId: 1 } as never,
  phases: [],
};

const baseInput = {
  lesson: 'review' as const,
  isLoading: false,
  inflightSession: null as CoachSession | null,
  activeReviewSession: null as CoachSession | null,
};

describe('resolveCoachComposerState', () => {
  it('keeps the composer neutral when no review is active', () => {
    const state = resolveCoachComposerState({ ...baseInput, lesson: 'bp', sessions: [] });
    expect(state.reviewFollowUpMode).toBe(false);
    expect(state.inputDisabled).toBe(false);
    expect(state.submitDisabled).toBe(false);
    expect(state.allowInputWhileLoading).toBe(false);
  });

  it('enables follow-up mode when the primary review is complete', () => {
    const active = reviewSession({ reviewCards: completeCards });
    const state = resolveCoachComposerState({
      ...baseInput,
      sessions: [active],
      activeReviewSession: active,
    });
    expect(state.reviewFollowUpMode).toBe(true);
    expect(state.reviewFollowUpSubmittable).toBe(true);
    expect(state.primaryReviewIncomplete).toBe(false);
    expect(state.inputDisabled).toBe(false);
    expect(state.submitDisabled).toBe(false);
  });

  it('never locks input after cancel leaves the primary review incomplete', () => {
    const active = reviewSession({
      isStreaming: false,
      matchFact: { summary: { matchId: 1 } } as never,
      reviewCards: partialCards as never,
    });
    const state = resolveCoachComposerState({
      ...baseInput,
      sessions: [active],
      activeReviewSession: active,
    });
    expect(state.reviewFollowUpMode).toBe(true);
    expect(state.reviewFollowUpSubmittable).toBe(false);
    expect(state.primaryReviewIncomplete).toBe(true);
    expect(state.inputDisabled).toBe(false);
    expect(state.submitDisabled).toBe(false);
  });

  it('never locks input after cancel before any structured payload arrived', () => {
    const active = reviewSession({ isStreaming: false, error: '已取消' });
    const sessions = [{
      ...active,
      blocks: [{ id: 'r1-review-notice', type: 'markdown' as const, markdown: '已取消' }],
    }];
    const state = resolveCoachComposerState({
      ...baseInput,
      sessions,
      activeReviewSession: active,
    });
    expect(state.reviewFollowUpSubmittable).toBe(false);
    expect(state.primaryReviewIncomplete).toBe(true);
    expect(state.inputDisabled).toBe(false);
    expect(state.submitDisabled).toBe(false);
  });

  it('keeps input enabled and send blocked while the primary review streams', () => {
    const active = reviewSession({
      isStreaming: true,
      reviewCards: partialCards as never,
    });
    const state = resolveCoachComposerState({
      ...baseInput,
      sessions: [active],
      isLoading: true,
      inflightSession: active,
      activeReviewSession: active,
    });
    expect(state.allowInputWhileLoading).toBe(true);
    expect(state.inputDisabled).toBe(false);
    expect(state.submitDisabled).toBe(true);
  });

  it('locks input only when AI follow-up is unavailable on a completed review', () => {
    const active = reviewSession({ reviewCards: completeCards });
    const sessions = [{
      ...active,
      blocks: [{ id: 'r1-review-notice', type: 'markdown' as const, markdown: 'AI unavailable' }],
    }];
    const state = resolveCoachComposerState({
      ...baseInput,
      sessions,
      activeReviewSession: active,
    });
    expect(state.primaryReviewIncomplete).toBe(false);
    expect(state.reviewFollowUpSubmittable).toBe(false);
    expect(state.inputDisabled).toBe(true);
    expect(state.submitDisabled).toBe(true);
  });

  it('keeps send blocked while a follow-up is streaming', () => {
    const active = reviewSession({ reviewCards: completeCards });
    const followUp = reviewSession({ reviewFollowUp: true, isStreaming: true, content: '…' }, 'fu');
    const state = resolveCoachComposerState({
      ...baseInput,
      sessions: [active, followUp],
      isLoading: true,
      inflightSession: followUp,
      activeReviewSession: active,
    });
    expect(state.allowInputWhileLoading).toBe(true);
    expect(state.submitDisabled).toBe(true);
    expect(state.inputDisabled).toBe(false);
  });

  it('disables input while a non-review request streams', () => {
    const meta: CoachSession = {
      id: 'm1',
      action: 'meta',
      message: { id: 'm1', type: 'coach', action: 'meta', content: '', isStreaming: true },
      blocks: [],
    };
    const state = resolveCoachComposerState({
      ...baseInput,
      lesson: 'bp',
      sessions: [meta],
      isLoading: true,
      inflightSession: meta,
    });
    expect(state.allowInputWhileLoading).toBe(false);
  });
});

describe('shouldSubmitReviewFollowUp', () => {
  it('routes to the review pipeline when follow-up is submittable', () => {
    const active = reviewSession({ reviewCards: completeCards });
    const ok = resolveCoachComposerState({
      ...baseInput, sessions: [active], activeReviewSession: active,
    });
    expect(shouldSubmitReviewFollowUp('review', false, ok)).toBe(true);
    expect(shouldSubmitReviewFollowUp('bp', false, ok)).toBe(false);
  });

  it('routes incomplete/cancelled primary through retained match context, not draft analyze', () => {
    const cancelled = reviewSession({ isStreaming: false, reviewCards: partialCards as never });
    const incomplete = resolveCoachComposerState({
      ...baseInput, sessions: [cancelled], activeReviewSession: cancelled,
    });
    expect(incomplete.primaryReviewIncomplete).toBe(true);
    expect(incomplete.reviewFollowUpSubmittable).toBe(false);
    // Without retained match id, do not claim the review submit path.
    expect(shouldSubmitReviewFollowUp('review', false, incomplete)).toBe(false);
    // With retained match context (activeReviewRef / pending), restart/follow-up.
    expect(shouldSubmitReviewFollowUp('review', false, incomplete, true)).toBe(true);
  });

  it('routes early cancel (no active session) when match context was retained', () => {
    const neutral = resolveCoachComposerState({ ...baseInput, sessions: [] });
    expect(neutral.reviewFollowUpMode).toBe(false);
    expect(shouldSubmitReviewFollowUp('review', false, neutral)).toBe(false);
    expect(shouldSubmitReviewFollowUp('review', false, neutral, true)).toBe(true);
  });

  it('honours a pending compose context even without a displayed review session', () => {
    const active = reviewSession({ reviewCards: completeCards });
    const state = resolveCoachComposerState({
      ...baseInput, sessions: [active], activeReviewSession: active,
    });
    expect(shouldSubmitReviewFollowUp('review', true, state)).toBe(true);
    const neutral = resolveCoachComposerState({ ...baseInput, sessions: [] });
    // Pending alone is not enough when follow-up is not submittable; need retained match.
    expect(shouldSubmitReviewFollowUp('review', true, neutral)).toBe(false);
    expect(shouldSubmitReviewFollowUp('review', true, neutral, true)).toBe(true);
  });
});
