import React from 'react';
import type { Language } from '../../types';

/**
 * Draft workspace framing inside the tactical room, rendered above the shared
 * CoachSession (bp lesson). Starts from known heroes — the lineup does not
 * have to be full; mySide and the editing side stay separate concepts.
 */
const DraftWorkspace: React.FC<{ lang: Language }> = ({ lang }) => {
  const t = {
    kicker: lang === 'zh' ? 'DRAFT ROOM / 战前阵容' : 'DRAFT ROOM',
    title: lang === 'zh' ? '选五个人，也选一套共同的打法。' : 'Pick five players — and one shared plan.',
    hint:
      lang === 'zh'
        ? '从已知英雄开始推演，不必先填满十格。选好人后点「分析阵容」。我的阵营与正在编辑的一侧相互独立；样本胜率不是本局获胜概率。'
        : 'Start from known heroes; ten slots are not required. After picks, tap Analyze draft. Your side and the editing side stay separate. Sample win rates are not this game’s odds.',
  };
  return (
    <div className="px-[16px] pt-[14px] pb-[4px] max-w-[860px] w-full mx-auto min-w-0">
      <div className="v3-eyebrow">{t.kicker}</div>
      <h2 className="v3-display text-[18px] leading-[26px] text-v3-text mt-[4px]">{t.title}</h2>
      <p className="text-[12px] leading-[19px] text-v3-muted mt-[4px]">{t.hint}</p>
    </div>
  );
};

export default DraftWorkspace;
