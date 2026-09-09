import type { DraftState, LessonMode } from '../types';

export type DraftSide = 'radiant' | 'dire';

export const EMPTY_DRAFT: DraftState = { radiant: [], dire: [] };

export function cloneDraft(draft: DraftState): DraftState {
  return {
    radiant: [...draft.radiant],
    dire: [...draft.dire],
  };
}

export function draftHasHeroes(draft: DraftState): boolean {
  return draft.radiant.length > 0 || draft.dire.length > 0;
}

export interface LessonDraftSwitchInput {
  currentLesson: LessonMode;
  nextLesson: LessonMode;
  liveDraft: DraftState;
  /** Intentional draft-only board saved when entering review. */
  snapshot: DraftState;
}

export interface LessonDraftSwitchResult {
  lesson: LessonMode;
  /** Board shown after the switch. */
  draft: DraftState;
  /** Snapshot to keep for the next leave-review restore. */
  snapshot: DraftState;
  /** True when leaving review — caller should bump contextRevision. */
  leavingReview: boolean;
  enteringReview: boolean;
  /** Clear composer when leaving review (stale follow-up text). */
  clearUserInput: boolean;
}

/**
 * Isolate review vs draft boards across lesson / tactical-workspace switches.
 * Entering review snapshots the intentional draft board.
 * Leaving review restores that snapshot (never carries review-click pollution).
 */
export function resolveLessonDraftSwitch({
  currentLesson,
  nextLesson,
  liveDraft,
  snapshot,
}: LessonDraftSwitchInput): LessonDraftSwitchResult {
  const leavingReview = currentLesson === 'review' && nextLesson !== 'review';
  const enteringReview = currentLesson !== 'review' && nextLesson === 'review';

  if (enteringReview) {
    return {
      lesson: nextLesson,
      draft: cloneDraft(liveDraft),
      snapshot: cloneDraft(liveDraft),
      leavingReview: false,
      enteringReview: true,
      clearUserInput: false,
    };
  }

  if (leavingReview) {
    return {
      lesson: nextLesson,
      draft: cloneDraft(snapshot),
      snapshot: cloneDraft(snapshot),
      leavingReview: true,
      enteringReview: false,
      clearUserInput: true,
    };
  }

  return {
    lesson: nextLesson,
    draft: liveDraft,
    snapshot,
    leavingReview: false,
    enteringReview: false,
    clearUserInput: false,
  };
}

/** Review / replay hero taps inspect only — they must not mutate the draft board. */
export function shouldAddHeroToDraft(action: string | undefined): boolean {
  return action === 'suggest' || action === 'analyze' || action === 'meta' || action === 'playbook';
}
