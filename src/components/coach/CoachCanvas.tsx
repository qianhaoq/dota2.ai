import React, { useMemo, useState, useEffect } from 'react';
import { Language, Hero } from '../../types';
import { ChevronDown, History } from 'lucide-react';
import type { CoachSession } from './coachMessage';
import { sessionTitle } from '../../utils/coachBlocks';
import ResultCard from './ResultCard';

interface CoachCanvasProps {
  sessions: CoachSession[];
  lang: Language;
  allHeroes: Hero[];
  onSelectHero: (hero: Hero) => void;
  mentorName?: string;
}

const CoachCanvas: React.FC<CoachCanvasProps> = ({
  sessions,
  lang,
  allHeroes,
  onSelectHero,
  mentorName,
}) => {
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const streaming = sessions.find((s) => s.message.isStreaming);
  const latest = sessions[sessions.length - 1];
  const active = streaming || sessions.find((s) => s.id === inspectedId) || latest;
  const older = sessions.filter((s) => s.id !== active?.id);

  useEffect(() => {
    if (streaming) {
      setInspectedId(streaming.id);
      setHistoryOpen(false);
    }
  }, [streaming?.id]);

  const t = useMemo(() => ({
    history: lang === 'zh' ? '历史结果' : 'Earlier results',
    hide: lang === 'zh' ? '收起历史' : 'Hide history',
    empty: lang === 'zh' ? '还没有分析卡片' : 'No result cards yet',
    generating: lang === 'zh' ? '生成中' : 'Streaming',
  }), [lang]);

  if (!active) {
    return (
      <div className="px-3 sm:px-4 py-6 text-center text-sm text-k3-text-tertiary">
        {t.empty}
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto w-full px-3 sm:px-4 py-3 sm:py-4 space-y-3 min-w-0">
      {older.length > 0 && (
        <div className="rounded-lg border border-k3-border-subtle bg-k3-surface/40 min-w-0">
          <button
            onClick={() => setHistoryOpen((v) => !v)}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-xs text-k3-text-secondary min-h-[40px] touch-manipulation"
          >
            <span className="inline-flex items-center gap-1.5">
              <History size={12} />
              {t.history}
              <span className="text-k3-text-tertiary">· {older.length}</span>
            </span>
            <ChevronDown size={14} className={`transition-transform ${historyOpen ? 'rotate-180' : ''}`} />
          </button>
          {historyOpen && (
            <div className="px-2 pb-2 flex flex-wrap gap-1.5">
              {older.map((session) => (
                <button
                  key={session.id}
                  onClick={() => {
                    setInspectedId(session.id);
                    setHistoryOpen(false);
                  }}
                  className="max-w-full truncate px-2.5 py-1.5 rounded-full border border-k3-border-subtle text-[11px] text-k3-text-secondary hover:text-k3-text-primary min-h-[36px] touch-manipulation"
                >
                  {sessionTitle(session, lang)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {active.message.isStreaming && (
        <p className="text-[11px] text-k3-text-tertiary px-1">{t.generating}</p>
      )}

      <ResultCard
        session={active}
        lang={lang}
        allHeroes={allHeroes}
        onSelectHero={onSelectHero}
        mentorName={mentorName}
        expanded
      />
    </div>
  );
};

export default CoachCanvas;
