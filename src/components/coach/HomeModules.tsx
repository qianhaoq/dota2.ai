import React, { useMemo } from 'react';
import { Language, Hero, DraftState, LessonMode } from '../../types';
import { BarChart3, Users } from 'lucide-react';
import LessonRail from './LessonRail';
import DraftContextChip from './DraftContextChip';
import ReviewEntry from './ReviewEntry';

interface HomeModulesProps {
  lang: Language;
  density?: 'full' | 'compact';
  allHeroes: Hero[];
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
  onStartReview?: (matchId: number, heroId?: number) => void;
}

const HomeModules: React.FC<HomeModulesProps> = ({
  lang,
  density = 'full',
  allHeroes,
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
  onStartReview,
}) => {
  const t = useMemo(() => ({
    practicing: lang === 'zh' ? '正在练习' : 'Practicing',
    meta: lang === 'zh' ? '版本趋势' : 'Patch trends',
    metaHint: lang === 'zh' ? '看看当前版本强势英雄' : 'OpenDota patch tier list',
    lessons: lang === 'zh' ? '带练课表' : 'Lesson track',
    draftOptional: lang === 'zh' ? '补双方阵容（可选）' : 'Add both sides (optional)',
  }), [lang]);

  const practiceName = practiceHero
    ? (lang === 'zh' ? (practiceHero.nameZh || practiceHero.name) : practiceHero.name)
    : null;
  const hasHeroes = draft.radiant.length > 0 || draft.dire.length > 0;

  const practiceChip = practiceHero && (
    <button
      onClick={onOpenPracticePicker}
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-k3-surface border border-k3-border-subtle text-xs min-h-[36px] touch-manipulation"
    >
      <img src={practiceHero.icon || practiceHero.img} alt="" className="w-5 h-5 rounded object-cover" />
      <span className="text-k3-text-tertiary">{t.practicing}</span>
      <span className="text-k3-text-primary font-medium">{practiceName}</span>
    </button>
  );

  const metaBtn = (
    <button
      onClick={onMeta}
      disabled={isLoading}
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border border-k3-border-subtle text-xs text-k3-text-secondary hover:text-k3-text-primary min-h-[36px] touch-manipulation"
    >
      <BarChart3 size={12} />
      {density === 'full' ? t.metaHint : t.meta}
    </button>
  );

  const draftBtn = hasHeroes ? (
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
  );

  return (
    <div className={`w-full min-w-0 ${density === 'full' ? 'max-w-xl mx-auto mt-3 sm:mt-4 space-y-2.5' : 'px-3 sm:px-4 pb-2 space-y-1.5'}`}>
      {density === 'full' && (
        <h2 className="text-[11px] uppercase tracking-wide text-k3-text-tertiary text-center">{t.lessons}</h2>
      )}
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        {practiceChip}
        {metaBtn}
        {draftBtn}
      </div>
      <LessonRail lang={lang} currentLesson={lesson} onLessonChange={onLessonChange} isLoading={isLoading} compact={density === 'compact'} />
      {onStartReview && (
        <ReviewEntry
          lang={lang}
          allHeroes={allHeroes}
          practiceHero={practiceHero}
          isLoading={isLoading}
          onStartReview={onStartReview}
        />
      )}
    </div>
  );
};

export default HomeModules;
