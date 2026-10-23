import React, { useState } from 'react';
import { Check, ChevronDown, Share2, ArrowDown, Info } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { heroDisplayName } from './heroDisplayName';
import type { Fact, Followup, Hero, Review } from './types';
import type { ReviewStreamState } from './useReviewStream';
export const control = 'min-h-[44px] px-[12px] rounded-d2-control border border-d2-line-2 text-d2-accent bg-d2-surface';
export const surface = 'bg-d2-surface rounded-d2-card shadow-d2-2 p-[16px]';
export function ToolTrace({ steps, done, timings }: {
    steps: ReviewStreamState['steps'];
    done: boolean;
    timings?: Record<string, number | string>;
}) {
    const { t } = useI18n();
    const keys = ['fetch_match', 'parse_check', 'facts', 'insights', 'phrasing'] as const;
    const labels = ['traceFetch', 'traceTimeline', 'traceFacts', 'traceConclusions', 'tracePhrasing'] as const;
    return <details open={!done} className="rounded-d2-control bg-d2-surface shadow-d2-1 text-d2-13 text-d2-ink-3">
      <summary className="list-none flex items-center gap-[10px] min-h-[44px] px-[14px] cursor-pointer">
        {done && <Check size={18} aria-hidden="true"/>}<span>{done ? (timings?.total_display != null ? t('traceElapsed').replace('{seconds}', String(timings.total_display)) : t('traceAnalyzed')) : t('traceFetch')}</span><ChevronDown size={16} className="ml-auto" aria-hidden="true"/>
      </summary><ol className="list-none m-0 px-[16px] pb-[12px]">{keys.map((key, i) => {
        const status = steps[key]?.status ?? 'todo';
        return <li key={key} data-status={status} className={`flex items-center gap-[10px] min-h-[32px] text-d2-15 ${status === 'todo' ? 'text-d2-ink-4' : 'text-d2-ink-2 font-medium'}`}><span className="w-[18px] flex justify-center">{status === 'done' || status === 'skipped' ? <Check size={18}/> : status === 'active' ? <span className="w-[14px] h-[14px] rounded-full border-2 border-d2-surface-3 border-t-d2-ink-3 motion-safe:animate-spin"/> : <span className="w-[6px] h-[6px] rounded-full bg-d2-ink-4"/>}</span>{t(labels[i])}</li>;
      })}</ol></details>;
}
export function HeroGrid({ roster, pick }: {
    roster: Hero[];
    pick: (hero: Hero) => void;
}) {
    const { t, lang } = useI18n();
    return <section className={surface}><h2 className="text-d2-17 font-semibold tracking-[-0.01em] text-d2-ink m-0">{t('pickHeading')}</h2><p className="text-d2-13 text-d2-ink-3 m-0 mt-[4px]">{t('pickNote')}</p><div className="grid grid-cols-5 gap-[2px] mt-[12px]">{roster.map(h => <button className="min-w-0 flex flex-col items-center gap-[4px] py-[6px] rounded-d2-control hover:bg-d2-surface-2 text-d2-12 leading-[14px] break-words" onClick={() => pick(h)} key={h.hero_id}><img className="w-[48px] h-[48px] object-cover rounded-d2-avatar" src={`https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${h.hero}.png`} alt=""/>{heroDisplayName(h.hero, lang)}</button>)}</div></section>;
}
export function HeroCollapsedRow({ hero, change }: {
    hero: string;
    change: () => void;
}) {
    const { t, lang } = useI18n();
    return <button className="w-full flex items-center gap-[10px] min-h-[44px] px-[14px] rounded-d2-control bg-d2-surface shadow-d2-1 text-d2-13" aria-label={t('changeHero')} onClick={change}><img className="w-[28px] h-[28px] object-cover rounded-[7px]" src={`https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${hero}.png`} alt=""/><b className="min-w-0 truncate">{t('youPrefix')}: {heroDisplayName(hero, lang)}</b><span className="ml-auto text-d2-accent font-semibold">{t('changeHero')}</span></button>;
}
/** Only SVG coordinates are scaled here; all visible values use engine displays. */
export function MiniChart({ series }: {
    series: Review['series'];
}) {
    const { t } = useI18n();
    const arrays = [series.radiant_gold_adv ?? [], series.radiant_xp_adv ?? []];
    const nums = arrays.flat().filter((v): v is number => v != null && Number.isFinite(v));
    const bound = Math.max(1, ...nums.map(Math.abs));
    return <div className="mt-[12px]"><svg role="img" aria-label={t('miniChart')} viewBox="0 0 240 50" className="w-full h-[50px]">{arrays.map((values, i) => <polyline key={i} fill="none" stroke={i ? '#64748B' : '#B7791F'} strokeWidth="2" points={values.map((v, x) => v == null || !Number.isFinite(v) ? '' : `${x / Math.max(1, values.length - 1) * 240},${25 - v / bound * 23}`).filter(Boolean).join(' ')}/>)}</svg><div className="flex gap-[12px] text-d2-12 text-d2-ink-3"><span className="text-d2-gold">● {t('chartGold')}</span><span className="text-d2-xp">● {t('chartXp')}</span></div></div>;
}
export function FactChip({ fact }: {
    fact: Fact;
}) {
    const { lang } = useI18n();
    return <span className="inline-block rounded-d2-chip bg-d2-surface-2 px-[10px] py-[4px] text-d2-13 d2-tnum" title={fact.source_path}>{fact.display[lang]}{fact.display.t ? ` · ${fact.display.t}` : ''}</span>;
}
export function FollowupChips({ followups, asked, disabled, ask }: {
    followups: Followup[];
    asked: string[];
    disabled: boolean;
    ask: (f: Followup) => void;
}) {
    return <div className="flex flex-wrap gap-[8px]">{followups.filter(f => !asked.includes(f.id)).map(f => <button className="min-h-[36px] px-[12px] rounded-full border border-d2-line-2 bg-d2-surface text-d2-13 font-medium text-d2-ink-2 disabled:opacity-40" key={f.id} disabled={disabled} onClick={() => ask(f)}>{f.label}</button>)}</div>;
}
export function RefusalBubble({ gaps }: {
    gaps: Review['data_gaps'];
}) {
    const { t } = useI18n();
    return <aside className="bg-d2-surface-2 px-[14px] py-[12px] rounded-[14px] border-l-[3px] border-d2-ink-4 text-d2-15 text-d2-ink-2"><p className="flex gap-[10px]"><Info size={18} className="flex-none mt-[3px]"/>{t('refusalData')}</p>{gaps.map(g => <p key={g.topic} className="text-d2-13">{g.topic}: {g.reason}</p>)}</aside>;
}
export function Share({ matchId, hero, lang, claim, review }: {
    matchId: string;
    hero: string | null;
    lang: string;
    claim: string;
    review: Review;
}) {
    const { t } = useI18n();
    const [message, setMessage] = useState('');
    const [open, setOpen] = useState(false);
    const copy = async (json: boolean) => {
        try {
            const query = new URLSearchParams({ hero: hero ?? '', claim, lang });
            await navigator.clipboard.writeText(json ? JSON.stringify(review, null, 2) : `${window.location.origin}/m/${matchId}?${query}`);
            setMessage(t('copied'));
        }
        catch {
            setMessage(t('copyFailed'));
        }
    };
    return <div className="relative flex-none flex justify-end"><button className="min-w-[44px] min-h-[44px] justify-center px-[12px] rounded-d2-control flex items-center gap-[6px] text-d2-13 font-semibold text-d2-ink-3 hover:bg-d2-surface-2" aria-label={t('share')} aria-expanded={open} onClick={() => setOpen(!open)}><Share2 size={17}/><span className="hidden sm:inline">{t('share')}</span></button>{open && <div className="fixed right-[16px] top-[52px] sm:absolute sm:right-0 sm:top-full z-40 w-[220px] max-w-[calc(100vw-32px)] p-[8px] bg-d2-surface rounded-d2-card border border-d2-line shadow-d2-3"><button className={`${control} w-full mb-[8px]`} onClick={() => void copy(false)}>{t('copyLink')}</button><button className={`${control} w-full`} onClick={() => void copy(true)}>{t('copyJson')}</button><span className="text-d2-12" role="status">{message}</span></div>}</div>;
}
export function JumpToLatest({ jump }: {
    jump: () => void;
}) {
    const { t } = useI18n();
    return <button className={`fixed left-1/2 -translate-x-1/2 bottom-[124px] z-20 h-[32px] px-[12px] rounded-full bg-d2-surface shadow-d2-3 text-d2-13 font-semibold flex items-center gap-[6px]`} onClick={jump}>{t('jumpLatest')}<ArrowDown size={14}/></button>;
}
