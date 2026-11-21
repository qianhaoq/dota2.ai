import React, { useMemo, useRef, useState } from 'react';
import type { Bi, CoachReport, DeathRow, FightRow, Review } from './types';
import { clock, k, useLang } from './ui';

const T = {
  gold: { en: 'Gold lead', zh: '经济差' },
  radiant: { en: 'Radiant', zh: '天辉' },
  dire: { en: 'Dire', zh: '夜魇' },
  even: { en: 'Even', zh: '均势' },
  yourDeaths: { en: 'your deaths (click to inspect)', zh: '你的死亡（点击定位）' },
  fights: { en: 'fights (click to inspect)', zh: '团战（点击定位）' },
  turning: { en: 'turning window', zh: '转折窗口' },
  diedTo: { en: 'Died to', zh: '死于' },
  died: { en: 'Died', zh: '阵亡' },
  fightWon: { en: 'Fight won', zh: '团战赢' },
  fightLost: { en: 'Fight lost', zh: '团战输' },
  fightEven: { en: 'Fight even', zh: '团战均势' },
  bought: { en: 'Bought', zh: '购入' },
  hint: { en: 'Hover timeline for minute details', zh: '悬停查看各分钟事件' },
} satisfies Record<string, Bi>;

/**
 * Interactive gold-lead timeline. Keeps the exact `.cx-graph`, `.cx-graph-axis`
 * and `.cx-graph-y` DOM contract while adding hover scrubbing, clickable death
 * dots and clickable teamfight ticks cross-linked to the detail chapters.
 */
