import type { CoachSession } from '../components/coach/coachMessage';
import type { ReviewCardsPayload } from '../types/reviewCards';

const DEFAULT_PIN_THRESHOLD_PX = 120;

/** Compact fingerprint of structured review-card growth during a review session. */
export function reviewCardsGrowthFingerprint(reviewCards?: ReviewCardsPayload | null): string {
  if (!reviewCards) return '0';
  return [
    reviewCards.phases?.length ?? 0,
    reviewCards.primary_mistake ? 1 : 0,
    reviewCards.key_moments?.length ?? 0,
    reviewCards.drill ? 1 : 0,
    reviewCards.followups?.length ?? 0,
    reviewCards.item_compare ? 1 : 0,
    reviewCards.farm_benchmarks ? 1 : 0,
    reviewCards.matchup_context ? 1 : 0,
  ].join(':');
}

/** Scroll target offset within a scroll container (container coordinate space). */
export function scrollOffsetWithinContainer(
  container: HTMLElement,
  target: HTMLElement,
  padding = 0,
): number {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  return container.scrollTop + (targetRect.top - containerRect.top) - padding;
}

/** Whether the scroll container is pinned near the bottom (user is following the stream). */
export function isScrollPinnedNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = DEFAULT_PIN_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/** Fingerprint for an in-flight streaming session; changes as chunks arrive. */
export function streamingSessionFingerprint(session: CoachSession | undefined): string {
  if (!session?.message.isStreaming) return '';
  const m = session.message;
  return [
    session.id,
    m.content.length,
    m.tierHeroes?.length ?? 0,
    m.playbookData?.length ?? 0,
    m.suggestions?.length ?? 0,
    m.matchFact ? 1 : 0,
    reviewCardsGrowthFingerprint(m.reviewCards),
  ].join(':');
}

/** Review-card fingerprint independent of isStreaming (covers batched onReviewCards + onComplete). */
export function reviewSessionCardsFingerprint(session: CoachSession | undefined): string {
  if (!session || session.message.action !== 'review') return '';
  const m = session.message;
  if (!m.reviewCards && !m.matchFact) return '';
  return [
    session.id,
    m.isStreaming ? 's' : 'd',
    m.content.length,
    m.matchFact ? 1 : 0,
    reviewCardsGrowthFingerprint(m.reviewCards),
  ].join(':');
}

/** Combined fingerprint for auto-scroll: streaming chunks or review-card growth. */
export function coachSessionScrollFingerprint(session: CoachSession | undefined): string {
  return streamingSessionFingerprint(session) || reviewSessionCardsFingerprint(session);
}

export type TimelineVisibilityKind = 'none' | 'append' | 'restore';

export interface TimelineVisibilityChange {
  kind: TimelineVisibilityKind;
  newlyVisibleIds: string[];
  scrollTargetId: string | null;
}

/**
 * Distinguish a brand-new session appended at the timeline tail from a previously
 * dismissed session becoming visible again (undo restore).
 */
export function classifyTimelineVisibilityChange(
  prevVisibleIds: ReadonlySet<string>,
  prevAllSessionIds: readonly string[],
  visibleSessionIds: readonly string[],
  allSessionIds: readonly string[],
): TimelineVisibilityChange {
  const newlyVisible = visibleSessionIds.filter((id) => !prevVisibleIds.has(id));
  if (newlyVisible.length === 0) {
    return { kind: 'none', newlyVisibleIds: [], scrollTargetId: null };
  }

  const sessionsGrew = allSessionIds.length > prevAllSessionIds.length;
  const tailId = allSessionIds[allSessionIds.length - 1] ?? null;
  const appendAtTail = sessionsGrew && tailId !== null && newlyVisible.includes(tailId);

  if (appendAtTail) {
    return { kind: 'append', newlyVisibleIds: newlyVisible, scrollTargetId: tailId };
  }

  const restoreId = newlyVisible.length === 1
    ? newlyVisible[0]
    : newlyVisible[newlyVisible.length - 1];

  return { kind: 'restore', newlyVisibleIds: newlyVisible, scrollTargetId: restoreId };
}

export interface CoachAutoScrollInput {
  appendedAtTail: boolean;
  streamingFingerprint: string;
  prevStreamingFingerprint: string;
  pinnedNearBottom: boolean;
}

/**
 * Auto-scroll to timeline bottom only when a session is appended at the tail, or
 * streaming content grows while the user was pinned near the bottom (snapshot from
 * scroll events, not post-commit measurement).
 */
export function shouldAutoScrollCoachTimeline(input: CoachAutoScrollInput): boolean {
  const contentGrew = input.streamingFingerprint !== ''
    && input.streamingFingerprint !== input.prevStreamingFingerprint;
  return input.appendedAtTail || (contentGrew && input.pinnedNearBottom);
}
