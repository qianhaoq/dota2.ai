import React, { useMemo } from 'react';
import { Language, Hero } from '../../types';
import { Loader2 } from 'lucide-react';

export type { LessonMode } from '../../types';

interface MentorStageProps {
  lang: Language;
  mentor: Hero | null;
  practiceHero?: Hero | null;
  density?: 'hero' | 'compact';
  onOpenPracticePicker: () => void;
}

const MentorStage: React.FC<MentorStageProps> = ({
  lang,
  mentor,
  practiceHero = null,
  density = 'hero',
  onOpenPracticePicker,
}) => {
  const t = useMemo(() => ({
    title: lang === 'zh' ? '大魔导师 · 拉比克' : 'Grand Magus · Rubick',
    live: lang === 'zh' ? '实时带练' : 'Live coaching',
    tagline: lang === 'zh'
      ? '抄技能是本能。选个英雄，我带你练。'
      : 'Steal skills. Pick a hero — I will drill you.',
    loading: lang === 'zh' ? '拉比克正在入座…' : 'Rubick is taking a seat…',
    practiceCta: lang === 'zh' ? '选英雄练习' : 'Practice a hero',
    changePractice: lang === 'zh' ? '换练习英雄' : 'Change practice hero',
    practicing: lang === 'zh' ? '练习' : 'Practice',
  }), [lang]);

  const practiceName = practiceHero
    ? (lang === 'zh' ? (practiceHero.nameZh || practiceHero.name) : practiceHero.name)
    : null;

  if (!mentor) {
    return (
      <div className="flex flex-col items-center justify-center px-4 py-6 text-k3-text-secondary text-sm">
        <Loader2 size={18} className="animate-spin mb-3" />
        {t.loading}
      </div>
    );
  }

  if (density === 'compact') {
    return (
      <div className="flex items-center justify-between gap-2 px-3 sm:px-4 py-2 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="relative flex-shrink-0">
            <img
              src={mentor.icon || mentor.img}
              alt={mentor.name}
              className="w-8 h-8 rounded-lg object-cover border border-k3-border-subtle"
            />
            <span className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400/80 border border-k3-base" />
          </div>
          <div className="min-w-0">
            <p className="text-sm text-k3-text-primary font-medium truncate">{t.title}</p>
            <p className="text-[11px] text-k3-text-tertiary truncate">
              {t.live}
              {practiceName ? ` · ${t.practicing} ${practiceName}` : ''}
            </p>
          </div>
        </div>
        <button
          onClick={onOpenPracticePicker}
          className="flex-shrink-0 text-xs text-k3-text-secondary hover:text-k3-text-primary min-h-[36px] px-2 touch-manipulation"
        >
          {practiceHero ? t.changePractice : t.practiceCta}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center w-full max-w-xl mx-auto px-1">
      <div className="relative mb-3 sm:mb-4">
        <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-xl overflow-hidden border border-k3-border-subtle bg-k3-surface">
          <img src={mentor.img} alt={mentor.name} className="w-full h-full object-cover" />
        </div>
        <span className="absolute -bottom-1 -right-1 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-k3-elevated border border-k3-border-subtle text-[10px] text-k3-text-secondary">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/80 animate-pulse" />
          {t.live}
        </span>
      </div>

      <h1 className="text-base sm:text-lg text-k3-text-primary font-medium text-center">{t.title}</h1>
      <p className="text-xs sm:text-sm text-k3-text-secondary mt-1 text-center px-4 max-w-md">{t.tagline}</p>

      <button
        onClick={onOpenPracticePicker}
        className="mt-4 sm:mt-5 px-5 py-3 bg-k3-primary-bg text-k3-primary-text font-medium rounded-lg hover:bg-white active:bg-white transition-colors min-h-[48px] w-full sm:w-auto touch-manipulation"
      >
        {practiceHero ? `${t.changePractice} ›` : `${t.practiceCta} ›`}
      </button>
    </div>
  );
};

export default MentorStage;
