import React, { useEffect, useRef, useState } from 'react';
import { Language } from '../../types';
import type { A2UIBlock } from '../../types';
import type {
  ReviewCardsPayload,
  ReviewEvidence,
  KeyMomentCard,
} from '../../types/reviewCards';
import type { ReviewFollowUpContext } from '../../utils/reviewSurface';
import {
  AlertCircle, ChevronDown, ChevronUp, Clock, Crosshair, Target, Zap,
} from 'lucide-react';

export type ReviewInsightVariant = 'default' | 'surface' | 'hero' | 'timeline' | 'chips';

interface ReviewInsightCardsProps {
  block: A2UIBlock;
  lang: Language;
  variant?: ReviewInsightVariant;
  onFollowUp?: (question: string, context: ReviewFollowUpContext) => void;
  onComposeFollowUp?: (text: string, context: ReviewFollowUpContext) => void;
  followUpContext?: ReviewFollowUpContext;
  /** When false, hide drill / chip follow-up CTAs (e.g. AI unavailable fallback). */
  followUpActionsEnabled?: boolean;
}

const MISTAKE_COLORS: Record<string, string> = {
  fight_timing: 'text-orange-400 border-orange-400/30 bg-orange-400/10',
  itemisation: 'text-purple-400 border-purple-400/30 bg-purple-400/10',
  farm_route: 'text-yellow-400 border-yellow-400/30 bg-yellow-400/10',
};

const EvidenceChips: React.FC<{
  evidence: ReviewEvidence[];
  lang: Language;
  expandedKey?: string | null;
  onToggle?: (key: string) => void;
  ctaLabel?: string;
}> = ({ evidence, lang, expandedKey, onToggle, ctaLabel }) => {
  const detailRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (expandedKey && detailRef.current) {
      detailRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [expandedKey]);

  if (!evidence.length) return null;
  const t = {
    evidence: lang === 'zh' ? '证据' : 'Evidence',
    expand: ctaLabel ?? (lang === 'zh' ? '展开证据' : 'Show evidence'),
  };
  const expanded = expandedKey ? evidence.find((e) => e.factKey === expandedKey) : null;

  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-1.5">
        {evidence.length > 0 && !expandedKey && onToggle && (
          <button
            type="button"
            onClick={() => onToggle(evidence[0].factKey)}
            className="text-[10px] px-2.5 py-1 rounded-full border border-k3-border-subtle bg-k3-elevated/50 text-k3-text-secondary hover:text-k3-text-primary touch-manipulation min-h-[32px]"
          >
            {t.expand}
          </button>
        )}
        {evidence.map((ev) => {
          const isOpen = expandedKey === ev.factKey;
          return (
            <button
              key={ev.factKey}
              type="button"
              onClick={() => onToggle?.(ev.factKey)}
              className={`inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-full border transition-colors touch-manipulation min-h-[32px] ${
                isOpen
                  ? 'border-k3-radiant/40 bg-k3-radiant/15 text-k3-radiant'
                  : 'border-k3-border-subtle bg-k3-elevated/50 text-k3-text-tertiary hover:text-k3-text-secondary'
              }`}
            >
              <Zap size={9} className="flex-shrink-0" />
              <span className="font-medium">{ev.label}</span>
            </button>
          );
        })}
      </div>
      {expanded && (
        <p
          ref={detailRef}
          className="w-full text-xs text-k3-text-secondary mt-2 px-1 py-1.5 rounded-md bg-k3-base/60 border border-k3-border-subtle/50"
        >
          <span className="text-k3-text-tertiary">{t.evidence}: </span>
          {expanded.value}
        </p>
      )}
    </div>
  );
};

