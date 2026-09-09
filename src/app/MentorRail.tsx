import React from 'react';
import type { NavId } from './nav';
import { QUOTES } from './mentorQuotes';
import type { Hero, Language } from '../types';

export interface MentorRailProps {
  lang: Language;
  section: NavId;
  mentor: Hero | null;
}

/**
 * Desktop mentor rail (DESIGN.md §2/§5): the mentor is an expression layer —
 * present but never crowding the task, and never a source of facts. Changing
 * the mentor would not re-run analyses or change credibility.
 */
const MentorRail: React.FC<MentorRailProps> = ({ lang, section, mentor }) => {
  const t = {
    eyebrow: 'YOUR TACTICAL MENTOR',
    subtitle: lang === 'zh' ? '你的战术教练 · 表达层' : 'Your tactical coach · expression layer',
    agendaTitle: lang === 'zh' ? '这次，我们这样练' : 'How we practice',
    agenda: [
      { no: '01', zh: '看见局面', en: 'See the situation', descZh: '事实、假设与未知分开', descEn: 'Facts, hypotheses, unknowns apart' },
      { no: '02', zh: '自己判断', en: 'Make the call', descZh: '比较选择，而不是背答案', descEn: 'Compare choices, not memorize answers' },
      { no: '03', zh: '带回下一局', en: 'Carry it over', descZh: '只留一个可检查的动作', descEn: 'Keep one checkable action' },
    ],
    footer:
      lang === 'zh'
        ? '导师是表达层：不改变事实来源，更换导师不重跑分析。'
        : 'The mentor is an expression layer: no fact authority; swapping mentors never re-runs analyses.',
  };
  const quote = QUOTES[section][lang === 'zh' ? 'zh' : 'en'];
  const mentorName = mentor ? (lang === 'zh' ? (mentor.nameZh || mentor.name) : mentor.name) : lang === 'zh' ? '教练' : 'Coach';

  return (
    <aside
      className="hidden lg:flex flex-col flex-shrink-0 w-[234px] border-r border-v3-line bg-v3-panel overflow-y-auto custom-scrollbar"
      aria-label={mentorName}
    >
      <div className="px-[20px] pt-[24px] pb-[20px] flex flex-col gap-[12px]">
        <div className="v3-eyebrow">{t.eyebrow}</div>
        {mentor?.img ? (
          <img
            src={mentor.img}
            alt=""
            aria-hidden="true"
            className="w-[104px] h-[104px] rounded-[4px] object-cover border border-v3-line"
            loading="lazy"
          />
        ) : (
          <div className="w-[104px] h-[104px] rounded-[4px] border border-v3-line bg-v3-raised flex items-center justify-center text-[28px] text-v3-gold">
            ◇
          </div>
        )}
        <div>
          <h2 className="v3-display text-[17px] text-v3-text">{mentorName}</h2>
          <p className="text-[11px] text-v3-quiet mt-[2px]">{t.subtitle}</p>
        </div>
        <p className="text-[12px] leading-[20px] text-v3-muted border-l-2 border-v3-gold pl-[10px]">{quote}</p>
        <div>
          <div className="text-[10px] text-v3-quiet uppercase tracking-[0.14em] mb-[8px]">{t.agendaTitle}</div>
          <div className="space-y-[10px]">
            {t.agenda.map((row) => (
              <div key={row.no} className="flex gap-[10px] items-start">
                <span className="v3-display text-[13px] text-v3-gold flex-shrink-0">{row.no}</span>
                <div className="min-w-0">
                  <span className="text-[12px] text-v3-text font-medium">
                    {lang === 'zh' ? row.zh : row.en}
                  </span>
                  <p className="text-[10px] leading-[16px] text-v3-quiet mt-[1px]">
                    {lang === 'zh' ? row.descZh : row.descEn}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-auto px-[20px] py-[14px] border-t border-v3-line">
        <p className="text-[10px] leading-[16px] text-v3-quiet">{t.footer}</p>
      </div>
    </aside>
  );
};

export default MentorRail;
