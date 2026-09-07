import React, { useMemo, useEffect, useRef } from 'react';
import { Language, Hero } from '../../types';
import { RotateCcw } from 'lucide-react';
import type { CoachSession } from './coachMessage';
import { sessionTitle, filterVisibleSessions } from '../../utils/coachBlocks';
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
}

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
}) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);

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

  useEffect(() => {
    const streaming = visibleSessions.some((s) => s.message.isStreaming);
    const grew = visibleSessions.length > prevCountRef.current;
    prevCountRef.current = visibleSessions.length;
    if (streaming || grew) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [visibleSessions]);

  if (visibleSessions.length === 0 && !lastDismissedSession) {
    return null;
  }

  return (
    <div className="w-full min-w-0 space-y-3 pt-2 pb-2">
      {visibleSessions.length === 0 && (
        <p className="px-3 sm:px-4 text-center text-sm text-k3-text-tertiary">{t.empty}</p>
      )}

      {visibleSessions.map((session) => (
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
      ))}

      {lastDismissedSession && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-k3-border-subtle bg-k3-surface/60 text-xs text-k3-text-secondary min-w-0">
          <span className="truncate min-w-0">
            {t.dismissed}：{sessionTitle(lastDismissedSession, lang)}
          </span>
          <button
            type="button"
            onClick={onUndoDismiss}
            className="inline-flex items-center gap-1 text-k3-text-primary hover:text-k3-text-secondary flex-shrink-0 min-h-[36px] px-2 touch-manipulation"
          >
            <RotateCcw size={12} />
            {t.undo}
          </button>
        </div>
      )}

      <div ref={bottomRef} aria-hidden="true" className="h-px" />
    </div>
  );
};

export default CoachCanvas;
