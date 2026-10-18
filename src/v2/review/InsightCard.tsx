import React, { useState } from 'react';
import type { ReviewConclusion } from '../../types/matchReview';
import { evidenceSourceLabel } from '../../utils/reviewConclusions';
import { useI18n } from '../i18n/I18nProvider';
import { IconChevron, IconFix, IconNext, IconTurn } from './icons';

/**
 * One of the three conclusion cards (handoff §1 screen 4): label + time chip
 * (first evidence item's time) / claim rendered verbatim from the API /
 * expandable evidence list (time · text · source label). `insufficient`
 * conclusions get a badge and muted styling. Numbers are never computed here.
 */

const CARD_ICONS = { turn: IconTurn, fix: IconFix, next: IconNext } as const;
export type CardIcon = keyof typeof CARD_ICONS;

const InsightCard: React.FC<{ label: string; icon: CardIcon; conclusion: ReviewConclusion }> = ({
  label,
  icon,
  conclusion,
}) => {
  const { lang, t } = useI18n();
  const [open, setOpen] = useState(false);
  const Icon = CARD_ICONS[icon];
  const insufficient = conclusion.status === 'insufficient';
  const time = conclusion.evidence?.find((e) => e && typeof e.time === 'string' && e.time)?.time ?? null;
  const evidence = Array.isArray(conclusion.evidence)
    ? conclusion.evidence.filter((e) => e && typeof e.text === 'string' && e.text.trim())
    : [];

  return (
    <article className={`bg-d2-surface rounded-d2-card shadow-d2-2 pt-[14px] px-[16px] pb-[12px] ${insufficient ? 'opacity-80' : ''}`}>
      <div className="flex items-center gap-[6px] text-d2-12 font-semibold text-d2-ink-3 min-w-0">
        <span className="text-d2-ink-4 flex-none">
          <Icon />
        </span>
        <span className="truncate">{label}</span>
        {insufficient && (
          <span className="inline-flex items-center h-[20px] px-[8px] rounded-d2-chip bg-[#FFFBEB] text-d2-warn text-d2-12 font-semibold whitespace-nowrap">
            {t('insufficientBadge')}
          </span>
        )}
        {time && (
          <span className="d2-tnum ml-auto flex-none inline-flex items-center h-[28px] pl-[10px] pr-[6px] rounded-d2-chip bg-d2-surface-2 text-d2-13 font-semibold text-d2-ink-2">
            {time}
          </span>
        )}
      </div>

      <p
        className={`mt-[6px] mb-0 text-d2-17 font-semibold tracking-[-0.01em] ${
          insufficient ? 'text-d2-ink-4' : 'text-d2-ink'
        }`}
      >
        {conclusion.summary}
      </p>

      {evidence.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="mt-[12px] pt-[10px] border-t border-d2-line w-full min-h-[32px] flex items-center gap-[8px] text-d2-12 text-d2-ink-3"
          >
            <span className="font-semibold text-d2-accent">{t(open ? 'evidenceHide' : 'evidenceShow')}</span>
            <span className="text-d2-ink-4 flex-none">
              <IconChevron />
            </span>
          </button>
          {open && (
            <ul className="list-none m-0 mt-[6px] p-0">
              {evidence.map((e, i) => (
                <li key={i} className="flex gap-[8px] items-start py-[4px] text-d2-13 text-d2-ink-3">
                  {e.time && <span className="d2-tnum font-semibold text-d2-ink-2 flex-none">{e.time}</span>}
                  <span className="min-w-0">{e.text}</span>
                  <span className="ml-auto flex-none text-d2-12 text-d2-ink-4 whitespace-nowrap">
                    {evidenceSourceLabel(e.source, lang)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </article>
  );
};

export default InsightCard;
