import React, { useMemo } from 'react';
import { Language } from '../../types';
import { Crosshair, Swords, Package, Brain, Film } from 'lucide-react';
import type { LessonMode } from './MentorStage';

interface LessonRailProps {
  lang: Language;
  currentLesson: LessonMode;
  onLessonChange: (lesson: LessonMode) => void;
  isLoading: boolean;
  compact?: boolean;
}

const LessonRail: React.FC<LessonRailProps> = ({
  lang,
  currentLesson,
  onLessonChange,
  isLoading,
  compact = false,
}) => {
  const t = useMemo(() => ({
    bp: lang === 'zh' ? 'BP' : 'Ban/Pick',
    match: lang === 'zh' ? '对局' : 'This game',
    items: lang === 'zh' ? '出装' : 'Items',
    mind: lang === 'zh' ? '思路' : 'Game sense',
    review: lang === 'zh' ? '复盘' : 'Replay',
    reviewHint: lang === 'zh' 
      ? '复盘还没开课。以后用 OpenDota 比赛 ID。' 
      : 'Replay review is not open yet.',
  }), [lang]);

  const lessons: Array<{
    id: LessonMode;
    label: string;
    icon: typeof Crosshair;
    enabled: boolean;
  }> = [
    { id: 'bp', label: t.bp, icon: Crosshair, enabled: true },
    { id: 'match', label: t.match, icon: Swords, enabled: true },
    { id: 'items', label: t.items, icon: Package, enabled: true },
    { id: 'mind', label: t.mind, icon: Brain, enabled: true },
    { id: 'review', label: t.review, icon: Film, enabled: false },
  ];

  const [showReviewHint, setShowReviewHint] = React.useState(false);

  const handleClick = (lesson: typeof lessons[0]) => {
    if (!lesson.enabled) {
      setShowReviewHint(true);
      setTimeout(() => setShowReviewHint(false), 3000);
      return;
    }
    onLessonChange(lesson.id);
  };

  if (compact) {
    return (
      <div className="flex items-center gap-2 sm:gap-4 overflow-x-auto scrollbar-hide">
        {lessons.map((lesson) => {
          const Icon = lesson.icon;
          const isActive = currentLesson === lesson.id;
          
          return (
            <button
              key={lesson.id}
              onClick={() => handleClick(lesson)}
              disabled={isLoading}
              className={`text-xs sm:text-sm transition-colors whitespace-nowrap min-h-[36px] px-1 touch-manipulation ${
                !lesson.enabled
                  ? 'text-k3-text-tertiary/40 cursor-not-allowed'
                  : isActive
                    ? 'text-k3-text-primary font-medium'
                    : 'text-k3-text-secondary hover:text-k3-text-primary'
              }`}
              title={!lesson.enabled ? t.reviewHint : undefined}
            >
              {lesson.label}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="flex items-center justify-center gap-2 sm:gap-4 md:gap-6 overflow-x-auto scrollbar-hide pb-1">
        {lessons.map((lesson) => {
          const Icon = lesson.icon;
          const isActive = currentLesson === lesson.id;
          
          return (
            <button
              key={lesson.id}
              onClick={() => handleClick(lesson)}
              disabled={isLoading}
              className={`flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 py-2 rounded-lg transition-all whitespace-nowrap min-h-[44px] touch-manipulation flex-shrink-0 ${
                !lesson.enabled
                  ? 'text-k3-text-tertiary/40 cursor-not-allowed'
                  : isActive
                    ? 'bg-k3-surface text-k3-text-primary font-medium border border-k3-border-subtle'
                    : 'text-k3-text-secondary hover:text-k3-text-primary hover:bg-k3-surface/50 active:bg-k3-surface/50'
              }`}
              title={!lesson.enabled ? t.reviewHint : undefined}
            >
              <Icon size={14} className="flex-shrink-0" />
              <span className="text-xs sm:text-sm">{lesson.label}</span>
            </button>
          );
        })}
      </div>

      {/* Review hint tooltip */}
      {showReviewHint && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-3 py-2 bg-k3-elevated border border-k3-border-subtle rounded-lg text-xs text-k3-text-secondary whitespace-nowrap z-10 max-w-[90vw] text-center">
          {t.reviewHint}
        </div>
      )}
    </div>
  );
};

export default LessonRail;
