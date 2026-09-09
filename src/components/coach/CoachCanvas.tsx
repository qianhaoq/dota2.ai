import React, { useMemo, useEffect, useRef, useCallback } from 'react';
import { Language, Hero } from '../../types';
import { RotateCcw } from 'lucide-react';
import type { CoachSession } from './coachMessage';
import { sessionTitle, filterVisibleSessions } from '../../utils/coachBlocks';
import {
  classifyTimelineVisibilityChange,
  isScrollPinnedNearBottom,
  shouldAutoScrollCoachTimeline,
  streamingSessionFingerprint,
  coachSessionScrollFingerprint,
} from '../../utils/coachScroll';
import ResultCard from './ResultCard';
import { findPrimaryReviewSession, type ReviewFollowUpContext } from '../../utils/reviewSurface';

interface CoachCanvasProps {
  sessions: CoachSession[];
  dismissedSessionIds: ReadonlySet<string>;
  lastDismissedSessionId: string | null;
  lang: Language;
  allHeroes: Hero[];
  onSelectHero: (hero: Hero) => void;
  onInspectHero?: (heroId: number) => void;
  onDismissSession: (sessionId: string) => void;
  onUndoDismiss: () => void;
  mentorName?: string;
  scrollContainerRef?: React.RefObject<HTMLElement | null>;
  onReviewFollowUp?: (question: string, context: ReviewFollowUpContext) => void;
  canSubmitReviewFollowUpForContext?: (context: ReviewFollowUpContext) => boolean;
}

const UndoStrip: React.FC<{
  title: string;
  undoLabel: string;
  dismissedLabel: string;
  onUndo: () => void;
  innerRef?: React.Ref<HTMLDivElement>;
}> = ({ title, undoLabel, dismissedLabel, onUndo, innerRef }) => (
  <div
    ref={innerRef}
    className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-k3-border-subtle bg-k3-surface/60 text-xs text-k3-text-secondary min-w-0"
  >
    <span className="truncate min-w-0">
      {dismissedLabel}：{title}
    </span>
    <button
      type="button"
      onClick={onUndo}
      className="inline-flex items-center gap-1 text-k3-text-primary hover:text-k3-text-secondary flex-shrink-0 min-h-[36px] px-2 touch-manipulation"
    >
      <RotateCcw size={12} />
      {undoLabel}
    </button>
  </div>
);

