import React, { useCallback, useState } from 'react';
import { CoachSession, ReviewWorkspace } from '../review';
import DraftWorkspace from '../draft/DraftWorkspace';
import Landing from './Landing';
import ItemTradeoffWorkspace from './ItemTradeoffWorkspace';
import { TACTICAL_WORKSPACE_ITEMS, tacticalWorkspaceLabel, type TacticalWorkspaceId } from '../../app/nav';
import type { Hero, Language, LessonMode } from '../../types';

export interface TacticalRoomProps {
  lang: Language;
  mentor: Hero | null;
  /** 想练一下 — navigates the shell to the training tab. */
  onOpenTraining: () => void;
  /** A note was saved; the shell shows a toast. */
  onNoteSaved: (toast: string) => void;
}

const workspaceLesson: Partial<Record<TacticalWorkspaceId, LessonMode>> = {
  review: 'review',
  draft: 'bp',
};

/**
 * 战术室 (DESIGN.md §2–3.4): motive landing + review / draft / items
 * workspaces. One shared CoachSession backs review and draft so streaming,
 * review surfaces and drafts survive workspace switches.
 */
const TacticalRoom: React.FC<TacticalRoomProps> = ({ lang, mentor, onOpenTraining, onNoteSaved }) => {
  const [workspace, setWorkspace] = useState<TacticalWorkspaceId>('start');
  const [lessonRequest, setLessonRequest] = useState<{ mode: LessonMode; nonce: number } | null>(null);

  const openWorkspace = useCallback((next: TacticalWorkspaceId) => {
    const lesson = workspaceLesson[next];
    if (lesson) {
      setLessonRequest((prev) => ({ mode: lesson, nonce: (prev?.nonce ?? 0) + 1 }));
    }
    setWorkspace(next);
  }, []);

  const coachVisible = workspace === 'review' || workspace === 'draft';
  const toast = lang === 'zh' ? '已保存到战术笔记' : 'Saved to the tactical journal';

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div
        className="flex-shrink-0 border-b border-v3-line bg-v3-base flex items-stretch gap-[2px] px-[8px] overflow-x-auto scrollbar-hide"
        role="tablist"
        aria-label={lang === 'zh' ? '战术室工作区' : 'Tactical room workspaces'}
      >
        {TACTICAL_WORKSPACE_ITEMS.map((item) => {
          const active = workspace === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => openWorkspace(item.id)}
              className={`relative px-[12px] min-h-[40px] text-[12px] whitespace-nowrap transition-colors duration-[120ms] touch-manipulation ${
                active ? 'text-v3-text' : 'text-v3-quiet hover:text-v3-muted'
              }`}
            >
              {tacticalWorkspaceLabel(item.id, lang)}
              <span
                aria-hidden="true"
                className={`absolute left-[12px] right-[12px] bottom-0 h-[2px] transition-opacity duration-[120ms] ${
                  active ? 'bg-v3-primary opacity-100' : 'opacity-0'
                }`}
              />
            </button>
          );
        })}
      </div>

      {/* Single shared coach session — hidden, never unmounted, outside review/draft. */}
      <div className={coachVisible ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
        {workspace === 'review' ? (
          <ReviewWorkspace lang={lang} />
        ) : workspace === 'draft' ? (
          <DraftWorkspace lang={lang} />
        ) : null}
        <div className="flex-1 min-h-0">
          <CoachSession lang={lang} lessonRequest={lessonRequest} />
        </div>
      </div>

      {workspace === 'start' && (
        <div className="flex-1 min-h-0">
          <Landing
            lang={lang}
            mentor={mentor}
            onReview={() => openWorkspace('review')}
            onDraft={() => openWorkspace('draft')}
            onTraining={onOpenTraining}
          />
        </div>
      )}

      {workspace === 'items' && (
        <div className="flex-1 min-h-0">
          <ItemTradeoffWorkspace lang={lang} onSaved={() => onNoteSaved(toast)} />
        </div>
      )}
    </div>
  );
};

export default TacticalRoom;
