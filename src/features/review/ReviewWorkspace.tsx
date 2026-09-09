import React from 'react';
import type { Language } from '../../types';

/**
 * Review workspace framing inside the tactical room. Rendered above the shared
 * CoachSession: one primary visual action per state, KDA and damage ranks stay
 * in the evidence layer — never the hero of the screen.
 */
const ReviewWorkspace: React.FC<{ lang: Language }> = ({ lang }) => {
  const t = {
    kicker: lang === 'zh' ? 'TACTICAL REVIEW / 赛后复盘' : 'TACTICAL REVIEW',
    title: lang === 'zh' ? '先还原你当时掌握的信息。' : 'Reconstruct what you knew at the time.',
    hint:
      lang === 'zh'
        ? '不从结果倒推“你本来就该知道”。输入比赛 ID → 读取名单 → 选择你的视角 → 显式开始分析。'
        : 'No hindsight verdicts. Enter a match id → load the roster → pick your perspective → start analysis explicitly.',
  };
  return (
    <div className="px-[16px] pt-[14px] pb-[4px] max-w-[860px] w-full mx-auto min-w-0">
      <div className="v3-eyebrow">{t.kicker}</div>
      <h2 className="v3-display text-[18px] leading-[26px] text-v3-text mt-[4px]">{t.title}</h2>
      <p className="text-[12px] leading-[19px] text-v3-muted mt-[4px]">{t.hint}</p>
    </div>
  );
};

export default ReviewWorkspace;
