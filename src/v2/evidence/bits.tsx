import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, Info, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { heroDisplayName } from '../review/heroDisplayName';
import type { Review } from '../review/types';
import { itemName, itemRows, killerRows } from './labels';
import type { Moment, SourceRow } from './labels';
import type { SeriesMode } from './GoldXpChart';

export const section = 'px-[16px] py-[14px] border-t border-d2-line first:border-t-0';
export const sectionH = 'm-0 mb-[8px] text-d2-13 font-semibold text-d2-ink-2';

/** Gold/XP/Both switch. Toggle buttons (aria-pressed), not tabs — no tabpanel exists. */
export function Segmented({ value, onChange }: {
    value: SeriesMode;
    onChange: (mode: SeriesMode) => void;
}) {
    const { t } = useI18n();
    const options: [SeriesMode, string][] = [['gold', t('serGold')], ['xp', t('serXP')], ['both', t('serBoth')]];
    return <div role="group" aria-label={t('evSeriesAria')} className="inline-flex gap-[2px] p-[3px] rounded-d2-chip bg-d2-surface-2 mb-[10px]">{options.map(([mode, label]) => <button key={mode} aria-pressed={value === mode} onClick={() => onChange(mode)} className={`h-[30px] px-[12px] rounded-d2-chip text-d2-13 ${value === mode ? 'bg-d2-surface text-d2-ink shadow-d2-1 font-semibold' : 'font-medium text-d2-ink-3'}`}>{label}</button>)}</div>;
}

/** ‹ N/3 › claim pager (+ sheet close button when in the sheet). */
export function Pager({ claim, total, onPage, onClose }: {
    claim: number;
    total: number;
    onPage: (index: number) => void;
    onClose?: () => void;
}) {
    const { t } = useI18n();
    const btn = 'w-[32px] h-[32px] rounded-d2-control grid place-items-center text-d2-ink-3 disabled:opacity-30';
    return <div className="flex items-center flex-none text-d2-12 text-d2-ink-4" data-testid="evidence-pager">
      <button className={btn} aria-label={t('evPrev')} disabled={claim <= 0} onClick={() => onPage(claim - 1)}><ChevronLeft size={16} aria-hidden="true"/></button>
      <span className="d2-tnum">{claim + 1}/{total}</span>
      <button className={btn} aria-label={t('evNext')} disabled={claim >= total - 1} onClick={() => onPage(claim + 1)}><ChevronRight size={16} aria-hidden="true"/></button>
      {onClose && <button className={`${btn} w-[36px] h-[36px]`} aria-label={t('evClose')} onClick={onClose}><X size={18} aria-hidden="true"/></button>}
    </div>;
}

