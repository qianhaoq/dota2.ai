import React from 'react';
import { History, Flag, Sparkles, ChevronRight } from 'lucide-react';
import type { Hero, Language } from '../../types';

export interface LandingProps {
  lang: Language;
  mentor: Hero | null;
  /** 刚打完 — go to post-match review (real match intake). */
  onReview: () => void;
  /** 准备开局 — go to the draft workspace. */
  onDraft: () => void;
  /** 想练一下 — go to the training tab (shell-level navigation). */
  onTraining: () => void;
}

/**
 * Tactical-room landing (DESIGN.md §3.1): one primary visual action per motive
 * state, honest about limits — no fabricated recent matches, ranks or growth
 * scores when no account is connected.
 */
const Landing: React.FC<LandingProps> = ({ lang, mentor, onReview, onDraft, onTraining }) => {
  const t = {
    kicker: 'SEE THE PLAY. MAKE THE CALL.',
    titleA: lang === 'zh' ? '把下一次判断，' : 'Make the next call',
    titleB: lang === 'zh' ? '练得更好。' : 'a better one.',
    sub:
      lang === 'zh'
        ? '进场、选人、出装、资源取舍。把一句“我该怎么办”，变成眼前可比较的战术局面。'
        : 'Lanes, drafts, items, resources. Turn “what should I do” into a comparable tactical picture.',
    mentorLine:
      lang === 'zh'
        ? `${mentor ? '拉比克' : '教练'}：不急着告诉你答案。先一起看清局面。`
        : `${mentor ? 'Rubick' : 'Coach'}: no rush to the answer — see the situation first.`,
    entries: [
      {
        key: 'review',
        icon: History,
        title: lang === 'zh' ? '刚打完，复盘一局' : 'Just finished — review a game',
        desc: lang === 'zh' ? '找一个关键决定，带走一个下局动作。' : 'Find one key decision, keep one next-game action.',
      },
      {
        key: 'draft',
        icon: Flag,
        title: lang === 'zh' ? '准备开局，推演阵容' : 'About to queue — draft preview',
        desc: lang === 'zh' ? '从已知英雄出发，不必先填满十个人。' : 'Start from known heroes; no need to fill all ten.',
      },
      {
        key: 'training',
        icon: Sparkles,
        title: lang === 'zh' ? '想变强，练一次判断' : 'Want to improve — drill a call',
        desc: lang === 'zh' ? '先选，再看理由；不是把答案抄一遍。' : 'Decide first, reasons after — not copy the answer.',
      },
    ] as const,
    notice:
      lang === 'zh'
        ? '这里没有虚构的胜率、段位或成长分。导入真实比赛后，才展示与你有关的局面。'
        : 'No fabricated win rates, ranks or growth scores. Real situations appear only after you import a real match.',
    open: lang === 'zh' ? '进入' : 'Open',
  };

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="max-w-[860px] w-full mx-auto px-[16px] pt-[20px] pb-[24px] min-w-0">
        <section className="relative v3-panel overflow-hidden px-[20px] py-[24px] sm:px-[28px] sm:py-[30px]">
          {mentor?.img && (
            <img
              src={mentor.img}
              alt=""
              aria-hidden="true"
              className="absolute right-[-30px] top-[-20px] w-[180px] h-[180px] object-cover opacity-[0.14] pointer-events-none select-none"
              loading="lazy"
            />
          )}
          <div className="v3-eyebrow">{t.kicker}</div>
          <h1 className="v3-display text-[25px] leading-[34px] sm:text-[34px] sm:leading-[44px] text-v3-text mt-[8px] relative">
            {t.titleA}
            <br />
            {t.titleB}
          </h1>
          <p className="text-[13px] leading-[21px] text-v3-muted mt-[10px] max-w-[520px]">{t.sub}</p>
          <p className="text-[11px] leading-[18px] text-v3-quiet mt-[8px]">{t.mentorLine}</p>
        </section>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-[10px] mt-[14px]">
          {t.entries.map((entry) => {
            const Icon = entry.icon;
            const onClick = entry.key === 'review' ? onReview : entry.key === 'draft' ? onDraft : onTraining;
            return (
              <button
                key={entry.key}
                type="button"
                onClick={onClick}
                className="v3-panel hover:bg-v3-raised text-left px-[16px] py-[16px] group transition-colors duration-[120ms] min-w-0"
              >
                <div className="flex items-start justify-between gap-[8px]">
                  <span
                    aria-hidden="true"
                    className="w-[40px] h-[40px] rounded-[4px] border border-v3-line flex items-center justify-center text-v3-gold flex-shrink-0"
                  >
                    <Icon size={18} />
                  </span>
                  <span className="text-v3-quiet group-hover:text-v3-text transition-colors" aria-hidden="true">
                    <ChevronRight size={16} />
                  </span>
                </div>
                <h3 className="text-[14px] text-v3-text font-medium mt-[12px]">{entry.title}</h3>
                <p className="text-[12px] leading-[19px] text-v3-muted mt-[4px]">{entry.desc}</p>
              </button>
            );
          })}
        </div>

        <p className="mt-[14px] text-[11px] leading-[18px] text-v3-quiet border border-v3-line rounded-[4px] px-[12px] py-[10px]">
          {t.notice}
        </p>
      </div>
    </div>
  );
};

export default Landing;
