import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import MentorRail from './MentorRail';
import { NAV_ITEMS, isNavId, navLabel, type NavId } from './nav';
import { findMentor, useHeroes } from './useHeroes';
import TacticalRoom from '../features/tactical/TacticalRoom';
import TrainingWorkspace from '../features/practice/TrainingWorkspace';
import { KnowledgeWorkspace } from '../features/knowledge';
import JournalWorkspace from '../features/journal/JournalWorkspace';
import { QUOTES } from './mentorQuotes';
import type { Language } from '../types';

export interface WorkspaceShellProps {
  lang: Language;
  onToggleLang: () => void;
}

const VISITED_INIT: Record<NavId, boolean> = {
  tactical: true,
  training: false,
  knowledge: false,
  journal: false,
};

/**
 * V3 stable workspaces (DESIGN.md §2). Desktop: top nav + mentor rail +
 * workspace. Mobile: bottom 4-item nav with labels, mentor compressed to one
 * line. Panes mount on first visit and then stay mounted (hidden), so review
 * sessions, drafts, training drills and knowledge browsing never unload each
 * other.
 */
const WorkspaceShell: React.FC<WorkspaceShellProps> = ({ lang, onToggleLang }) => {
  const [nav, setNav] = useState<NavId>('tactical');
  const [visited, setVisited] = useState<Record<NavId, boolean>>(VISITED_INIT);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { heroes } = useHeroes(lang);
  const mentor = findMentor(heroes);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const openNav = useCallback((next: NavId) => {
    setVisited((prev) => (prev[next] ? prev : { ...prev, [next]: true }));
    setNav(next);
  }, []);

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  // Deep-link support: #tactical / #training / #knowledge / #journal.
  useEffect(() => {
    const apply = () => {
      const hash = window.location.hash.replace(/^#/, '');
      if (isNavId(hash)) openNav(hash);
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, [openNav]);

  const brand = 'DOTA2.AI';
  const mentorLine = QUOTES[nav][lang === 'zh' ? 'zh' : 'en'];
  const langToggleLabel = lang === 'en' ? '切换语言' : 'Switch language';

  return (
    <div className="h-full min-h-0 flex flex-col bg-v3-base text-v3-text overflow-hidden px-safe">
      <header className="flex-shrink-0 border-b border-v3-line bg-v3-base pt-safe">
        <div className="h-[48px] flex items-center justify-between gap-[8px] px-[12px] md:px-[20px] min-w-0">
          <div className="flex items-center gap-[16px] min-w-0">
            <button
              type="button"
              onClick={() => openNav('tactical')}
              className="v3-display text-[14px] tracking-[0.08em] text-v3-text min-h-[40px] touch-manipulation"
              aria-label="DOTA2.AI"
            >
              {brand}
              <span className="text-v3-quiet"> · V3</span>
            </button>
            <nav className="hidden md:flex items-center gap-[2px]" aria-label={lang === 'zh' ? '主导航' : 'Main navigation'}>
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => openNav(item.id)}
                  aria-current={nav === item.id ? 'page' : undefined}
                  className={`v3-nav-item ${nav === item.id ? 'v3-nav-item-active' : ''}`}
                >
                  <span aria-hidden="true" className="text-v3-gold text-[11px]">{item.symbol}</span>
                  {navLabel(item, lang)}
                </button>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-[8px] flex-shrink-0">
            <span className="v3-tag v3-tag-demo hidden sm:inline-flex">{lang === 'zh' ? '教学演示徽章 = 非真实数据' : 'Demo badge = not live data'}</span>
            <button
              type="button"
              onClick={onToggleLang}
              className="v3-btn v3-btn-quiet min-h-[40px] px-[10px]"
              aria-label={langToggleLabel}
            >
              <Globe size={14} />
              <span>{lang === 'en' ? 'EN' : '中'}</span>
            </button>
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex">
        <MentorRail lang={lang} section={nav} mentor={mentor} />

        <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* Mobile: the mentor compresses to one line (DESIGN.md §2). */}
          <div className="lg:hidden flex-shrink-0 flex items-center gap-[10px] px-[16px] py-[8px] border-b border-v3-line bg-v3-panel">
            {mentor?.icon || mentor?.img ? (
              <img
                src={mentor.icon || mentor.img}
                alt=""
                aria-hidden="true"
                className="w-[24px] h-[24px] rounded-[3px] object-cover"
                loading="lazy"
              />
            ) : (
              <span aria-hidden="true" className="text-v3-gold text-[13px] w-[24px] h-[24px] flex items-center justify-center">◇</span>
            )}
            <span className="text-[11px] leading-[17px] text-v3-muted truncate">
              <strong className="text-v3-text font-medium">{lang === 'zh' ? '拉比克' : 'Rubick'}</strong>
              <span className="text-v3-quiet"> · {mentorLine}</span>
            </span>
          </div>

          <div className="flex-1 min-h-0 flex flex-col">
            {visited.tactical && (
              <div className={nav === 'tactical' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
                <TacticalRoom
                  lang={lang}
                  mentor={mentor}
                  onOpenTraining={() => openNav('training')}
                  onNoteSaved={showToast}
                />
              </div>
            )}
            {visited.training && (
              <div className={nav === 'training' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
                <TrainingWorkspace lang={lang} onNoteSaved={showToast} />
              </div>
            )}
            {visited.knowledge && (
              <div className={nav === 'knowledge' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
                <KnowledgeWorkspace lang={lang} />
              </div>
            )}
            {visited.journal && (
              <div className={nav === 'journal' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
                <JournalWorkspace lang={lang} />
              </div>
            )}
          </div>
        </main>
      </div>

      <nav
        className="md:hidden flex-shrink-0 border-t border-v3-line bg-v3-panel pb-safe"
        aria-label={lang === 'zh' ? '移动端导航' : 'Mobile navigation'}
      >
        <div className="flex items-stretch">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => openNav(item.id)}
              aria-current={nav === item.id ? 'page' : undefined}
              className={`v3-bottom-nav-item ${nav === item.id ? 'v3-bottom-nav-item-active' : ''}`}
            >
              <span aria-hidden="true" className="text-[14px]">{item.symbol}</span>
              {navLabel(item, lang)}
            </button>
          ))}
        </div>
      </nav>

      {toast && (
        <div className="v3-toast v3-toast-show" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  );
};

export default WorkspaceShell;