/** Key/value stat tiles. Values and times are engine fact displays. */
export function KV({ entries }: {
    entries: {
        value: string;
        label: string;
        sub?: string;
        down?: boolean;
    }[];
}) {
    if (!entries.length) return null;
    return <div className={`grid gap-[8px] ${entries.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>{entries.map(entry => <div key={entry.label} className="bg-d2-surface-2 rounded-[12px] px-[12px] py-[10px]">
      <b className={`block text-d2-17 font-semibold d2-tnum ${entry.down ? 'text-d2-down' : ''}`}>{entry.value}</b>
      <span className="block text-d2-12 text-d2-ink-4 d2-tnum">{entry.label}</span>
      {entry.sub && <span className="block text-d2-12 text-d2-ink-4 d2-tnum">{entry.sub}</span>}
    </div>)}</div>;
}

const momentIcon = (kind: Moment['kind']) => {
    if (kind === 'rosh') return <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="#7C3AED"/></svg>;
    if (kind === 'up') return <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5l8 13H4z" fill="#15803D"/></svg>;
    if (kind === 'note') return <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3" fill="#CBD1DA"/></svg>;
    return <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19L4 6h16z" fill="#B91C1C"/></svg>;
};

export function MomentsList({ moments }: {
    moments: Moment[];
}) {
    if (!moments.length) return null;
    return <ul className="list-none m-0 p-0">{moments.map((moment, i) => <li key={`${moment.t}-${i}`} className={`flex items-center gap-[10px] min-h-[40px] border-b border-d2-line last:border-b-0 text-[14px] leading-[20px] text-d2-ink-2 ${moment.hl ? 'bg-gradient-to-r from-d2-down-bg to-transparent -mx-[8px] px-[8px] rounded-[8px] border-b-transparent' : ''}`}>
      <span className="w-[44px] flex-none text-d2-13 font-semibold text-d2-ink-3 d2-tnum">{moment.time}</span>
      <span className="w-[16px] flex-none grid place-items-center">{momentIcon(moment.kind)}</span>
      <span>{moment.label}</span>
    </li>)}</ul>;
}

/** Deaths-over-time strip. Death dots are geometry from the raw deaths array. */
export function DeathStrip({ review, band, bandLabel, topKiller, width = 340, height = 62 }: {
    review: Review;
    /** Highlight window in seconds [from, to]; skipped when empty. */
    band?: [number, number];
    bandLabel?: string;
    topKiller?: string;
    width?: number;
    height?: number;
}) {
    const { t } = useI18n();
    const deaths = review.deaths ?? [];
    if (!deaths.length) return null;
    const duration = review.match.duration_s ?? Math.max(...deaths.map(d => d.t));
    const PL = 6, PR = 6;
    const X = (time: number) => PL + (time / Math.max(1, duration)) * (width - PL - PR);
    const axisMinutes = [0, 15, 30, 45, 60].filter(m => m * 60 <= duration);
    return <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto block" role="img" aria-label={t('evDeathsAria')} data-testid="death-strip">
      {band && band[1] > band[0] && <g>
        <rect x={X(band[0])} y="4" width={X(band[1]) - X(band[0])} height="38" rx="8" fill="#FEF2F2"/>
        {bandLabel && <text x={X(band[0]) + 8} y="16" fontSize="10" fontWeight="600" fill="#B91C1C" className="d2-tnum">{bandLabel}</text>}
      </g>}
      <line x1={PL} x2={width - PR} y1="29" y2="29" stroke="#CBD1DA"/>
      {deaths.map((death, i) => {
          const hot = topKiller != null && death.killer === topKiller;
          return <circle key={i} cx={X(death.t)} cy="29" r={hot ? 5 : 4} fill={hot ? '#B91C1C' : '#94A3B8'} stroke="#fff" strokeWidth="1.5"/>;
      })}
      {axisMinutes.map(m => <text key={m} x={X(m * 60)} y="57" fontSize="11" fill="#64748B" textAnchor={m === 0 ? 'start' : 'middle'}>{m}:00</text>)}
    </svg>;
}

/** Who-killed-you bars: visible counts from `killed_by.*` displays, widths derived. */
export function KillerBars({ review }: {
    review: Review;
}) {
    const { lang } = useI18n();
    const rows = killerRows(review, lang);
    if (!rows.length) return null;
    return <div data-testid="killer-bars">{rows.map((row, i) => <div key={row.slug} className="flex items-center gap-[10px] min-h-[36px]">
      <img className="w-[28px] h-[28px] rounded-[7px] object-cover" src={`https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${row.slug}.png`} alt="" loading="lazy"/>
      <span className="w-[96px] text-d2-13 text-d2-ink-2 truncate">{heroDisplayName(row.slug, lang)}</span>
      <span className="flex-1 h-[8px] rounded-d2-chip bg-d2-surface-2 overflow-hidden"><span className={`block h-full rounded-d2-chip ${i === 0 ? 'bg-d2-down' : 'bg-[#94A3B8]'}`} style={{ width: `${Math.round(row.share * 100)}%` }}/></span>
      <span className="w-[22px] text-right text-d2-13 font-semibold d2-tnum">{row.count ?? ''}</span>
    </div>)}</div>;
}

/** Purchase grid: item names localized via bilingual map; times are mm:ss row labels. */
export function ItemsGrid({ review }: {
    review: Review;
}) {
    const { lang } = useI18n();
    const rows = itemRows(review);
    if (!rows.length) return null;
    return <ul className="list-none p-0 m-0 grid grid-cols-2 gap-[6px]" data-testid="items-grid">{rows.map((row, i) => <li key={`${row.item}-${row.time}-${i}`} className={`flex justify-between gap-[6px] px-[10px] py-[8px] rounded-d2-control text-d2-13 text-d2-ink-2 ${row.key ? 'bg-d2-accent-bg' : 'bg-d2-surface-2'}`}>
      <span className="min-w-0 truncate">{itemName(row.item, lang)}</span>
      <b className={`font-semibold d2-tnum ${row.key ? 'text-d2-accent' : 'text-d2-ink-3'}`}>{row.time}</b>
    </li>)}</ul>;
}

/** Honest "not enough data" box — rendered only for registered data gaps. */
export function GapBox({ title, body, reason }: {
    title: string;
    body: string;
    reason?: string;
}) {
    return <div className="flex gap-[10px] p-[12px] rounded-[12px] bg-d2-surface-2 border border-dashed border-d2-disabled" data-testid="gap-box">
      <Info size={16} className="flex-none mt-[2px] text-d2-ink-4" aria-hidden="true"/>
      <div>
        <b className="block text-d2-15 font-semibold text-d2-ink">{title}</b>
        <p className="m-0 mt-[2px] text-d2-13 text-d2-ink-3">{body}</p>
        {reason && <code className="block mt-[6px] text-[11px] leading-[16px] text-d2-ink-3 font-mono">{reason}</code>}
      </div>
    </div>;
}

/** Source fields behind the claim, plus match/patch/parse badges and the citation link. */
export function Sources({ review, rows }: {
    review: Review;
    rows: SourceRow[];
}) {
    const { t } = useI18n();
    const citation = review.citations?.[0];
    return <div data-testid="evidence-sources">
      <ul className="list-none m-0 p-0 text-d2-13 text-d2-ink-3">{rows.map((row, i) => <li key={row.field} className="flex gap-[8px] py-[4px] items-start">
        <span className="w-[18px] h-[18px] rounded-full bg-d2-accent-bg text-d2-accent text-[11px] font-semibold grid place-items-center flex-none d2-tnum">{i + 1}</span>
        <span><code className="font-mono text-d2-12">opendota · {row.field}</code> <span className="text-d2-12 text-d2-ink-4">{t(row.caption)}</span></span>
      </li>)}</ul>
      <div className="flex flex-wrap gap-[6px] mt-[10px]">
        <span className="inline-flex items-center h-[22px] px-[8px] rounded-d2-chip text-d2-12 font-semibold whitespace-nowrap bg-d2-surface-2 text-d2-ink-3 d2-tnum">Match {review.match.id}</span>
        {review.match.patch != null && <span className="inline-flex items-center h-[22px] px-[8px] rounded-d2-chip text-d2-12 font-semibold whitespace-nowrap bg-d2-surface-2 text-d2-ink-3">{t('badgePatch').replace('{v}', String(review.match.patch))}</span>}
        {review.match.parsed && <span className="inline-flex items-center h-[22px] px-[8px] rounded-d2-chip text-d2-12 font-semibold whitespace-nowrap bg-d2-up-bg text-d2-up">{t('badgeParsed')}</span>}
      </div>
      {citation && <div className="mt-[8px] text-d2-12 text-d2-ink-4" data-testid="evidence-fetched">
        {t('srcFetched')} {citation.fetched_at} · <a href={citation.url} target="_blank" rel="noopener" className="text-d2-accent font-semibold no-underline">OpenDota ↗</a>
      </div>}
    </div>;
}

/**
 * 👍/👎 claim feedback — persists via POST /api/feedback (kind evidence_claim_vote)
 * before showing the logged thanks line. Failures keep the buttons and show an error.
 * Payload includes match / hero / insight so votes for the same claim ordinal across
 * different reviews stay distinguishable in the feedback store.
 */
export function Feedback({ review, claim }: {
    review: Review;
    claim: number;
}) {
    const { t, lang } = useI18n();
    const [votes, setVotes] = useState<Record<string, 'y' | 'n'>>({});
    const [pending, setPending] = useState(false);
    const [error, setError] = useState(false);
    const matchId = review.match.id;
    const hero = review.player?.hero ?? '';
    const insightId = review.insights[claim]?.id ?? '';
    const voteKey = `${matchId}:${hero}:${insightId || claim}`;
    const vote = votes[voteKey];
    if (vote) return <p className="m-0 text-d2-13 text-d2-ink-3" role="status">{t('fbThanks')}</p>;
    const submit = async (choice: 'y' | 'n') => {
        if (pending) return;
        setPending(true);
        setError(false);
        try {
            const res = await fetch('/api/feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind: 'evidence_claim_vote',
                    message: `${choice}:claim=${claim + 1}:match=${matchId}:hero=${hero}:insight=${insightId}`,
                    lang,
                    matchId,
                    hero,
                    insightId,
                }),
            });
            const data = await res.json().catch(() => null) as { ok?: boolean } | null;
            if (!res.ok || !data?.ok) throw new Error('feedback_failed');
            setVotes(prev => ({ ...prev, [voteKey]: choice }));
        } catch {
            setError(true);
        } finally {
            setPending(false);
        }
    };
    const btn = 'h-[32px] px-[12px] rounded-d2-chip border border-d2-line-2 bg-d2-surface text-d2-13 inline-flex items-center gap-[6px] disabled:opacity-40';
    return <div className="flex items-center gap-[8px] flex-wrap text-d2-13 text-d2-ink-3">
      {t('fbQ')}
      <button className={btn} aria-pressed={false} disabled={pending} onClick={() => void submit('y')}><ThumbsUp size={14} aria-hidden="true"/>{t('fbY')}</button>
      <button className={btn} aria-pressed={false} disabled={pending} onClick={() => void submit('n')}><ThumbsDown size={14} aria-hidden="true"/>{t('fbN')}</button>
      {error && <span role="alert" className="text-d2-down text-d2-12">{t('fbError')}</span>}
    </div>;
}
