import React, { useMemo } from 'react';
import { Language, Hero, DraftState, LessonMode } from '../../types';
import { BarChart3, Users } from 'lucide-react';
import LessonRail from './LessonRail';
import DraftContextChip from './DraftContextChip';
import ReviewEntry from './ReviewEntry';
import IntentChips from './IntentChips';

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
  coachBusy?: boolean;
  onMeta: () => void;
  onStartReview?: (matchId: number, heroId?: number) => void;
  onAnalyze?: () => void;
  onPlaybook?: () => void;
  onSuggest?: () => void;
  onCancelStream?: () => void;
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
  coachBusy = false,
  onMeta,
  onStartReview,
  onAnalyze,
  onPlaybook,
  onSuggest,
  onCancelStream,
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
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-k3-surface border border-k3-border-subtle text-xs min-h-[40px] max-w-full touch-manipulation"
    >
      <img src={practiceHero.icon || practiceHero.img} alt="" className="w-8 h-8 rounded object-cover flex-shrink-0" />
      <span className="text-k3-text-tertiary flex-shrink-0">{t.practicing}</span>
      <span className="text-k3-text-primary font-medium truncate max-w-[7.5rem] sm:max-w-[12rem]">{practiceName}</span>
    </button>
  );

  const metaBtn = (
    <button
      onClick={onMeta}
      disabled={coachBusy}
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border border-k3-border-subtle text-xs text-k3-text-secondary hover:text-k3-text-primary min-h-[40px] flex-shrink-0 touch-manipulation"
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
      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-k3-text-tertiary hover:text-k3-text-secondary min-h-[40px] flex-shrink-0 touch-manipulation"
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
      <div className={`flex items-center gap-1.5 min-w-0 ${density === 'compact' ? 'overflow-x-auto scrollbar-hide justify-start' : 'flex-wrap justify-center'}`}>
        {practiceChip}
        {metaBtn}
        {draftBtn}
      </div>
      <LessonRail lang={lang} currentLesson={lesson} onLessonChange={onLessonChange} compact={density === 'compact'} />
      {(lesson === 'bp' || hasHeroes) && onAnalyze && onPlaybook && onSuggest && onCancelStream && (
        <div className="flex justify-center" data-testid="draft-intent-chips">
          <IntentChips
            lang={lang}
            isLoading={coachBusy}
            hasHeroes={hasHeroes}
            hasAllies={(selectionSide === 'radiant' ? draft.radiant : draft.dire).length > 0 || Boolean(practiceHero)}
            alliesFull={(selectionSide === 'radiant' ? draft.radiant : draft.dire).length >= 5}
            selectionSide={selectionSide}
            onAnalyze={onAnalyze}
            onPlaybook={onPlaybook}
            onSuggest={onSuggest}
            onMeta={onMeta}
            onCancel={onCancelStream}
          />
        </div>
      )}
      {onStartReview && lesson === 'review' && (
        <ReviewEntry
          lang={lang}
          allHeroes={allHeroes}
          practiceHero={practiceHero}
          density={density}
          defaultExpanded={density === 'full'}
          onStartReview={onStartReview}
        />
      )}
    </div>
  );
};

export default HomeModules;
