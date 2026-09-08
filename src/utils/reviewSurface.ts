import type { CoachSession } from '../components/coach/coachMessage';
import type { CoachMessage } from '../components/coach/coachMessage';
import type { ReviewCardsPayload } from '../types/reviewCards';
import type { Language } from '../types';
import type { A2UIBlock } from '../types';

/** Primary review session (initial Fact→Insight→Drill), not follow-up markdown replies. */
export function findPrimaryReviewSession(sessions: CoachSession[]): CoachSession | null {
  for (let i = sessions.length - 1; i >= 0; i -= 1) {
    const s = sessions[i];
    if (s.action !== 'review' || s.message.reviewFollowUp) continue;
    if (s.message.matchFact || s.message.reviewCards || s.message.isStreaming) {
      return s;
    }
  }
  return null;
}

/** Primary review has finished streaming with mistake + drill — safe to accept follow-ups. */
export function isPrimaryReviewReadyForFollowUp(message?: CoachMessage): boolean {
  if (!message || message.action !== 'review' || message.reviewFollowUp) {
    return true;
  }
  if (message.isStreaming) return false;
  const cards = message.reviewCards;
  return Boolean(cards?.primary_mistake && cards?.drill);
}

export type ReviewSurfacePhase =
  | 'idle'
  | 'facts'
  | 'insight'
  | 'drill'
  | 'complete';

export function getReviewSurfacePhase(
  reviewCards?: ReviewCardsPayload | null,
  hasMatchFact?: boolean,
  isStreaming?: boolean,
): ReviewSurfacePhase {
  if (!isStreaming) return 'complete';
  if (!hasMatchFact && !reviewCards) return 'idle';
  if (!reviewCards) return 'facts';
  if (!reviewCards.primary_mistake) return 'insight';
  if (!reviewCards.drill) return 'drill';
  if (!reviewCards.followups?.length) return 'drill';
  return 'complete';
}

export function reviewSurfaceProgressLabel(
  phase: ReviewSurfacePhase,
  lang: Language,
  isStreaming?: boolean,
): string | null {
  if (!isStreaming || phase === 'complete' || phase === 'idle') return null;
  const zh: Record<ReviewSurfacePhase, string | null> = {
    idle: null,
    facts: '正在解读比赛数据…',
    insight: '正在提炼关键失误…',
    drill: '正在生成练习方案…',
    complete: null,
  };
  const en: Record<ReviewSurfacePhase, string | null> = {
    idle: null,
    facts: 'Reading match data…',
    insight: 'Distilling the key mistake…',
    drill: 'Building your drill…',
    complete: null,
  };
  const map = lang === 'zh' ? zh : en;
  return map[phase];
}

/** Fact spine blocks shown before reviewCards arrive (type: review). */
export function reviewFactSpineBlocks(blocks: A2UIBlock[]): A2UIBlock[] {
  return blocks.filter((b) => b.type === 'review' && b.reviewSection);
}

/** In-flight follow-up markdown stream for a completed primary review. */
export function findStreamingReviewFollowUp(sessions: CoachSession[]): CoachSession | null {
  for (let i = sessions.length - 1; i >= 0; i -= 1) {
    const s = sessions[i];
    if (s.action === 'review' && s.message.reviewFollowUp && s.message.isStreaming) {
      return s;
    }
  }
  return null;
}

/** Any coach session currently streaming (review, meta, analyze, etc.). */
export function findInflightCoachSession(sessions: CoachSession[]): CoachSession | null {
  for (let i = sessions.length - 1; i >= 0; i -= 1) {
    if (sessions[i].message.isStreaming) return sessions[i];
  }
  return null;
}

/** Safe to start or submit a new review follow-up (primary complete, none streaming). */
export function isReviewFollowUpAllowed(sessions: CoachSession[]): boolean {
  if (findStreamingReviewFollowUp(sessions)) return false;
  const primary = findPrimaryReviewSession(sessions);
  return isPrimaryReviewReadyForFollowUp(primary?.message);
}

/** Primary review session matching an explicit match/hero context (canvas history actions). */
export function findReviewSessionByContext(
  sessions: CoachSession[],
  context: ReviewFollowUpContext,
): CoachSession | null {
  for (let i = sessions.length - 1; i >= 0; i -= 1) {
    const s = sessions[i];
    if (s.action !== 'review' || s.message.reviewFollowUp) continue;
    const ctx = primaryReviewFollowUpContext(s);
    if (!ctx || ctx.matchId !== context.matchId) continue;
    if (
      context.heroId != null
      && ctx.heroId != null
      && ctx.heroId !== context.heroId
    ) {
      continue;
    }
    return s;
  }
  return null;
}

/** Composer / Surface / canvas may submit a follow-up for a specific review context. */
export function canSubmitReviewFollowUpForContext(
  sessions: CoachSession[],
  context?: ReviewFollowUpContext | null,
): boolean {
  if (findStreamingReviewFollowUp(sessions)) return false;
  const target = context
    ? findReviewSessionByContext(sessions, context)
    : findPrimaryReviewSession(sessions);
  if (!target) return false;
  if (!isPrimaryReviewReadyForFollowUp(target.message)) return false;
  return isReviewAiFollowUpAvailable(target.message, reviewNoticeBlocks(target.blocks));
}

/** Composer / Surface may submit a review follow-up (latest primary, allowed + AI available). */
export function canSubmitReviewFollowUp(sessions: CoachSession[]): boolean {
  return canSubmitReviewFollowUpForContext(sessions, null);
}

/** AI follow-up chips / composer actions are available (not fallback-only). */
export function isReviewAiFollowUpAvailable(
  message?: CoachMessage,
  noticeBlocks: A2UIBlock[] = [],
): boolean {
  if (!message || message.isStreaming) return false;
  if (noticeBlocks.length > 0) return false;
  const followups = message.reviewCards?.followups;
  return Boolean(followups && followups.length > 0);
}

/** Notice blocks from reviewNotice / fallback warnings (not reviewInsight cards). */
export function reviewNoticeBlocks(blocks: A2UIBlock[]): A2UIBlock[] {
  return blocks.filter((b) => b.id.endsWith('-review-notice'));
}

export type ReviewFollowUpContext = { matchId: number; heroId?: number };

/** Match context for the primary review shown in Review Surface. */
export function primaryReviewFollowUpContext(
  session: CoachSession | null | undefined,
): ReviewFollowUpContext | null {
  if (!session || session.action !== 'review' || session.message.reviewFollowUp) {
    return null;
  }
  const msg = session.message;
  const cards = msg.reviewCards;
  const matchId = cards?.match_summary?.matchId ?? msg.matchFact?.summary?.matchId;
  if (matchId == null) return null;
  return {
    matchId,
    heroId: cards?.match_summary?.heroId ?? msg.matchFact?.focusHeroId ?? undefined,
  };
}