const CoachCanvas: React.FC<CoachCanvasProps> = ({
  sessions,
  dismissedSessionIds,
  lastDismissedSessionId,
  lang,
  allHeroes,
  onSelectHero,
  onInspectHero,
  onDismissSession,
  onUndoDismiss,
  mentorName,
  scrollContainerRef,
  onReviewFollowUp,
  canSubmitReviewFollowUpForContext,
}) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const undoRef = useRef<HTMLDivElement>(null);
  const sessionNodeRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevVisibleIdsRef = useRef<Set<string>>(new Set());
  const prevAllSessionIdsRef = useRef<string[]>([]);
  const prevStreamingFingerprintRef = useRef('');
  const pinnedNearBottomRef = useRef(true);

  const primaryReviewSession = useMemo(
    () => findPrimaryReviewSession(sessions),
    [sessions],
  );

  const visibleSessions = useMemo(
    () => filterVisibleSessions(sessions, dismissedSessionIds)
      .filter((s) => !(primaryReviewSession && s.id === primaryReviewSession.id && !s.message.reviewFollowUp)),
    [sessions, dismissedSessionIds, primaryReviewSession],
  );

  const lastDismissedSession = useMemo(
    () => (lastDismissedSessionId ? sessions.find((s) => s.id === lastDismissedSessionId) : null),
    [sessions, lastDismissedSessionId],
  );

  const t = useMemo(() => ({
    empty: lang === 'zh' ? '还没有分析卡片' : 'No result cards yet',
    dismissed: lang === 'zh' ? '已收起结果' : 'Result dismissed',
    undo: lang === 'zh' ? '撤销' : 'Undo',
  }), [lang]);

  const bindSessionNode = useCallback((sessionId: string, node: HTMLDivElement | null) => {
    if (node) {
      sessionNodeRefs.current.set(sessionId, node);
    } else {
      sessionNodeRefs.current.delete(sessionId);
    }
  }, []);

  useEffect(() => {
    const el = scrollContainerRef?.current;
    if (!el) return undefined;

    const updatePinnedSnapshot = () => {
      pinnedNearBottomRef.current = isScrollPinnedNearBottom(
        el.scrollTop,
        el.scrollHeight,
        el.clientHeight,
      );
    };

    updatePinnedSnapshot();
    el.addEventListener('scroll', updatePinnedSnapshot, { passive: true });
    return () => el.removeEventListener('scroll', updatePinnedSnapshot);
  }, [scrollContainerRef]);

  useEffect(() => {
    const visibleIds = visibleSessions.map((s) => s.id);
    const allIds = sessions.map((s) => s.id);
    const visibilityChange = classifyTimelineVisibilityChange(
      prevVisibleIdsRef.current,
      prevAllSessionIdsRef.current,
      visibleIds,
      allIds,
    );

    const streamingSession = visibleSessions.find((s) => s.message.isStreaming);
    const reviewSession = visibleSessions.find((s) => s.message.action === 'review' && (s.message.reviewCards || s.message.matchFact));
    const fingerprint = coachSessionScrollFingerprint(streamingSession)
      || coachSessionScrollFingerprint(reviewSession);
    const shouldScrollBottom = shouldAutoScrollCoachTimeline({
      appendedAtTail: visibilityChange.kind === 'append',
      streamingFingerprint: fingerprint,
      prevStreamingFingerprint: prevStreamingFingerprintRef.current,
      pinnedNearBottom: pinnedNearBottomRef.current,
    });

    prevVisibleIdsRef.current = new Set(visibleIds);
    prevAllSessionIdsRef.current = allIds;
    prevStreamingFingerprintRef.current = fingerprint;

    if (visibilityChange.kind === 'restore' && visibilityChange.scrollTargetId) {
      sessionNodeRefs.current.get(visibilityChange.scrollTargetId)?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
      return;
    }

    if (shouldScrollBottom) {
      bottomRef.current?.scrollIntoView({
        behavior: visibilityChange.kind === 'append' ? 'smooth' : 'auto',
        block: 'nearest',
      });
    }
  }, [visibleSessions, sessions]);

  useEffect(() => {
    if (!lastDismissedSessionId) return;
    undoRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [lastDismissedSessionId]);

  if (visibleSessions.length === 0 && !lastDismissedSession) {
    return null;
  }

  return (
    <div className="w-full min-w-0 space-y-3 pt-2 pb-2">
      {visibleSessions.length === 0 && (
        <p className="px-3 sm:px-4 text-center text-sm text-k3-text-tertiary">{t.empty}</p>
      )}

      {sessions.map((session) => {
        const isPrimaryReview = primaryReviewSession
          && session.id === primaryReviewSession.id
          && !session.message.reviewFollowUp;
        const dismissed = dismissedSessionIds.has(session.id);

        if (isPrimaryReview) {
          if (dismissed && session.id === lastDismissedSessionId) {
            return (
              <UndoStrip
                key={`undo-${session.id}`}
                innerRef={undoRef}
                title={sessionTitle(session, lang)}
                dismissedLabel={t.dismissed}
                undoLabel={t.undo}
                onUndo={onUndoDismiss}
              />
            );
          }
          return null;
        }

        if (!dismissed) {
          return (
            <div
              key={session.id}
              ref={(node) => bindSessionNode(session.id, node)}
              className="px-0 sm:px-0"
            >
              <ResultCard
                session={session}
                lang={lang}
                allHeroes={allHeroes}
                onSelectHero={onSelectHero}
                onInspectHero={onInspectHero}
                mentorName={mentorName}
                expanded
                onDismiss={() => onDismissSession(session.id)}
                onReviewFollowUp={onReviewFollowUp}
                canSubmitReviewFollowUpForContext={canSubmitReviewFollowUpForContext}
              />
            </div>
          );
        }

        if (session.id === lastDismissedSessionId) {
          return (
            <UndoStrip
              key={`undo-${session.id}`}
              innerRef={undoRef}
              title={sessionTitle(session, lang)}
              dismissedLabel={t.dismissed}
              undoLabel={t.undo}
              onUndo={onUndoDismiss}
            />
          );
        }

        return null;
      })}

      <div ref={bottomRef} aria-hidden="true" className="h-px" />
    </div>
  );
};

export default CoachCanvas;
