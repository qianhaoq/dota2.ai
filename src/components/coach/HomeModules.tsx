import React, { useMemo } from 'react';
import { Language, Hero, DraftState, LessonMode } from '../../types';
import { BarChart3, Users } from 'lucide-react';
import LessonRail from './LessonRail';
import DraftContextChip from './DraftContextChip';

interface HomeModulesProps {
  lang: Language;
  density?: 'full' | 'compact';
  practiceHero: Hero | null;
  lesson: LessonMode;
  onLessonChange: (lesson: LessonMode) => void;
  draft: DraftState;
  selectionSide: 'radiant' | 'dire';
  onOpenPracticePicker: () => void;
  onOpenDraftPicker: () => void;
  onHeroDetail?: (heroId: number) => void;
  isLoading: boolean;
  onMeta: () => void;
}

const HomeModules: React.FC<HomeModulesProps> = ({
  lang,
  density = 'full',
  practiceHero,
  lesson,
  onLessonChange,
  draft,
  selectionSide,
  onOpenPracticePicker,
  onOpenDraftPicker,
  onHeroDetail,
  isLoading,
  onMeta,
}) => {
  const t = useMemo(() => ({
    practice: lang === 'zh' ? '练习入口' : 'Practice',
    practicing: lang === 'zh' ? '正在练习' : 'Practicing',
    pickPractice: lang === 'zh' ? '先选一位要练的英雄' : 'Pick a hero to drill',
    meta: lang === 'zh' ? '版本趋势' : 'Patch trends',
    metaHint: lang === 'zh' ? '看看当前版本强势英雄' : 'OpenDota patch tier list',
    lessons: lang === 'zh' ? '带练课表' : 'Lesson track',
    draftOptional: lang === 'zh' ? '补双方阵容（可选）' : 'Add both sides (optional)',
  }), [lang]);

  const practiceName = practiceHero
    ? (lang === 'zh' ? (practiceHero.nameZh || practiceHero.name) : practiceHero.name)
    : null;
  const hasHeroes = draft.radiant.length > 0 || draft.dire.length > 0;

  if (density === 'compact') {
    return (
      <div className="px-3 sm:px-4 pb-2 space-y-2 min-w-0">
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          {practiceHero && (
            <button
              onClick={onOpenPracticePicker}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-k3-surface border border-k3-border-subtle text-xs min-h-[36px] touch-manipulation"
            >
              <img src={practiceHero.icon || practiceHero.img} alt="" className="w-5 h-5 rounded object-cover" />
              <span className="text-k3-text-tertiary">{t.practicing}</span>
              <span className="text-k3-text-primary font-medium">{practiceName}</span>
            </button>
          )}
          <button
            onClick={onMeta}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border border-k3-border-subtle text-xs text-k3-text-secondary hover:text-k3-text-primary min-h-[36px] touch-manipulation"
          >
            <BarChart3 size={12} />
            {t.meta}
          </button>
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
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-k3-text-tertiary hover:text-k3-text-secondary min-h-[36px] touch-manipulation"
            >
              <Users size={12} />
              {t.draftOptional}
            </button>
          )}
        </div>
        <LessonRail lang={lang} currentLesson={lesson} onLessonChange={onLessonChange} isLoading={isLoading} />
      </div>
    );
  }

  return (
    <div className="w-full max-w-xl mx-auto mt-4 sm:mt-5 space-y-3 min-w-0">
      <section className="rounded-lg border border-k3-border-subtle bg-k3-surface/60 p-3 sm:p-3.5">
        <h2 className="text-[11px] uppercase tracking-wide text-k3-text-tertiary mb-2">{t.practice}</h2>
        {practiceHero ? (
          <button
            onClick={onOpenPracticePicker}
            className="flex items-center gap-2 w-full text-left min-h-[44px] touch-manipulation"
          >
            <img src={practiceHero.icon || practiceHero.img} alt="" className="w-8 h-8 rounded object-cover" />
            <div className="min-w-0">
              <p className="text-xs text-k3-text-tertiary">{t.practicing}</p>
              <p className="text-sm text-k3-text-primary font-medium truncate">{practiceName}</p>
            </div>
          </button>
        ) : (
          <p className="text-sm text-k3-text-secondary">{t.pickPractice}</p>
        )}
      </section>

      <section className="rounded-lg border border-k3-border-subtle bg-k3-surface/60 p-3 sm:p-3.5">
        <h2 className="text-[11px] uppercase tracking-wide text-k3-text-tertiary mb-2">{t.meta}</h2>
        <button
          onClick={onMeta}
          disabled={isLoading}
          className="flex items-center gap-2 w-full text-left text-sm text-k3-text-secondary hover:text-k3-text-primary min-h-[40px] touch-manipulation"
        >
          <BarChart3 size={16} className="flex-shrink-0" />
          <span>{t.metaHint}</span>
        </button>
      </section>

      <section className="rounded-lg border border-k3-border-subtle bg-k3-surface/60 p-3 sm:p-3.5 min-w-0">
        <h2 className="text-[11px] uppercase tracking-wide text-k3-text-tertiary mb-2">{t.lessons}</h2>
        <LessonRail lang={lang} currentLesson={lesson} onLessonChange={onLessonChange} isLoading={isLoading} />
        <div className="mt-2 flex justify-center">
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
              className="text-sm text-k3-text-tertiary hover:text-k3-text-secondary min-h-[40px] touch-manipulation"
            >
              {t.draftOptional}
            </button>
          )}
        </div>
      </section>
    </div>
  );
};

export default HomeModules;
