import React, { useRef, useEffect, useMemo } from 'react';
import { Language, Hero, DraftState } from '../../types';
import { Send, Loader2, X } from 'lucide-react';
import DraftContextChip from './DraftContextChip';
import LessonRail from './LessonRail';

export type LessonMode = 'bp' | 'match' | 'items' | 'mind' | 'review';

interface MentorStageProps {
  lang: Language;
  /** Rubick host — always set by parent once heroes load */
  mentor: Hero | null;
  /** Optional practice target (if parent wires it); else null */
  practiceHero?: Hero | null;
  lesson: LessonMode;
  onLessonChange: (lesson: LessonMode) => void;
  draft: DraftState;
  selectionSide: 'radiant' | 'dire';
  onOpenMentorPicker: () => void;
  onOpenDraftPicker: () => void;
  onOpenPracticePicker?: () => void;
  onHeroDetail?: (heroId: number) => void;
  isLoading: boolean;
  onAnalyze: () => void;
  onPlaybook: () => void;
  onSuggest: () => void;
  onMeta: () => void;
  onCancel: () => void;
  userInput: string;
  setUserInput: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}

const MentorStage: React.FC<MentorStageProps> = ({
  lang,
  mentor,
  practiceHero = null,
  lesson,
  onLessonChange,
  draft,
  selectionSide,
  onOpenMentorPicker,
  onOpenDraftPicker,
  onOpenPracticePicker,
  onHeroDetail,
  isLoading,
  onAnalyze,
  onPlaybook,
  onSuggest,
  onMeta,
  onCancel,
  userInput,
  setUserInput,
  onSubmit,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const openPractice = onOpenPracticePicker || onOpenMentorPicker;

  const t = useMemo(() => ({
    title: lang === 'zh' ? '大魔导师 · 拉比克' : 'Grand Magus · Rubick',
    live: lang === 'zh' ? '实时带练' : 'Live coaching',
    tagline: lang === 'zh'
      ? '抄技能是本能。选个英雄，我带你练。'
      : 'Steal skills. Pick a hero — I will drill you.',
    loading: lang === 'zh' ? '拉比克正在入座…' : 'Rubick is taking a seat…',
    practiceCta: lang === 'zh' ? '选英雄练习' : 'Practice a hero',
    changePractice: lang === 'zh' ? '换练习英雄' : 'Change practice hero',
    metaLink: lang === 'zh' ? '看看版本趋势' : 'Check the meta',
    practicing: lang === 'zh' ? '正在练习' : 'Practicing',
    draftOptional: lang === 'zh' ? '补双方阵容（可选）' : 'Add both sides (optional)',
    composer: lang === 'zh' ? '直接问拉比克…' : 'Ask Rubick…',
    keyboardHint: lang === 'zh' ? '聚焦输入' : 'to focus',
    stop: lang === 'zh' ? '停止' : 'Stop',
    reading: lang === 'zh' ? '拉比克在看数据…' : 'Rubick is reading the numbers…',
  }), [lang]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const canSend = userInput.trim().length > 0 && !isLoading;
  const hasHeroes = draft.radiant.length > 0 || draft.dire.length > 0;
  const practiceName = practiceHero
    ? (lang === 'zh' ? (practiceHero.nameZh || practiceHero.name) : practiceHero.name)
    : null;

  const handleLessonAction = (lessonMode: LessonMode) => {
    if (lessonMode === 'review') return;
    onLessonChange(lessonMode);
    switch (lessonMode) {
      case 'bp':
        onAnalyze();
        break;
      case 'match':
        onPlaybook();
        break;
      case 'items':
      case 'mind':
        onAnalyze();
        break;
    }
  };

  if (!mentor) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-4 text-k3-text-secondary text-sm">
        <Loader2 size={18} className="animate-spin mb-3" />
        {t.loading}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full px-4 sm:px-6 py-6 sm:py-8 max-w-3xl mx-auto overflow-x-hidden">
      <div className="flex flex-col items-center w-full max-w-xl">
        <div className="relative mb-4 sm:mb-5">
          <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-xl overflow-hidden border border-k3-border-subtle bg-k3-surface">
            <img src={mentor.img} alt={mentor.name} className="w-full h-full object-cover" />
          </div>
          <span className="absolute -bottom-1 -right-1 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-k3-elevated border border-k3-border-subtle text-[10px] text-k3-text-secondary">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/80 animate-pulse" />
            {t.live}
          </span>
        </div>

        <h1 className="text-base sm:text-lg text-k3-text-primary font-medium text-center px-2">{t.title}</h1>
        <p className="text-xs sm:text-sm text-k3-text-secondary mt-1.5 text-center px-4 max-w-md">{t.tagline}</p>

        <button
          onClick={openPractice}
          className="mt-5 sm:mt-6 px-5 py-3 bg-k3-primary-bg text-k3-primary-text font-medium rounded-lg hover:bg-white active:bg-white transition-colors min-h-[48px] w-full sm:w-auto touch-manipulation"
        >
          {practiceHero ? `${t.changePractice} ›` : `${t.practiceCta} ›`}
        </button>

        <button
          onClick={onMeta}
          disabled={isLoading}
          className="mt-3 text-sm text-k3-text-tertiary hover:text-k3-text-secondary transition-colors min-h-[40px] touch-manipulation"
        >
          {t.metaLink}
        </button>

        {practiceHero && (
          <div className="w-full mt-5 sm:mt-6 space-y-4">
            <button
              onClick={openPractice}
              className="mx-auto flex items-center gap-2 px-3 py-2 rounded-full bg-k3-surface border border-k3-border-subtle hover:bg-k3-elevated transition-all text-xs"
            >
              <img src={practiceHero.icon || practiceHero.img} alt={practiceHero.name} className="w-6 h-6 rounded object-cover" />
              <span className="text-k3-text-tertiary">{t.practicing}</span>
              <span className="text-k3-text-primary font-medium">{practiceName}</span>
            </button>

            <div className="w-full overflow-x-auto scrollbar-hide px-1">
              <LessonRail lang={lang} currentLesson={lesson} onLessonChange={handleLessonAction} isLoading={isLoading} />
            </div>

            <div className="flex justify-center">
              {hasHeroes ? (
                <DraftContextChip
                  lang={lang}
                  draft={draft}
                  selectionSide={selectionSide}
                  onOpenPicker={onOpenDraftPicker}
                  onHeroDetail={onHeroDetail}
                  variant="compact"
                />
              ) : (
                <button onClick={onOpenDraftPicker} className="text-sm text-k3-text-tertiary hover:text-k3-text-secondary min-h-[40px] touch-manipulation">
                  {t.draftOptional}
                </button>
              )}
            </div>
          </div>
        )}

        <form onSubmit={onSubmit} className={`w-full ${practiceHero ? 'mt-5' : 'mt-6 sm:mt-8'}`}>
          <div className="relative flex items-center bg-k3-input border border-k3-border-subtle rounded-composer focus-within:border-k3-text-tertiary/50 transition-all">
            <input
              ref={inputRef}
              type="text"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder={t.composer}
              disabled={isLoading}
              className="flex-1 bg-transparent px-3 sm:px-4 py-3 pr-12 sm:pr-14 text-sm text-k3-text-primary focus:outline-none placeholder:text-k3-text-tertiary disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!canSend}
              className={`absolute right-2 w-9 h-9 flex items-center justify-center rounded-full transition-all touch-manipulation ${
                canSend
                  ? 'bg-k3-primary-bg hover:bg-white active:bg-white text-k3-primary-text cursor-pointer'
                  : 'bg-k3-elevated text-k3-text-tertiary cursor-not-allowed'
              }`}
            >
              <Send size={16} />
            </button>
          </div>
        </form>

        {isLoading && (
          <div className="flex items-center justify-center gap-3 mt-4 min-h-[44px]">
            <Loader2 size={16} className="text-k3-text-secondary animate-spin" />
            <span className="text-sm text-k3-text-secondary">{t.reading}</span>
            <button onClick={onCancel} className="text-sm text-k3-text-tertiary hover:text-k3-text-secondary flex items-center gap-1 py-2 px-3 min-h-[40px] touch-manipulation">
              <X size={14} />
              {t.stop}
            </button>
          </div>
        )}
      </div>
      <div className="flex-1" />
      <div className="hidden sm:block text-[10px] text-k3-text-tertiary/60 tracking-wide">
        <kbd className="px-1.5 py-0.5 rounded bg-k3-surface border border-k3-border-subtle font-mono text-[9px]">/</kbd>
        <span className="ml-1.5">{t.keyboardHint}</span>
      </div>
    </div>
  );
};

export default MentorStage;
