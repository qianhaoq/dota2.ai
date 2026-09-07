import React, { useState } from 'react';
import { Language } from '../../types';
import type { A2UIBlock } from '../../types';
import type {
  ReviewCardsPayload,
  ReviewEvidence,
  KeyMomentCard,
} from '../../types/reviewCards';
import {
  AlertCircle, ChevronDown, ChevronUp, Clock, Crosshair, Target, Zap,
} from 'lucide-react';

interface ReviewInsightCardsProps {
  block: A2UIBlock;
  lang: Language;
  onFollowUp?: (question: string) => void;
}

const MISTAKE_COLORS: Record<string, string> = {
  fight_timing: 'text-orange-400 border-orange-400/30 bg-orange-400/10',
  itemisation: 'text-purple-400 border-purple-400/30 bg-purple-400/10',
  vision: 'text-cyan-400 border-cyan-400/30 bg-cyan-400/10',
  positioning: 'text-red-400 border-red-400/30 bg-red-400/10',
  farm_route: 'text-yellow-400 border-yellow-400/30 bg-yellow-400/10',
};

const EvidenceChips: React.FC<{
  evidence: ReviewEvidence[];
  lang: Language;
  expandedKey?: string | null;
  onToggle?: (key: string) => void;
}> = ({ evidence, lang, expandedKey, onToggle }) => {
  if (!evidence.length) return null;
  const t = { evidence: lang === 'zh' ? '证据' : 'Evidence' };

  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
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
      {expandedKey && evidence.find((e) => e.factKey === expandedKey) && (
        <p className="w-full text-xs text-k3-text-secondary mt-1 px-1">
          <span className="text-k3-text-tertiary">{t.evidence}: </span>
          {evidence.find((e) => e.factKey === expandedKey)?.value}
        </p>
      )}
    </div>
  );
};

const MomentRow: React.FC<{
  moment: KeyMomentCard;
  lang: Language;
}> = ({ moment, lang }) => {
  const [expanded, setExpanded] = useState(false);
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
  onFollowUp,
}) => {
  const cards = block.reviewCards as ReviewCardsPayload | undefined;
  const kind = block.reviewCardKind;
  const [mistakeEvidenceKey, setMistakeEvidenceKey] = useState<string | null>(null);

  if (!cards || !kind) return null;

  if (kind === 'match_summary' && cards.match_summary) {
    const s = cards.match_summary;
    const resultClass = s.result === 'win'
      ? 'text-k3-radiant bg-k3-radiant/10 border-k3-radiant/25'
      : 'text-k3-dire bg-k3-dire/10 border-k3-dire/25';

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
        <div className="flex flex-wrap gap-3 mt-2 text-xs text-k3-text-secondary">
          <span>KDA {s.kda}</span>
          <span>GPM {s.gpm}</span>
          {s.laneGrounded && s.laneLabel && (
            <span>{lang === 'zh' ? '分路' : 'Lane'}: {s.laneLabel}</span>
          )}
        </div>
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

    return (
      <div className="rounded-lg border-2 border-k3-border-subtle p-3 bg-k3-elevated/20">
        <div className="flex items-start gap-2 mb-2">
          <AlertCircle size={18} className="text-k3-dire flex-shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full border mb-1.5 ${colorClass}`}>
              {m.categoryLabel}
            </span>
            <h4 className="text-sm font-semibold text-k3-text-primary">{m.headline}</h4>
          </div>
        </div>
        <p className="text-xs text-k3-text-secondary leading-relaxed pl-7">{m.explanation}</p>
        <div className="pl-7">
          <EvidenceChips
            evidence={m.evidence}
            lang={lang}
            expandedKey={mistakeEvidenceKey}
            onToggle={(key) => setMistakeEvidenceKey((prev) => (prev === key ? null : key))}
          />
        </div>
      </div>
    );
  }

  if (kind === 'key_moments' && cards.key_moments) {
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
    return (
      <div className="rounded-lg border border-k3-radiant/25 bg-k3-radiant/5 p-3">
        <div className="flex items-center gap-2 mb-2">
          <Target size={16} className="text-k3-radiant flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-k3-text-primary">{d.title}</p>
            <p className="text-[10px] text-k3-text-tertiary flex items-center gap-1 mt-0.5">
              <Crosshair size={9} />
              {lang === 'zh' ? `限时 ${d.duration}` : `Time-box: ${d.duration}`}
            </p>
          </div>
        </div>
        <ol className="list-none space-y-1.5 pl-1">
          {d.steps.map((step, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-k3-text-secondary">
              <span className="w-4 h-4 rounded-full bg-k3-radiant/20 text-k3-radiant text-[9px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        <p className="text-[10px] text-k3-text-tertiary mt-2 italic">
          {lang === 'zh' ? '事实 → 洞察 → 练习' : 'Fact → Insight → Drill'}
        </p>
      </div>
    );
  }

  if (kind === 'followups' && cards.followups) {
    return (
      <div className="flex flex-wrap gap-2">
        {cards.followups.map((chip) => (
          <button
            key={chip}
            type="button"
            onClick={() => onFollowUp?.(chip)}
            disabled={!onFollowUp}
            className="text-xs px-3 py-2 rounded-full border border-k3-border-subtle bg-k3-elevated/40 text-k3-text-secondary hover:text-k3-text-primary hover:border-k3-text-tertiary transition-colors touch-manipulation min-h-[40px] disabled:opacity-50"
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
