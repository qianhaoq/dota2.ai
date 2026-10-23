import React from 'react';
import { useI18n } from '../i18n/I18nProvider';
import type { Review } from '../review/types';
import { dodgeLabels, seriesForPlayer, seriesPath } from './labels';

export type SeriesMode = 'gold' | 'xp' | 'both';

interface Marker {
  /** Minute index into the series array. */
  m: number;
  series: 'gold' | 'xp';
  /** Visible text — engine fact display only. */
  label: string;
  color: string;
  anchor: 'start' | 'middle' | 'end';
  dx: number;
  dy: number;
}

/**
 * Inline-SVG gold/XP advantage chart (no chart lib, per tech-plan §7.1).
 * Series arrays drive geometry only; every visible metric string is an engine
 * `fact.display`. Axis value labels are intentionally omitted for the same
 * reason — marker labels carry the numbers.
 *
 * Arrays stay Radiant-perspective in the engine; when the selected player is
 * Dire we flip both series so markers (gold.low etc.) land on the right points.
 * Null / non-finite samples break the path instead of plotting as zero.
 */
export default function GoldXpChart({ review, mode, band, bandLabel, width = 340, height = 176 }: {
    review: Review;
    mode: SeriesMode;
    /** Highlight window in seconds [from, to]. */
    band?: [number, number];
    /** Band caption — pass a fact display.t (e.g. '40:00–45:00'). */
    bandLabel?: string;
    width?: number;
    height?: number;
}) {
    const { t, lang } = useI18n();
    const { gold, xp } = seriesForPlayer(review.series);
    const showGold = mode !== 'xp', showXp = mode !== 'gold';
    const facts = review.facts;

    const markers: Marker[] = [];
    if (showGold && facts['gold.low']?.t != null) {
        const low = facts['gold.low'];
        markers.push({
            m: Math.round(low.t! / 60), series: 'gold',
            label: `${low.display[lang]}${low.display.t ? ` · ${low.display.t}` : ''}`,
            color: '#B91C1C', anchor: 'end', dx: -10, dy: 4,
        });
        const last = facts[`gold.at.${gold.length - 1}`];
        if (last) {
            markers.push({ m: gold.length - 1, series: 'gold', label: last.display[lang], color: '#B7791F', anchor: 'end', dx: -2, dy: 18 });
        }
    } else if (!showGold && showXp && facts['xp.peak']?.t != null) {
        const peak = facts['xp.peak'];
        markers.push({ m: Math.round(peak.t! / 60), series: 'xp', label: peak.display[lang], color: '#475569', anchor: 'end', dx: -6, dy: -8 });
    }

    const PL = 34, PR = 8, PT = 12, PB = 22;
    const all = [...(showGold ? gold : []), ...(showXp ? xp : [])].filter((v): v is number => Number.isFinite(v as number));
    if (!all.length) return null;
    let mn = Math.min(...all), mx = Math.max(...all, 0);
    // One finite sample or an all-equal series leaves mx === mn; pad must stay
    // nonzero or Y() divides by zero and SVG paths/markers become NaN (flat/invisible).
    const span = mx - mn;
    const pad = span > 0 ? span * 0.06 : Math.max(Math.abs(mn) * 0.05, 1);
    mn -= pad;
    mx += pad;
    const minutes = Math.max(1, gold.length - 1, xp.length - 1);
    const X = (m: number) => PL + (m / minutes) * (width - PL - PR);
    const Y = (v: number) => PT + ((mx - v) / (mx - mn)) * (height - PT - PB);
    const path = (arr: (number | null)[]) => seriesPath(arr, X, Y);

    // Marker labels, dodged so none overlaps another (handoff §6 low-label rule).
    // Skip markers whose series sample is missing — do not plot them at y=0.
    const labeled = dodgeLabels(markers.flatMap(mk => {
        const v = (mk.series === 'xp' ? xp : gold)[mk.m];
        if (v == null || !Number.isFinite(v)) return [];
        const widthPx = mk.label.length * 6.2;
        const cx = mk.anchor === 'end' ? X(mk.m) + mk.dx - widthPx / 2 : mk.anchor === 'start' ? X(mk.m) + mk.dx + widthPx / 2 : X(mk.m) + mk.dx;
        return [{ key: mk.label, cx, y: Y(v) + mk.dy, width: widthPx, mk, cy: Y(v) }];
    }));

    const gridValues = [20000, -20000].filter(v => v > mn && v < mx);
    const axisMinutes = [0, 15, 30, 45, 60].filter(m => m <= minutes);

    return <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto block overflow-visible" role="img" aria-label={t('evChartAria')} data-testid="gold-xp-chart" data-mode={mode} data-perspective={review.series.perspective ?? 'radiant'}>
      {band && <g>
        <rect x={X(band[0] / 60)} y={PT} width={Math.max(0, X(band[1] / 60) - X(band[0] / 60))} height={height - PT - PB} fill="#FEE2E2" opacity="0.7" rx="2"/>
        {bandLabel && <text x={(X(band[0] / 60) + X(band[1] / 60)) / 2} y={PT - 2} fontSize="10" fontWeight="600" fill="#B91C1C" textAnchor="middle">{bandLabel}</text>}
      </g>}
      {gridValues.map(v => <line key={v} x1={PL} x2={width - PR} y1={Y(v)} y2={Y(v)} stroke="#ECEEF2"/>)}
      <line x1={PL} x2={width - PR} y1={Y(0)} y2={Y(0)} stroke="#CBD1DA"/>
      {axisMinutes.map(m => <text key={m} x={X(m)} y={height - 6} fontSize="11" fill="#64748B" textAnchor={m === 0 ? 'start' : 'middle'}>{m}:00</text>)}
      {showXp && <path data-series="xp" d={path(xp)} fill="none" stroke="#94A3B8" strokeWidth="1.6" strokeDasharray="4 3" strokeLinejoin="round"/>}
      {showGold && <path data-series="gold" d={path(gold)} fill="none" stroke="#B7791F" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round"/>}
      {labeled.map(({ key, mk, y }) => {
          const v = (mk.series === 'xp' ? xp : gold)[mk.m];
          if (v == null || !Number.isFinite(v)) return null;
          return <g key={key}>
            <circle cx={X(mk.m)} cy={Y(v)} r="4" fill={mk.color} stroke="#fff" strokeWidth="1.5"/>
            <text x={X(mk.m) + mk.dx} y={y} fontSize="11" fontWeight="600" fill={mk.color} textAnchor={mk.anchor} className="d2-tnum">{mk.label}</text>
          </g>;
      })}
    </svg>;
}
