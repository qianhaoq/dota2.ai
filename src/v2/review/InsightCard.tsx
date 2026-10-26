import React, { useMemo } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { DictKey } from '../i18n/en';
import AiText from './AiText';
import { surface, FactChip } from './ConversationCards';
import { heroDisplayName } from './heroDisplayName';
import type { Fact, Insight, Review } from './types';

type Lang = 'en' | 'zh';

/** Light fallback when an older API still ships a long multi-sentence claim. */
export function cardConclusion(insight: Insight): string {
  const text = insight.claim?.text?.trim() ?? '';
  if (!text) return text;
  const parts = text.split(/(?<=[。．.!?！？])\s*/).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return text;
  const last = parts[parts.length - 1];
  if (insight.id === 'fix_this' && /优先|Prioritize|Review these|复查/.test(last)) return last;
  if (insight.id === 'next_game' && /优先练习|Practice consistent/.test(last)) return last;
  if (insight.id === 'turning_point' && /优先回看|Prioritize reviewing/.test(parts[0]) === false) {
    // Old laundry-list turning claims: keep full text rather than inventing a new sentence.
    return text;
  }
  if (/优先|Prioritize|Practice/.test(last) && parts[0] !== last) return last;
  return text;
}

function killedByRows(review: Review | undefined, lang: Lang): { slug: string; count: number; label: string }[] {
  const value = review?.facts?.killed_by?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, number>)
    .filter(([, n]) => typeof n === 'number' && n > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]))
    .map(([slug, count]) => ({ slug, count, label: heroDisplayName(slug, lang) }));
}

function windowFact(insight: Insight, review: Review | undefined): Fact | undefined {
  const deltaId = insight.metrics?.map(m => m.fact_id).find(id => /^gold\.window\..+\.delta$/.test(id));
  const parentId = deltaId?.replace(/\.delta$/, '');
  return (parentId && review?.facts?.[parentId]) || (deltaId && review?.facts?.[deltaId]) || undefined;
}

/** Numeric window delta from a gold.window.* fact (parent or .delta child). */
export function windowDelta(fact: Fact | undefined): number | undefined {
  if (!fact) return undefined;
  const v = fact.value;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const d = (v as { delta?: unknown }).delta;
    if (typeof d === 'number' && Number.isFinite(d)) return d;
  }
  return undefined;
}

/** Collapse wording only when the five-minute delta is clearly negative. */
export function goldWindowLabelKey(fact: Fact | undefined): 'cardGoldCollapse' | 'cardGoldWorstWindow' {
  const delta = windowDelta(fact);
  return delta != null && delta < 0 ? 'cardGoldCollapse' : 'cardGoldWorstWindow';
}

/** Localized metric name for a detail-row fact id / label_key. */
export function detailFactLabelKey(factId: string): DictKey | null {
  if (factId === 'gold.low') return 'factGoldLow';
  if (factId === 'deaths.total') return 'factDeathsTotal';
  if (factId === 'gold_fed') return 'goldFed';
  if (factId === 'time_dead') return 'timeDead';
  if (/^deaths\.behind/.test(factId)) return 'factDeathsBehind';
  if (/^comeback\..+\.gold$/.test(factId)) return 'factRecoveryGold';
  if (/^comeback\..+\.xp$/.test(factId)) return 'factRecoveryXp';
  if (/^gold\.window\./.test(factId)) return 'factWorstWindow';
  return null;
}

