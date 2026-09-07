import React, { useMemo, useEffect, useRef, useCallback } from 'react';
import { Language, Hero } from '../../types';
import { RotateCcw } from 'lucide-react';
import type { CoachSession } from './coachMessage';
import { sessionTitle, filterVisibleSessions } from '../../utils/coachBlocks';
import {
  isScrollPinnedNearBottom,
  shouldAutoScrollCoachTimeline,
  streamingSessionFingerprint,
} from '../../utils/coachScroll';
import ResultCard from './ResultCard';

interface CoachCanvasProps {
  sessions: CoachSession[];
  dismissedSessionIds: ReadonlySet<string>;
  lastDismissedSessionId: string | null;
  lang: Language;
  allHeroes: Hero[];
  onSelectHero: (hero: Hero) => void;
  onDismissSession: (sessionId: string) => void;
  onUndoDismiss: () => void;
  mentorName?: string;
  scrollContainerRef?: React.RefObject<HTMLElement | null>;
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
  onDismissSession,
  onUndoDismiss,
  mentorName,
  scrollContainerRef,
}) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const undoRef = useRef<HTMLDivElement>(null);
  const prevVisibleCountRef = useRef(0);
  const prevStreamingFingerprintRef = useRef('');

  const visibleSessions = useMemo(
    () => filterVisibleSessions(sessions, dismissedSessionIds),
    [sessions, dismissedSessionIds],
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

  const isPinnedNearBottom = useCallback(() => {
    const el = scrollContainerRef?.current;
    if (!el) return true;
    return isScrollPinnedNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
  }, [scrollContainerRef]);

  useEffect(() => {
    const streamingSession = visibleSessions.find((s) => s.message.isStreaming);
    const fingerprint = streamingSessionFingerprint(streamingSession);
    const prevCount = prevVisibleCountRef.current;
    const grew = visibleSessions.length > prevCount;
    const shouldScroll = shouldAutoScrollCoachTimeline({
      visibleCount: visibleSessions.length,
      prevVisibleCount: prevCount,
      streamingFingerprint: fingerprint,
      prevStreamingFingerprint: prevStreamingFingerprintRef.current,
      pinnedNearBottom: isPinnedNearBottom(),
    });

    prevVisibleCountRef.current = visibleSessions.length;
    prevStreamingFingerprintRef.current = fingerprint;

    if (shouldScroll) {
      bottomRef.current?.scrollIntoView({ behavior: grew ? 'smooth' : 'auto', block: 'nearest' });
    }
  }, [visibleSessions, isPinnedNearBottom]);

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
        const dismissed = dismissedSessionIds.has(session.id);
        if (!dismissed) {
          return (
            <div key={session.id} className="px-0 sm:px-0">
              <ResultCard
                session={session}
                lang={lang}
                allHeroes={allHeroes}
                onSelectHero={onSelectHero}
                mentorName={mentorName}
                expanded
                onDismiss={() => onDismissSession(session.id)}
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
