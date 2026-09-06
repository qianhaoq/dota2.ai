import React, { useRef, useEffect, useMemo } from 'react';
import { Language, Hero, DraftState } from '../../types';
import { Send, Loader2, X, User } from 'lucide-react';
import DraftContextChip from './DraftContextChip';
import LessonRail from './LessonRail';

export type LessonMode = 'bp' | 'match' | 'items' | 'mind' | 'review';

interface MentorStageProps {
  lang: Language;
  mentor: Hero | null;
  lesson: LessonMode;
  onLessonChange: (lesson: LessonMode) => void;
  draft: DraftState;
  selectionSide: 'radiant' | 'dire';
  onOpenMentorPicker: () => void;
  onOpenDraftPicker: () => void;
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
  lesson,
  onLessonChange,
  draft,
  selectionSide,
  onOpenMentorPicker,
  onOpenDraftPicker,
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

  const t = useMemo(() => ({
    emptyTitle: lang === 'zh' ? '今天谁教你。' : 'Who is teaching you today.',
    emptyCta: lang === 'zh' ? '请出导师' : 'Call your mentor',
    emptyMetaLink: lang === 'zh' ? '先看版本谁强' : 'Check the patch first',
    emptyInput: lang === 'zh' 
      ? '问一句也可以，但先请导师会准得多' 
      : 'You can type, but a mentor will be sharper',
    seatTagline: lang === 'zh' 
      ? '坐下了。选一堂课，或直接问我。' 
      : "I'm here. Pick a lesson, or just ask.",
    composerPlaceholder: mentor 
      ? (lang === 'zh' ? `直接问${mentor.nameZh || mentor.name}，或选一堂课` : `Ask ${mentor.name}, or pick a lesson`)
      : (lang === 'zh' ? '输入问题...' : 'Ask a question...'),
    changeMentor: lang === 'zh' ? '换导师' : 'Change mentor',
    draftOptional: lang === 'zh' ? '补双方英雄（可选）' : 'Add both sides (optional)',
    keyboardHint: lang === 'zh' ? '聚焦输入' : 'to focus',
  }), [lang, mentor]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === 'Enter' && !mentor && document.activeElement !== inputRef.current) {
        e.preventDefault();
        onOpenMentorPicker();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mentor, onOpenMentorPicker]);

  const canSend = userInput.trim().length > 0 && !isLoading;
  const hasHeroes = draft.radiant.length > 0 || draft.dire.length > 0;

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
      <div className="flex flex-col items-center justify-center h-full px-4 sm:px-6 py-6 sm:py-8 max-w-3xl mx-auto overflow-x-hidden">
        <div className="flex flex-col items-center w-full max-w-xl">
          {/* Mentor Vacancy - Empty seat */}
          <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-lg bg-k3-surface border border-k3-border-subtle flex items-center justify-center mb-5 sm:mb-6">
            <User size={32} className="sm:w-10 sm:h-10 text-k3-text-tertiary" strokeWidth={1} />
          </div>

          {/* Empty state title */}
          <h1 className="text-base sm:text-lg text-k3-text-primary mb-2 text-center font-medium px-4">
            {t.emptyTitle}
          </h1>

          {/* Primary CTA - Call mentor */}
          <button
            onClick={onOpenMentorPicker}
            className="mt-5 sm:mt-6 px-5 py-3 bg-k3-primary-bg text-k3-primary-text font-medium rounded-lg hover:bg-white active:bg-white transition-colors min-h-[48px] w-full sm:w-auto touch-manipulation"
          >
            {t.emptyCta} ›
          </button>

          {/* Weak exit - meta link */}
          <button
            onClick={onMeta}
            disabled={isLoading}
            className="mt-4 text-sm text-k3-text-tertiary hover:text-k3-text-secondary transition-colors min-h-[40px] touch-manipulation"
          >
            {t.emptyMetaLink}
          </button>

          {/* Demoted composer */}
          <form onSubmit={onSubmit} className="w-full mt-6 sm:mt-8 opacity-60">
            <div className="relative flex items-center bg-k3-input border border-k3-border-subtle rounded-composer">
              <input
                ref={inputRef}
                type="text"
                value={userInput}
                onChange={(e) => setUserInput(e.target.value)}
                placeholder={t.emptyInput}
                disabled={isLoading}
                className="flex-1 bg-transparent px-3 sm:px-4 py-3 pr-12 sm:pr-14 text-sm text-k3-text-primary focus:outline-none placeholder:text-k3-text-tertiary disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!canSend}
                className={`absolute right-2 w-9 h-9 flex items-center justify-center rounded-full transition-all touch-manipulation ${
                  canSend
                    ? 'bg-k3-elevated text-k3-text-secondary cursor-pointer'
                    : 'bg-k3-elevated text-k3-text-tertiary cursor-not-allowed'
                }`}
              >
                <Send size={16} />
              </button>
            </div>
          </form>

          {/* Loading/Cancel */}
          {isLoading && (
            <div className="flex items-center justify-center gap-3 mt-4 min-h-[44px]">
              <Loader2 size={16} className="text-k3-text-secondary animate-spin" />
              <button
                onClick={onCancel}
                className="text-sm text-k3-text-tertiary hover:text-k3-text-secondary flex items-center gap-1 py-2 px-3 min-h-[40px] touch-manipulation"
              >
                <X size={14} />
                {lang === 'zh' ? '停止' : 'Stop'}
              </button>
            </div>
          )}
        </div>

        {/* Spacer to push footer down */}
        <div className="flex-1" />

        {/* Bottom Footer Hint - hidden on mobile */}
        <div className="hidden sm:block text-[10px] text-k3-text-tertiary/60 tracking-wide">
          <kbd className="px-1.5 py-0.5 rounded bg-k3-surface border border-k3-border-subtle font-mono text-[9px]">/</kbd>
          <span className="ml-1.5">{t.keyboardHint}</span>
        </div>
      </div>
    );
  }

  const mentorName = lang === 'zh' ? (mentor.nameZh || mentor.name) : mentor.name;

  return (
    <div className="flex flex-col items-center justify-center h-full px-4 sm:px-6 py-6 sm:py-8 max-w-3xl mx-auto overflow-x-hidden">
      <div className="flex flex-col items-center w-full max-w-xl">
        {/* Mentor Seat - Selected mentor */}
        <div className="flex flex-col items-center mb-5 sm:mb-6">
          <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg overflow-hidden border border-k3-border-subtle mb-2 sm:mb-3">
            <img 
              src={mentor.img} 
              alt={mentor.name}
              className="w-full h-full object-cover"
            />
          </div>
          <h2 className="text-base sm:text-lg text-k3-text-primary font-medium">{mentorName}</h2>
          <p className="text-xs sm:text-sm text-k3-text-secondary mt-1 text-center px-4">{t.seatTagline}</p>
          <button
            onClick={onOpenMentorPicker}
            className="mt-2 text-xs text-k3-text-tertiary hover:text-k3-text-secondary transition-colors min-h-[36px] touch-manipulation"
          >
            {t.changeMentor}
          </button>
        </div>

        {/* Lesson Rail */}
        <div className="w-full mb-5 sm:mb-6 overflow-x-auto scrollbar-hide px-2">
          <LessonRail
            lang={lang}
            currentLesson={lesson}
            onLessonChange={handleLessonAction}
            isLoading={isLoading}
          />
        </div>

        {/* Draft Context - Optional */}
        <div className="w-full mb-5 sm:mb-6 flex justify-center">
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
            <button
              onClick={onOpenDraftPicker}
              className="text-sm text-k3-text-tertiary hover:text-k3-text-secondary transition-colors min-h-[40px] touch-manipulation"
            >
              {t.draftOptional}
            </button>
          )}
        </div>

        {/* Composer */}
        <form onSubmit={onSubmit} className="w-full">
          <div className="relative flex items-center bg-k3-input border border-k3-border-subtle rounded-composer focus-within:border-k3-text-tertiary/50 transition-all">
            <input
              ref={inputRef}
              type="text"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder={t.composerPlaceholder}
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

        {/* Loading/Cancel */}
        {isLoading && (
          <div className="flex items-center justify-center gap-3 mt-4 min-h-[44px]">
            <Loader2 size={16} className="text-k3-text-secondary animate-spin" />
            <button
              onClick={onCancel}
              className="text-sm text-k3-text-tertiary hover:text-k3-text-secondary flex items-center gap-1 py-2 px-3 min-h-[40px] touch-manipulation"
            >
              <X size={14} />
              {lang === 'zh' ? '停止' : 'Stop'}
            </button>
          </div>
        )}
      </div>

      {/* Spacer to push footer down */}
      <div className="flex-1" />

      {/* Bottom Footer Hint - hidden on mobile */}
      <div className="hidden sm:block text-[10px] text-k3-text-tertiary/60 tracking-wide">
        <kbd className="px-1.5 py-0.5 rounded bg-k3-surface border border-k3-border-subtle font-mono text-[9px]">/</kbd>
        <span className="ml-1.5">{t.keyboardHint}</span>
      </div>
    </div>
  );
};

export default MentorStage;