function MatchupBlock({ insight, review, lang, t }: {
  insight: Insight;
  review?: Review;
  lang: Lang;
  t: (k: DictKey) => string;
}) {
  if (insight.id === 'fix_this') {
    const rows = killedByRows(review, lang);
    if (!rows.length) return null;
    return (
      <div className="mt-[8px]" data-testid="card-matchup">
        <div className="text-d2-12 text-d2-ink-3 mb-[4px]">{t('cardMatchup')}</div>
        <ul className="list-none m-0 p-0 flex flex-col gap-[4px]">
          {rows.map(row => (
            <li key={row.slug} className="flex items-center gap-[8px] min-h-[28px] text-d2-15 font-semibold text-d2-ink-2 d2-tnum" data-testid="killer-row">
              <img
                className="w-[24px] h-[24px] rounded-[6px] object-cover flex-none"
                src={`https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${row.slug}.png`}
                alt=""
                loading="lazy"
              />
              <span className="min-w-0 truncate">{row.label}</span>
              <span className="ml-auto">{row.count}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (insight.id === 'turning_point') {
    const win = windowFact(insight, review);
    if (!win) return null;
    const change = win.display[lang];
    const when = win.display.t;
    return (
      <div className="mt-[8px]" data-testid="card-matchup">
        <div className="text-d2-12 text-d2-ink-3 mb-[4px]">{t('cardMatchup')}</div>
        <div className="text-d2-15 font-semibold text-d2-ink-2 d2-tnum">
          <span className="text-d2-ink-3 font-medium mr-[6px]">{t(goldWindowLabelKey(win))}</span>
          {when ? <span>{when}</span> : null}
          {when && change ? <span className="mx-[6px] text-d2-ink-4">·</span> : null}
          {change ? <span>{change}</span> : null}
        </div>
      </div>
    );
  }

  if (insight.id === 'next_game') {
    const gold = review?.facts?.['gold.at.10'];
    const lh = review?.facts?.['lh_at_10'];
    if (!gold && !lh) return null;
    return (
      <div className="mt-[8px]" data-testid="card-matchup">
        <div className="text-d2-12 text-d2-ink-3 mb-[4px]">{t('cardMatchup')}</div>
        <div className="flex flex-wrap gap-x-[14px] gap-y-[2px] text-d2-15 font-semibold text-d2-ink-2 d2-tnum">
          {gold ? <span>{t('cardGoldAt10')}: {gold.display[lang]}</span> : null}
          {lh ? <span>{t('cardLhAt10')}: {lh.display[lang]}</span> : null}
        </div>
      </div>
    );
  }

  return null;
}

function detailFacts(insight: Insight, review: Review | undefined): Fact[] {
  if (!review?.facts) return [];
  const metricIds = insight.metrics?.map(m => m.fact_id) ?? [];
  const extras = insight.id === 'fix_this' ? ['gold_fed', 'time_dead'] : [];
  const skip = new Set<string>();
  if (insight.id === 'fix_this') skip.add('killed_by'); // never render slug aggregate string
  if (insight.id === 'turning_point') {
    for (const id of metricIds) {
      if (/^gold\.window\..+\.delta$/.test(id)) {
        skip.add(id);
        skip.add(id.replace(/\.delta$/, ''));
      }
    }
  }
  if (insight.id === 'next_game') {
    skip.add('gold.at.10');
    skip.add('lh_at_10');
  }
  const ids = [...new Set([...metricIds, ...extras])].filter(id => !skip.has(id) && review.facts[id]);
  return ids.map(id => review.facts[id]).filter((f): f is Fact => !!f);
}

export default function InsightCard({ insight, review, index, streaming, onEvidence }: {
  insight: Insight;
  review?: Review;
  index: number;
  streaming: boolean;
  /** Opens the evidence sheet/panel for this claim (0-based index + trigger for focus return). */
  onEvidence?: (index: number, trigger: HTMLElement) => void;
}) {
  const { t, lang } = useI18n();
  const label = insight.id === 'turning_point' ? 'cardTurning' : insight.id === 'fix_this' ? 'cardMistake' : 'cardNext';
  const conclusion = useMemo(() => cardConclusion(insight), [insight]);
  const details = useMemo(() => detailFacts(insight, review), [insight, review]);
  const anchor = (at: number | undefined) => Object.values(review?.facts ?? {}).find(f => f.t === at && f.display.t)?.display.t;
  const from = anchor(insight.time?.from);
  const to = anchor(insight.time?.to);
  // Prefer insight time anchors; fall back to matchup window / first metric with t.
  const timeChip = (() => {
    if (from) return to && from !== to ? `${from}–${to}` : from;
    const win = windowFact(insight, review);
    if (win?.display.t) return win.display.t;
    for (const id of insight.metrics?.map(m => m.fact_id) ?? []) {
      const tDisp = review?.facts?.[id]?.display?.t;
      if (tDisp) return tDisp;
    }
    return undefined;
  })();

  const isHot = insight.id === 'turning_point';
  const isNext = insight.id === 'next_game';
  const borderColor = isHot ? 'border-l-d2-coral' : isNext ? 'border-l-d2-gold' : 'border-l-d2-ink-4';
  
  return (
    <article id={`claim-${index}`} className={`${surface} border-l-[3px] ${borderColor}`} data-testid="insight-card" data-insight={insight.id}>
      <div className="flex items-center justify-between text-d2-12">
        <b className="text-d2-gold-2 uppercase tracking-wider">{t(label)}</b>
        {timeChip ? (
          <span className="rounded-d2-chip bg-d2-surface-3 border border-d2-line px-[10px] min-h-[28px] flex items-center text-d2-13 font-semibold text-d2-ink-2 font-mono">
            {timeChip}
          </span>
        ) : null}
      </div>

      <div className="mt-[8px]" data-testid="card-conclusion">
        <div className="text-d2-12 text-d2-ink-4 mb-[2px]">{t('cardConclusion')}</div>
        <div className="text-d2-17 font-semibold text-d2-ink font-serif leading-[1.3]">
          <AiText variant="claim" text={conclusion} streaming={streaming} />
        </div>
      </div>

      <MatchupBlock insight={insight} review={review} lang={lang} t={t} />

      {details.length > 0 ? (
        <div className="mt-[8px]" data-testid="card-details">
          <div className="text-d2-12 text-d2-ink-4 mb-[4px]">{t('cardDetails')}</div>
          <div className="flex flex-wrap gap-[8px]">
            {details.map(f => {
              const key = detailFactLabelKey(f.id);
              return <FactChip key={f.id} fact={f} label={key ? t(key) : undefined} />;
            })}
          </div>
        </div>
      ) : null}

      <div className="mt-[12px] pt-[10px] border-t border-d2-line-2 flex items-center justify-between text-d2-12 text-d2-ink-4">
        <span>
          OpenDota{' '}
          {insight.citations.map(c => (
            <sup
              key={c}
              className="inline-grid place-items-center w-[15px] h-[15px] ml-[3px] rounded-full bg-d2-accent-bg text-d2-gold-2 text-[10px] font-bold"
            >
              {c.replace(/^s/, '')}
            </sup>
          ))}
        </span>
        <button
          className="ml-auto min-h-[32px] text-d2-gold-2 font-semibold uppercase tracking-wide text-[11px] hover:text-d2-gold-pale disabled:text-d2-disabled transition-colors flex items-center gap-[4px]"
          disabled={!onEvidence}
          onClick={event => onEvidence?.(index - 1, event.currentTarget)}
        >
          {t('evidenceShow')}
          <span aria-hidden="true">↗</span>
        </button>
      </div>
    </article>
  );
}