const CompactMomentTimeline: React.FC<{
  moments: KeyMomentCard[];
  lang: Language;
  timelineKey: string;
}> = ({ moments, lang, timelineKey }) => {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveIdx(null);
  }, [timelineKey]);

  useEffect(() => {
    if (activeIdx !== null && activeIdx >= moments.length) {
      setActiveIdx(null);
    }
  }, [activeIdx, moments.length]);

  useEffect(() => {
    if (activeIdx !== null && detailRef.current) {
      detailRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeIdx]);

  return (
    <div className="space-y-2">
      <div className="flex gap-1 overflow-x-auto pb-1 custom-scrollbar" role="tablist">
        {moments.map((moment, idx) => (
          <button
            key={`${moment.timestamp}-${idx}`}
            type="button"
            role="tab"
            aria-selected={activeIdx === idx}
            onClick={() => setActiveIdx((prev) => (prev === idx ? null : idx))}
            className={`flex-shrink-0 inline-flex items-center gap-1 text-[10px] font-mono px-2 py-1.5 rounded-full border touch-manipulation min-h-[36px] transition-colors ${
              activeIdx === idx
                ? 'border-k3-radiant/40 bg-k3-radiant/10 text-k3-radiant'
                : 'border-k3-border-subtle bg-k3-elevated/40 text-k3-text-secondary hover:text-k3-text-primary'
            }`}
          >
            <Clock size={9} />
            {moment.timestampLabel}
          </button>
        ))}
      </div>
      {activeIdx !== null && moments[activeIdx] && (
        <div ref={detailRef} className="rounded-md border border-k3-border-subtle/80 bg-k3-elevated/30 p-2.5">
          <MomentRow moment={moments[activeIdx]} lang={lang} defaultExpanded />
        </div>
      )}
      {activeIdx === null && (
        <ul className="space-y-1">
          {moments.map((moment, idx) => (
            <li key={`${moment.timestamp}-row-${idx}`} className="flex items-center gap-2 text-xs min-h-[32px]">
              <span className="font-mono text-[10px] text-k3-text-tertiary w-10 flex-shrink-0">
                {moment.timestampLabel}
              </span>
              <span className="text-k3-text-secondary truncate">{moment.headline}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const MomentRow: React.FC<{
  moment: KeyMomentCard;
  lang: Language;
  defaultExpanded?: boolean;
}> = ({ moment, lang, defaultExpanded = false }) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [evidenceKey, setEvidenceKey] = useState<string | null>(null);

  return (
    <div className="rounded-md border border-k3-border-subtle/80 bg-k3-elevated/30 p-2.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-start gap-2 text-left touch-manipulation min-h-[40px]"
      >
        <span className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-k3-base border border-k3-border-subtle text-k3-text-secondary flex-shrink-0">
          <Clock size={9} />
          {moment.timestampLabel}
        </span>
        <span className="text-sm text-k3-text-primary font-medium flex-1 min-w-0">{moment.headline}</span>
        {expanded ? <ChevronUp size={14} className="text-k3-text-tertiary flex-shrink-0 mt-0.5" /> : <ChevronDown size={14} className="text-k3-text-tertiary flex-shrink-0 mt-0.5" />}
      </button>
      {expanded && (
        <div className="mt-2 pl-0.5">
          <p className="text-xs text-k3-text-secondary leading-relaxed">{moment.why}</p>
          <EvidenceChips
            evidence={moment.evidence}
            lang={lang}
            expandedKey={evidenceKey}
            onToggle={(key) => setEvidenceKey((prev) => (prev === key ? null : key))}
          />
        </div>
      )}
    </div>
  );
};

export const ReviewInsightCards: React.FC<ReviewInsightCardsProps> = ({
  block,
  lang,
  variant = 'default',
  onFollowUp,
  onComposeFollowUp,
  followUpContext,
  followUpActionsEnabled = true,
}) => {
  const cards = block.reviewCards as ReviewCardsPayload | undefined;
  const kind = block.reviewCardKind;
  const [mistakeEvidenceKey, setMistakeEvidenceKey] = useState<string | null>(null);

  if (!cards || !kind) return null;

  if (kind === 'match_summary' && cards.match_summary) {
    const s = cards.match_summary;
    const resultClass = s.result === 'win'
      ? 'text-k3-radiant bg-k3-radiant/10 border-k3-radiant/25'
      : s.result === 'loss'
        ? 'text-k3-dire bg-k3-dire/10 border-k3-dire/25'
        : 'text-k3-text-secondary bg-k3-surface/40 border-k3-border-subtle';

    return (
      <div className="rounded-lg border border-k3-border-subtle bg-gradient-to-br from-k3-elevated/40 to-k3-base p-3">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${resultClass}`}>
            {s.resultLabel}
          </span>
          <span className="text-[10px] text-k3-text-tertiary font-mono">#{s.matchId}</span>
          <span className="text-[10px] text-k3-text-tertiary">{s.durationFormatted}</span>
        </div>
        <p className="text-base font-semibold text-k3-text-primary">{s.heroName}</p>
        {(s.kda || s.gpm != null || (s.laneGrounded && s.laneLabel)) && (
        <div className="flex flex-wrap gap-3 mt-2 text-xs text-k3-text-secondary">
          {s.kda && <span>KDA {s.kda}</span>}
          {s.gpm != null && <span>GPM {s.gpm}</span>}
          {s.laneGrounded && s.laneLabel && (
            <span>{lang === 'zh' ? '分路' : 'Lane'}: {s.laneLabel}</span>
          )}
        </div>
        )}
        {s.laneGrounded && (
          <p className="text-[10px] text-k3-text-tertiary mt-2 italic">
            {lang === 'zh' ? '分路根据录像站位推断' : 'Lanes inferred from replay positioning'}
          </p>
        )}
      </div>
    );
  }

  if (kind === 'phases' && cards.phases) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {cards.phases.map((phase) => (
          <div
            key={phase.phase}
            className="rounded-md border border-k3-border-subtle/70 bg-k3-elevated/25 p-2.5 min-w-0"
          >
            <p className="text-[10px] font-semibold text-k3-text-tertiary uppercase tracking-wide mb-1">
              {phase.label}
            </p>
            <p className="text-xs text-k3-text-secondary leading-relaxed">{phase.insight}</p>
            {phase.evidence.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {phase.evidence.slice(0, 2).map((ev) => (
                  <span
                    key={ev.factKey}
                    className="text-[9px] px-1.5 py-0.5 rounded bg-k3-base border border-k3-border-subtle text-k3-text-tertiary"
                    title={ev.value}
                  >
                    {ev.label}: {ev.value}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }

  if (kind === 'primary_mistake' && cards.primary_mistake) {
    const m = cards.primary_mistake;
    const colorClass = MISTAKE_COLORS[m.category] || MISTAKE_COLORS.fight_timing;
    const isHero = variant === 'hero';

    return (
      <div className={`rounded-xl p-3 sm:p-4 ${
        isHero
          ? 'border-2 border-k3-dire/35 bg-gradient-to-br from-k3-dire/8 via-k3-elevated/25 to-k3-base shadow-md shadow-k3-dire/5'
          : 'rounded-lg border-2 border-k3-border-subtle bg-k3-elevated/20'
      }`}>
        <div className="flex items-start gap-2 mb-2">
          <AlertCircle size={isHero ? 22 : 18} className="text-k3-dire flex-shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full border mb-1.5 ${colorClass}`}>
              {m.categoryLabel}
            </span>
            <h4 className={`font-semibold text-k3-text-primary ${isHero ? 'text-base sm:text-lg' : 'text-sm'}`}>
              {m.headline}
            </h4>
          </div>
        </div>
        <p className={`text-k3-text-secondary leading-relaxed pl-7 sm:pl-8 ${isHero ? 'text-sm' : 'text-xs'}`}>
          {m.explanation}
        </p>
        <div className="pl-7 sm:pl-8">
          <EvidenceChips
            evidence={m.evidence}
            lang={lang}
            expandedKey={mistakeEvidenceKey}
            onToggle={(key) => setMistakeEvidenceKey((prev) => (prev === key ? null : key))}
            ctaLabel={lang === 'zh' ? '展开证据' : 'Show evidence'}
          />
        </div>
      </div>
    );
  }

  if (kind === 'key_moments' && cards.key_moments) {
    if (variant === 'timeline') {
      return (
        <CompactMomentTimeline
          key={block.id}
          timelineKey={block.id}
          moments={cards.key_moments}
          lang={lang}
        />
      );
    }
    return (
      <div className="space-y-2">
        {cards.key_moments.map((moment, idx) => (
          <MomentRow key={`${moment.timestamp}-${idx}`} moment={moment} lang={lang} />
        ))}
      </div>
    );
  }

  if (kind === 'drill' && cards.drill) {
    const d = cards.drill;
    const drillContext = followUpContext;

    return (
      <div className="rounded-lg border border-k3-radiant/30 bg-k3-radiant/8 p-3 sm:p-4">
        <div className="flex items-center gap-2 mb-2">
          <Target size={18} className="text-k3-radiant flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm sm:text-base font-semibold text-k3-text-primary">{d.title}</p>
            <p className="text-[10px] text-k3-text-tertiary flex items-center gap-1 mt-0.5">
              <Crosshair size={9} />
              {lang === 'zh' ? `限时 ${d.duration}` : `Time-box: ${d.duration}`}
            </p>
          </div>
        </div>
        <ol className="list-none space-y-1.5 pl-1">
          {d.steps.map((step, i) => (
            <li key={i} className="flex items-start gap-2 text-xs sm:text-sm text-k3-text-secondary">
              <span className="w-5 h-5 rounded-full bg-k3-radiant/20 text-k3-radiant text-[9px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <p className="text-[10px] text-k3-text-tertiary italic flex-1 min-w-0">
            {lang === 'zh' ? '事实 → 洞察 → 练习' : 'Fact → Insight → Drill'}
          </p>
          {followUpActionsEnabled && onFollowUp && drillContext && (
            <button
              type="button"
              onClick={() => onFollowUp(
                lang === 'zh' ? '帮我细化这个练习' : 'Help me refine this drill',
                drillContext,
              )}
              className="text-[10px] px-2.5 py-1.5 rounded-full border border-k3-radiant/30 bg-k3-radiant/10 text-k3-radiant touch-manipulation min-h-[32px]"
            >
              {lang === 'zh' ? '练这个' : 'Practice this'}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (kind === 'followups' && cards.followups) {
    const chipContext = followUpContext;
    const canFollowUp = followUpActionsEnabled && Boolean(onFollowUp && chipContext);
    const chipClass = variant === 'chips'
      ? 'text-xs px-3 py-2 rounded-full border border-k3-border-subtle bg-k3-elevated/60 text-k3-text-secondary hover:text-k3-text-primary hover:border-k3-radiant/30 hover:bg-k3-radiant/5 transition-colors touch-manipulation min-h-[40px]'
      : 'text-xs px-3 py-2 rounded-full border border-k3-border-subtle bg-k3-elevated/40 text-k3-text-secondary hover:text-k3-text-primary hover:border-k3-text-tertiary transition-colors touch-manipulation min-h-[40px] disabled:opacity-50';

    return (
      <div className="flex flex-wrap gap-2">
        {cards.followups.map((chip) => (
          <button
            key={chip}
            type="button"
            onClick={() => {
              if (onComposeFollowUp && chipContext) {
                onComposeFollowUp(chip, chipContext);
                return;
              }
              if (!canFollowUp || !chipContext) return;
              onFollowUp?.(chip, chipContext);
            }}
            disabled={!onComposeFollowUp && !canFollowUp}
            className={chipClass}
          >
            {chip}
          </button>
        ))}
      </div>
    );
  }

  if (kind === 'mentor_note' && block.markdown) {
    return (
      <p className="text-sm text-k3-text-secondary italic leading-relaxed border-l-2 border-k3-text-tertiary/40 pl-3">
        {block.markdown}
      </p>
    );
  }

  return null;
};

export default ReviewInsightCards;
