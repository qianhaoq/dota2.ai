import type { CoachMessage } from '../components/coach/coachMessage';
import type { MatchFact, ReviewParseStatus } from '../types/matchReview';

/**
 * Handle for an in-flight facts retry (GET /api/review/:id). The abort
 * controller is fired when the active review changes or the view unmounts;
 * ref identity doubles as the generation marker — a newer retry replaces it.
 */
export interface ReviewFactsRetryToken {
  controller: AbortController;
}

/**
 * A retry response may be applied only while its token is still the installed
 * one (not superseded by a newer retry) and its fetch was not aborted (review
 * changed / unmounted). A late response failing this check must be dropped —
 * applying it could clear a newer review's message and re-run the old match.
 */
export function isFactsRetryCurrent(
  installed: ReviewFactsRetryToken | null,
  token: ReviewFactsRetryToken,
): boolean {
  return installed === token && !token.controller.signal.aborted;
}

export interface ReviewFactsRefreshResult {
  /** Merge into the message via updateCoachMessage. */
  patch: Partial<CoachMessage>;
  /**
   * True when existing insight cards were generated from older (e.g. unparsed)
   * facts and were dropped — the caller should offer/trigger a re-review.
   */
  staleCleared: boolean;
  /** Hero the cleared review was bound to — pass to the re-review request. */
  heroId: number | null;
}

/**
 * Patch for a review message after a facts retry (GET /api/review/:id).
 *
 * messageToBlocks prefers reviewCards over the fact spine, so replacing only
 * matchFact/parseStatus would leave stale cards (generated from the unparsed
 * payload) on screen forever. When the refreshed fact is newly parsed or
 * differs from the fact the cards were generated from, drop the cards and the
 * stale notice so lanes/timeline re-render from the fresh fact.
 */
export function reviewFactsRefreshResult(
  prev: CoachMessage,
  next: { matchFact: MatchFact; parseStatus: ReviewParseStatus | null },
): ReviewFactsRefreshResult {
  const heroId = prev.reviewCards?.match_summary?.heroId
    ?? prev.matchFact?.focusHeroId
    ?? null;
  const wasParsed = prev.parseStatus?.status === 'parsed';
  const nowParsed = next.parseStatus?.status === 'parsed';
  const factChanged = JSON.stringify(prev.matchFact ?? null) !== JSON.stringify(next.matchFact);
  const staleCleared = Boolean(prev.reviewCards) && (factChanged || (nowParsed && !wasParsed));

  const patch: Partial<CoachMessage> = {
    matchFact: next.matchFact,
    parseStatus: next.parseStatus,
  };
  if (staleCleared) {
    patch.reviewCards = null;
    patch.error = undefined;
  }
  return { patch, staleCleared, heroId };
}
