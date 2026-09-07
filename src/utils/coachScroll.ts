import type { CoachSession } from '../components/coach/coachMessage';

const DEFAULT_PIN_THRESHOLD_PX = 120;

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
  ].join(':');
}

export interface CoachAutoScrollInput {
  visibleCount: number;
  prevVisibleCount: number;
  streamingFingerprint: string;
  prevStreamingFingerprint: string;
  pinnedNearBottom: boolean;
}

/**
 * Auto-scroll only when a new visible session appears, or streaming content grows
 * while the user remains pinned near the bottom.
 */
export function shouldAutoScrollCoachTimeline(input: CoachAutoScrollInput): boolean {
  const grew = input.visibleCount > input.prevVisibleCount;
  const contentGrew = input.streamingFingerprint !== ''
    && input.streamingFingerprint !== input.prevStreamingFingerprint;
  return grew || (contentGrew && input.pinnedNearBottom);
}
