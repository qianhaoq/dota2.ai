import type { LessonMode } from '../types';
import type { CoachSession } from '../components/coach/coachMessage';
import {
  canSubmitReviewFollowUp,
  isPrimaryReviewReadyForFollowUp,
} from './reviewSurface';

export interface CoachComposerStateInput {
  lesson: LessonMode;
  sessions: CoachSession[];
  isLoading: boolean;
  /** Session currently streaming (any action), if any. */
  inflightSession?: CoachSession | null;
  /** Primary review session pinned to the Review Surface, if any. */
  activeReviewSession?: CoachSession | null;
}

export interface CoachComposerState {
  /** Composer is bound to the pinned review (follow-up mode). */
  reviewFollowUpMode: boolean;
  /** A review follow-up can actually be submitted right now. */
  reviewFollowUpSubmittable: boolean;
  /** Primary review exists but ended before mistake + drill (cancel / error). */
  primaryReviewIncomplete: boolean;
  /** Keep the input editable while a review (or follow-up) streams. */
  allowInputWhileLoading: boolean;
  /** Hard-disable the input. Never true while the primary review is incomplete. */
  inputDisabled: boolean;
  /** Block send (primary review still streaming, or AI follow-up unavailable). */
  submitDisabled: boolean;
}

/**
 * 复盘取消 / 出错后输入框不得锁死：主复盘不完整时保持可输入，
 * 让用户能直接发起新的提问，而不是卡在复盘追问模式里。
 */
export function resolveCoachComposerState({
  lesson,
  sessions,
  isLoading,
  inflightSession,
  activeReviewSession,
}: CoachComposerStateInput): CoachComposerState {
  const reviewFollowUpSubmittable = canSubmitReviewFollowUp(sessions);
  const reviewFollowUpMode = lesson === 'review' && Boolean(activeReviewSession);
  const inflightIsReview = inflightSession?.action === 'review';
  const allowInputWhileLoading = isLoading && inflightIsReview && Boolean(activeReviewSession);
  const primaryReviewIncomplete = Boolean(activeReviewSession)
    && !isPrimaryReviewReadyForFollowUp(activeReviewSession?.message);

  const inputDisabled = reviewFollowUpMode
    && !reviewFollowUpSubmittable
    && !primaryReviewIncomplete
    && !(isLoading && inflightIsReview);

  const submitDisabled = reviewFollowUpMode
    && !reviewFollowUpSubmittable
    && (!primaryReviewIncomplete || isLoading);

  return {
    reviewFollowUpMode,
    reviewFollowUpSubmittable,
    primaryReviewIncomplete,
    allowInputWhileLoading,
    inputDisabled,
    submitDisabled,
  };
}

/**
 * Route composer submit through the review pipeline when:
 * - follow-up is ready (complete primary), or
 * - the user still holds retained match context after cancel / incomplete primary
 *   (restart/follow-up with that match id — never fall through to draft analyze).
 */
export function shouldSubmitReviewFollowUp(
  lesson: LessonMode,
  hasPendingContext: boolean,
  state: CoachComposerState,
  hasRetainedMatchContext = false,
): boolean {
  if (lesson !== 'review') return false;
  if (state.reviewFollowUpSubmittable) {
    return hasPendingContext || state.reviewFollowUpMode;
  }
  // Cancelled before follow-up-ready, or incomplete primary: keep match-scoped submit.
  return hasRetainedMatchContext;
}
