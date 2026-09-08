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

/** Notice blocks from reviewNotice / fallback warnings (not reviewInsight cards). */
export function reviewNoticeBlocks(blocks: A2UIBlock[]): A2UIBlock[] {
  return blocks.filter((b) => b.id.endsWith('-review-notice'));
}

export type ReviewFollowUpContext = { matchId: number; heroId?: number };
