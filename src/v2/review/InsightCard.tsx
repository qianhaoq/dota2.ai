import React from 'react';
import { useI18n } from '../i18n/I18nProvider';
import AiText from './AiText';
import { surface } from './ConversationCards';
import type { Fact, Insight, Review } from './types';
export default function InsightCard({ insight, review, index, streaming }: {
    insight: Insight;
    review?: Review;
    index: number;
    streaming: boolean;
}) {
    const { t, lang } = useI18n();
    const label = insight.id === 'turning_point' ? 'cardTurning' : insight.id === 'fix_this' ? 'cardMistake' : 'cardNext';
    const metricIds = [...insight.metrics.map(m => m.fact_id), ...(insight.id === 'fix_this' ? ['killed_by', 'gold_fed', 'time_dead'] : [])];
    const facts = [...new Set(metricIds)].map(id => review?.facts[id]).filter((f): f is Fact => !!f);
    const anchor = (at: number | undefined) => Object.values(review?.facts ?? {}).find(f => f.t === at && f.display.t)?.display.t;
    const from = anchor(insight.time?.from), to = anchor(insight.time?.to);
    const time = from ? (to && from !== to ? `${from}–${to}` : from) : facts.find(f => f.display.t)?.display.t;
    return <article id={`claim-${index}`} className={surface} data-testid="insight-card"><div className="flex items-center justify-between text-d2-12 text-d2-ink-3"><b>{t(label)}</b><span className="rounded-d2-chip bg-d2-surface-2 px-[10px] min-h-[28px] flex items-center text-d2-13 font-semibold">{time}</span></div><div className="mt-[8px] text-d2-17 font-semibold"><AiText variant="claim" text={insight.claim.text} streaming={streaming}/></div><div className="flex flex-wrap gap-x-[12px] gap-y-[2px] mt-[6px] text-d2-15 font-semibold text-d2-ink-2 d2-tnum">{facts.map(f => <span key={f.id}>{f.display[lang]}{f.display.t ? ` · ${f.display.t}` : ''}</span>)}</div><div className="mt-[12px] pt-[10px] border-t border-d2-line flex items-center justify-between text-d2-12 text-d2-ink-4"><span>OpenDota {insight.citations.map(c => <sup key={c} className="inline-grid place-items-center w-[15px] h-[15px] ml-[3px] rounded-full bg-d2-accent-bg text-d2-accent text-[10px]">{c.replace(/^s/, '')}</sup>)}</span><button className="ml-auto min-h-[32px] text-d2-accent font-semibold" disabled title={t('evidenceSoon')}>{t('evidenceShow')}</button></div></article>;
}
