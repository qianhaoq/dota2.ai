import React from 'react';
import type { Language } from '../../types';

export interface CoachBriefProps {
  lang: Language;
  /** One-line takeaway. Keep it a claim with conditions, not a verdict. */
  title: string;
  /** Conditions under which the takeaway holds. */
  conditions?: string[];
  /** Explicit boundary: what this does not say. */
  boundary?: string;
}

/**
 * CoachBrief (catalog: dota-coach-ui/1) — 一句话要点、条件与边界。
 * Fallback per catalog spec: render the pending clarification question instead.
 */
const CoachBrief: React.FC<CoachBriefProps> = ({ lang, title, conditions, boundary }) => {
  const t = {
    conditions: lang === 'zh' ? '成立条件' : 'Holds when',
    boundary: lang === 'zh' ? '边界' : 'Boundary',
  };
  return (
    <section className="v3-panel px-[16px] py-[14px]" aria-label={lang === 'zh' ? '教练要点' : 'Coach brief'}>
      <div className="v3-eyebrow mb-[6px]">COACH BRIEF</div>
      <p className="text-[15px] leading-[24px] text-v3-text font-medium">{title}</p>
      {conditions && conditions.length > 0 && (
        <div className="mt-[10px]">
          <div className="text-[11px] text-v3-quiet mb-[4px]">{t.conditions}</div>
          <ul className="space-y-[3px]">
            {conditions.map((c) => (
              <li key={c} className="text-[12px] leading-[19px] text-v3-muted flex gap-[8px]">
                <span aria-hidden="true" className="text-v3-gold">·</span>
                <span className="min-w-0">{c}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {boundary && (
        <p className="mt-[10px] text-[11px] leading-[18px] text-v3-quiet border-t border-v3-line pt-[8px]">
          {t.boundary}：{boundary}
        </p>
      )}
    </section>
  );
};

export default CoachBrief;
