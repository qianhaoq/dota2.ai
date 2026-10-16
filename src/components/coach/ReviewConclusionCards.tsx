import React, { useState } from 'react';
import { AlertCircle, ChevronDown, ChevronUp, Crosshair, Zap } from 'lucide-react';
import type { Language } from '../../types';
import type { ConclusionCardView, ConclusionKey } from '../../utils/reviewConclusions';

interface ReviewConclusionCardsProps {
  cards: ConclusionCardView[];
  lang: Language;
  /** Preset follow-up questions from threeConclusions.followUps (localized). */
  followUps: string[];
  /** false disables the preset buttons (review still streaming / AI unavailable). */
  followUpEnabled: boolean;
  onFollowUp: (question: string) => void;
}

const CARD_ICONS: Record<ConclusionKey, React.ReactNode> = {
  turningPoint: <Zap size={14} className="text-amber-400 flex-shrink-0" />,
  topMistake: <AlertCircle size={14} className="text-k3-dire flex-shrink-0" />,
  nextGameRule: <Crosshair size={14} className="text-k3-radiant flex-shrink-0" />,
};

const ConclusionCard: React.FC<{ card: ConclusionCardView; lang: Language; index: number }> = ({
  card,
  lang,
  index,
}) => {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const evidenceId = `conclusion-evidence-${card.key}`;
  const t = {
    evidence: lang === 'zh' ? '依据' : 'Evidence',
    expand: lang === 'zh' ? '展开依据' : 'Show evidence',
    collapse: lang === 'zh' ? '收起依据' : 'Hide evidence',
    insufficient: lang === 'zh' ? '数据不足' : 'Insufficient data',
  };

  return (
    <div
      data-testid={`conclusion-card-${card.key}`}
      className="rounded-lg border border-k3-border-subtle bg-k3-elevated/25 p-3"
    >
      <div className="flex items-center gap-2 mb-1.5">
        {CARD_ICONS[card.key]}
        <p className="text-[11px] font-semibold uppercase tracking-wide text-k3-text-tertiary flex-1 min-w-0 truncate">
          {index + 1}. {card.heading}
        </p>
        {card.status === 'insufficient' && (
          <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full border border-k3-border-subtle text-k3-text-tertiary flex-shrink-0">
            {t.insufficient}
          </span>
        )}
      </div>
      <p className={`text-sm leading-relaxed ${card.status === 'insufficient' ? 'text-k3-text-tertiary' : 'text-k3-text-primary'}`}>
        {card.summary}
      </p>
      {card.evidence.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            aria-expanded={evidenceOpen}
            aria-controls={evidenceId}
            onClick={() => setEvidenceOpen((v) => !v)}
            className="inline-flex items-center gap-1 text-[10px] px-2.5 py-1 rounded-full border border-k3-border-subtle bg-k3-elevated/50 text-k3-text-secondary hover:text-k3-text-primary touch-manipulation min-h-[32px]"
          >
            {evidenceOpen ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            {evidenceOpen ? t.collapse : t.expand}
          </button>
          {evidenceOpen && (
            <ul id={evidenceId} className="mt-2 space-y-1" aria-label={t.evidence}>
              {card.evidence.map((ev, i) => (
                <li key={`${ev.time ?? 'na'}-${i}`} className="flex items-start gap-2 text-xs">
                  {ev.time && (
                    <span className="font-mono text-[10px] text-k3-text-tertiary w-10 flex-shrink-0 pt-px">
                      {ev.time}
                    </span>
                  )}
                  <span className="text-k3-text-secondary min-w-0">
                    {ev.text}
                    <span className="text-k3-text-tertiary"> · {ev.source}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Review first screen: "Where this game was lost" — exactly three conclusion
 * cards (turning point / one thing to fix / next-game rule) plus preset
 * follow-up chips.
 */
const ReviewConclusionCards: React.FC<ReviewConclusionCardsProps> = ({
  cards,
  lang,
  followUps,
  followUpEnabled,
  onFollowUp,
}) => {
  const t = {
    heading: lang === 'zh' ? '这局输在哪' : 'Where this game was lost',
    followUpsLabel: lang === 'zh' ? '继续追问' : 'Ask a follow-up',
  };

  return (
    <section data-testid="review-conclusions" className="space-y-2">
      <h3 className="text-sm font-semibold text-k3-text-primary flex items-center gap-2">
        <span className="w-1 h-4 bg-k3-dire rounded-full flex-shrink-0" />
        {t.heading}
      </h3>
      {cards.map((card, i) => (
        <ConclusionCard key={card.key} card={card} lang={lang} index={i} />
      ))}
      {followUps.length > 0 && (
        <div data-testid="review-preset-followups" className="pt-1">
          <p className="text-[10px] text-k3-text-tertiary mb-1.5">{t.followUpsLabel}</p>
          <div className="flex flex-wrap gap-2">
            {followUps.map((question) => (
              <button
                key={question}
                type="button"
                disabled={!followUpEnabled}
                onClick={() => onFollowUp(question)}
                className="text-xs px-3 py-2 rounded-full border border-k3-border-subtle bg-k3-elevated/60 text-k3-text-secondary hover:text-k3-text-primary hover:border-k3-radiant/30 hover:bg-k3-radiant/5 transition-colors touch-manipulation min-h-[40px] disabled:opacity-50 disabled:hover:text-k3-text-secondary disabled:hover:border-k3-border-subtle disabled:hover:bg-k3-elevated/60"
              >
                {question}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
};

export default ReviewConclusionCards;