export const GoldTimeline: React.FC<{
  report: CoachReport;
  review: Review | null;
  onSelectDeath?: (index: number) => void;
  onSelectFight?: (index: number) => void;
}> = ({ report, review, onSelectDeath, onSelectFight }) => {
  const { L } = useLang();
  const adv = report.timeline!.radiant_gold_adv;
  const W = 760; const H = 140; const pad = 6;
  const max = Math.max(2000, ...adv.map((v) => Math.abs(v)));
  const maxIdx = Math.max(1, adv.length - 1);
  const x = (i: number) => pad + (Math.max(0, Math.min(maxIdx, i)) / maxIdx) * (W - pad * 2);
  const y = (v: number) => H / 2 - (v / max) * (H / 2 - pad);
  const line = adv.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(adv.length - 1)},${H / 2} L${x(0)},${H / 2} Z`;
  const tp = review?.findings.find((f) => f.window)?.window;
  const ticks = Array.from({ length: Math.floor((adv.length - 1) / 10) + 1 }, (_, i) => i * 10);

  const [hoverMin, setHoverMin] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  const heroById = useMemo(() => new Map(report.players.map((p) => [p.hero.id, p.hero])), [report]);
  const deathRows: DeathRow[] = review?.chapters?.deaths?.rows ?? [];
  const fightRows: FightRow[] = review?.chapters?.fights?.rows ?? [];
  const itemRows = review?.chapters?.items?.rows ?? [];

  const handleMove = (clientX: number) => {
    const el = plotRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Account for the 40px left padding used by the y-axis labels.
    const leftPad = 40;
    const innerW = Math.max(1, rect.width - leftPad);
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left - leftPad) / innerW));
    setHoverMin(Math.round(ratio * maxIdx));
  };

  const hoverInfo = useMemo(() => {
    if (hoverMin == null) return null;
    const val = adv[hoverMin] ?? 0;
    const sec = hoverMin * 60;
    const deathsHere = deathRows.filter((d) => Math.abs(d.time - sec) <= 35);
    const fightsHere = fightRows.filter((f) => sec >= f.start - 25 && sec <= f.end + 25);
    const itemsHere = itemRows.filter((it) => Math.abs(it.time - sec) <= 35);
    return { min: hoverMin, val, deathsHere, fightsHere, itemsHere };
  }, [hoverMin, adv, deathRows, fightRows, itemRows]);

  // Use chapters.deaths.rows when present (richer metadata), fallback to review.deaths.
  const deathsForPlot = deathRows.length > 0
    ? deathRows.map((d, i) => ({ time: d.time, killer: d.killer, converted: d.converted, idx: i }))
    : (review?.deaths ?? []).map((d, i) => ({ time: d.time, killer: d.killer, converted: d.converted, idx: i }));

  return (
    <section className="cx-graph" aria-label={L(T.gold)}>
      <h3>
        <span>{L(T.gold)} <span className="cx-graph-hint">· {L(T.hint)}</span></span>
        <small><span className="r">{L(T.radiant)} ▲</span> <span className="d">{L(T.dire)} ▼</span></small>
      </h3>
      <div
        className="cx-graph-plot"
        ref={plotRef}
        onMouseMove={(e) => handleMove(e.clientX)}
        onMouseLeave={() => setHoverMin(null)}
        onTouchMove={(e) => { if (e.touches[0]) handleMove(e.touches[0].clientX); }}
        onTouchEnd={() => setHoverMin(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={L(T.gold)}>
          <defs>
            <clipPath id="cx-top"><rect x="0" y="0" width={W} height={H / 2} /></clipPath>
            <clipPath id="cx-bot"><rect x="0" y={H / 2} width={W} height={H / 2} /></clipPath>
          </defs>
          {tp && <rect className="cx-tp" x={x(tp[0] / 60)} width={Math.max(2, x(tp[1] / 60) - x(tp[0] / 60))} y="0" height={H} />}
          {ticks.slice(1).map((m) => <line key={m} x1={x(m)} x2={x(m)} y1="0" y2={H} className="cx-grid-v" />)}
          <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="cx-axis" />
          <path d={area} className="cx-area-r" clipPath="url(#cx-top)" />
          <path d={area} className="cx-area-d" clipPath="url(#cx-bot)" />
          <path d={line} className="cx-line" />
          {hoverMin != null && (
            <line x1={x(hoverMin)} x2={x(hoverMin)} y1="0" y2={H} className="cx-hover-line" />
          )}
        </svg>

        {hoverInfo && (
          <div
            className={`cx-graph-tip ${hoverInfo.min > maxIdx * 0.65 ? 'is-right' : ''}`}
            style={{ left: `calc(40px + (100% - 40px) * ${(x(hoverInfo.min) / W).toFixed(4)})` }}
            role="status"
          >
            <div className="cx-graph-tip-head">
              <b>{hoverInfo.min}:00</b>
              <span className={hoverInfo.val > 0 ? 'r' : hoverInfo.val < 0 ? 'd' : ''}>
                {hoverInfo.val === 0 ? L(T.even) : `${L(hoverInfo.val > 0 ? T.radiant : T.dire)} +${k(Math.abs(hoverInfo.val))}`}
              </span>
            </div>
            {hoverInfo.deathsHere.slice(0, 2).map((d, i) => {
              const h = d.killer != null ? heroById.get(d.killer) : null;
              return (
                <p key={`d${i}`} className="cx-tip-ev is-death">
                  {clock(d.time)} {h ? `${L(T.diedTo)} ${L(h)}` : L(T.died)}
                </p>
              );
            })}
            {hoverInfo.fightsHere.slice(0, 1).map((f, i) => (
              <p key={`f${i}`} className={`cx-tip-ev is-fight-${f.result}`}>
                {clock(f.start)} {L(f.result === 'won' ? T.fightWon : f.result === 'lost' ? T.fightLost : T.fightEven)} ({f.kills[0]}–{f.kills[1]})
              </p>
            ))}
            {hoverInfo.itemsHere.slice(0, 2).map((it, i) => (
              <p key={`i${i}`} className="cx-tip-ev is-item">
                {clock(it.time)} {L(T.bought)} {L(it.item)}
              </p>
            ))}
          </div>
        )}

        {fightRows.length > 0 && (
          <div className="cx-graph-fights">
            {fightRows.map((f, i) => {
              const leftPct = (x(f.start / 60) / W) * 100;
              const label = `${clock(f.start)} ${L(f.result === 'won' ? T.fightWon : f.result === 'lost' ? T.fightLost : T.fightEven)} (${f.kills[0]}–${f.kills[1]})`;
              return onSelectFight ? (
                <button
                  key={i}
                  type="button"
                  className={`cx-fight-tick is-${f.result}`}
                  style={{ left: `${leftPct}%` }}
                  title={label}
                  aria-label={label}
                  onClick={() => onSelectFight(i)}
                />
              ) : (
                <i key={i} className={`cx-fight-tick is-${f.result}`} style={{ left: `${leftPct}%` }} />
              );
            })}
          </div>
        )}

        {deathsForPlot.length > 0 && (
          <div className="cx-graph-deaths">
            {deathsForPlot.map((d) => {
              const leftPct = (x(d.time / 60) / W) * 100;
              const killer = d.killer != null ? heroById.get(d.killer) : null;
              const label = `${clock(d.time)} ${killer ? `${L(T.diedTo)} ${L(killer)}` : L(T.died)}`;
              return onSelectDeath ? (
                <button
                  key={d.idx}
                  type="button"
                  className={`cx-death-dot ${d.converted ? 'is-converted' : ''}`}
                  style={{ left: `${leftPct}%` }}
                  title={label}
                  aria-label={label}
                  onClick={() => onSelectDeath(d.idx)}
                />
              ) : (
                <i key={d.idx} style={{ left: `${leftPct}%` }} />
              );
            })}
          </div>
        )}

        <div className="cx-graph-y" aria-hidden="true">
          <span style={{ top: `${(y(max) / H) * 100}%` }}>+{k(max)}</span>
          <span style={{ top: '50%' }}>0</span>
          <span style={{ top: `${(y(-max) / H) * 100}%` }}>−{k(max)}</span>
        </div>
      </div>

      <div className="cx-graph-axis" aria-hidden="true">
        {ticks.map((m) => <span key={m} style={{ left: `${(x(m) / W) * 100}%` }}>{m}′</span>)}
      </div>

      {(deathsForPlot.length > 0 || fightRows.length > 0 || tp) && (
        <p className="cx-graph-legend">
          {deathsForPlot.length > 0 && <span><i className="cx-death-key" /> {L(T.yourDeaths)}</span>}
          {fightRows.length > 0 && <span><i className="cx-fight-key" /> {L(T.fights)}</span>}
          {tp && <span><i className="cx-tp-key" /> {L(T.turning)}</span>}
        </p>
      )}
    </section>
  );
};
