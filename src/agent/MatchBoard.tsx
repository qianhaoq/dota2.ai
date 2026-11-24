import React from 'react';
import { SafeImg } from '../coach/ui';
import type { CoachReport, Player } from '../coach/types';

type Lang = 'en' | 'zh';
type Bi = Record<Lang, string>;

const T = {
  scoreboard: { en: 'Scoreboard', zh: '记分板' },
  radiant: { en: 'Radiant', zh: '天辉' },
  dire: { en: 'Dire', zh: '夜魇' },
  won: { en: 'victory', zh: '胜利' },
  you: { en: 'you', zh: '你' },
  yourSide: { en: 'your side', zh: '你方' },
  teamWorth: { en: 'net worth', zh: '总经济' },
  gold: { en: 'Gold lead by minute', zh: '每分钟经济差' },
  goldUp: { en: 'Radiant ahead', zh: '天辉领先' },
  goldDown: { en: 'Dire ahead', zh: '夜魇领先' },
  goldEnd: { en: 'at the end', zh: '结束时' },
  hero: { en: 'Hero', zh: '英雄' },
  level: { en: 'Lvl', zh: '等级' },
  kda: { en: 'K / D / A', zh: '杀 / 死 / 助' },
  lhdn: { en: 'LH / DN', zh: '正补 / 反补' },
  worth: { en: 'Net worth', zh: '经济' },
  gpm: { en: 'GPM', zh: 'GPM' },
  dmg: { en: 'Hero dmg', zh: '英雄伤害' },
  items: { en: 'Items', zh: '出装' },
  done: { en: 'finished', zh: '成型' },
} satisfies Record<string, Bi>;

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clock = (s: number) => `${Math.floor(Math.abs(s) / 60)}:${String(Math.floor(Math.abs(s)) % 60).padStart(2, '0')}`;
const thousands = (n: number) => n.toLocaleString('en-US');
/** 18,681 → "18.7k"; under 1,000 as it is. */
const k = (n: number) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/**
 * Radiant's gold lead per minute (OpenDota's radiant_gold_adv), drawn as one
 * line around zero: above is Radiant ahead, below is Dire ahead. Team colours,
 * not "good / bad", so it reads the same whichever hero the review is for.
 */
const GoldCurve: React.FC<{ adv: number[]; lang: Lang }> = ({ adv, lang }) => {
  const W = 640; const H = 132; const pad = 6;
  const max = Math.max(2000, ...adv.map((v) => Math.abs(v)));
  const x = (i: number) => pad + (i / Math.max(1, adv.length - 1)) * (W - 2 * pad);
  const y = (v: number) => H / 2 - (v / max) * (H / 2 - pad);
  const line = adv.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${x(0)},${H / 2} ${line} ${x(adv.length - 1)},${H / 2}`;
  const end = adv[adv.length - 1];
  const ticks = adv.map((_, i) => i).filter((i) => i > 0 && i % 10 === 0);
  return (
    <figure className="ag-gold">
      <figcaption>
        <span>{T.gold[lang]}</span>
        <span className="ag-gold-end">{T.goldEnd[lang]} <b className={end >= 0 ? 'is-radiant' : 'is-dire'}>{end >= 0 ? T.radiant[lang] : T.dire[lang]} +{thousands(Math.abs(Math.round(end)))}</b></span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`${T.gold[lang]}: ${T.goldEnd[lang]} ${end >= 0 ? T.radiant[lang] : T.dire[lang]} +${thousands(Math.abs(Math.round(end)))}`}>
        <defs>
          <clipPath id="ag-gold-up"><rect x="0" y="0" width={W} height={H / 2} /></clipPath>
          <clipPath id="ag-gold-down"><rect x="0" y={H / 2} width={W} height={H / 2} /></clipPath>
        </defs>
        {ticks.map((i) => <line key={i} className="ag-gold-tick" x1={x(i)} x2={x(i)} y1={0} y2={H} />)}
        <polygon className="ag-gold-area is-radiant" points={area} clipPath="url(#ag-gold-up)" />
        <polygon className="ag-gold-area is-dire" points={area} clipPath="url(#ag-gold-down)" />
        <line className="ag-gold-zero" x1={0} x2={W} y1={H / 2} y2={H / 2} />
        <polyline className="ag-gold-line" points={line} />
      </svg>
      <div className="ag-gold-axis" aria-hidden="true">
        <span className="is-radiant">▲ {T.goldUp[lang]}</span>
        <span>{ticks.map((i) => <i key={i} style={{ left: `${(x(i) / W) * 100}%` }}>{i}:00</i>)}</span>
        <span className="is-dire">▼ {T.goldDown[lang]}</span>
      </div>
    </figure>
  );
};

/** Each player's items, with the time a key item was finished when the replay has it. */
const Items: React.FC<{ p: Player; spikes: Map<string, number>; lang: Lang }> = ({ p, spikes, lang }) => {
  const items = Array.isArray(p.items) ? p.items : [];
  if (!items.length) return <span className="ag-items is-empty">—</span>;
  return (
    <span className="ag-items">
      {items.map((it, i) => {
        const at = spikes.get(it.key);
        const name = it[lang] ?? it.en ?? it.key;
        const label = at != null ? `${name} · ${T.done[lang]} ${clock(at)}` : name;
        return it.img ? <SafeImg key={`${it.key}-${i}`} src={it.img} alt={label} title={label} className="ag-item" /> : <span key={`${it.key}-${i}`} className="ag-item is-text" title={label}>{name}</span>;
      })}
    </span>
  );
};

const Row: React.FC<{ p: Player; me: boolean; spikes: Map<string, number>; lang: Lang }> = ({ p, me, spikes, lang }) => {
  const [kk, d, a] = Array.isArray(p.kda) ? p.kda : [null, null, null];
  return (
    <li className={`${p.radiant ? 'is-radiant' : 'is-dire'}${me ? ' is-me' : ''}`}>
      <span className="ag-row-hero">
        {p.hero?.img ? <SafeImg src={p.hero.img} alt={p.hero[lang]} className="ag-portrait" /> : <span className="ag-portrait ag-portrait--blank" />}
        <span className="ag-row-name">{p.hero?.[lang]}</span>{me && <em>{T.you[lang]}</em>}
        {num(p.level) && <span className="ag-row-lvl" title={T.level[lang]}>{p.level}</span>}
      </span>
      <span className="ag-kda" title={T.kda[lang]}>{kk ?? '–'} / {d ?? '–'} / {a ?? '–'}</span>
      <span className="ag-row-lh" title={T.lhdn[lang]}>{num(p.last_hits) ? `${p.last_hits} / ${num(p.denies) ? p.denies : '–'}` : ''}</span>
      <span className="ag-row-nw" title={T.worth[lang]}>{num(p.net_worth) ? k(p.net_worth) : ''}</span>
      <span className="ag-row-gpm" title={num(p.xpm) ? `GPM ${p.gpm} · XPM ${p.xpm}` : T.gpm[lang]}>{num(p.gpm) ? p.gpm : ''}</span>
      <span className="ag-row-dmg" title={T.dmg[lang]}>{num(p.hero_damage) ? k(p.hero_damage) : ''}</span>
      <Items p={p} spikes={spikes} lang={lang} />
    </li>
  );
};

/**
 * Both line-ups with what each player ended on — level, K/D/A, last hits, net
 * worth, GPM/XPM, hero damage and items — and the gold lead minute by minute.
 * All of it is the match record (the coach report), not the review's words.
 * `hero` is the player the review is for: their side comes first and their row is marked.
 */
export const MatchBoard: React.FC<{ report: CoachReport; hero?: string | null; lang: Lang }> = ({ report, hero = null, lang }) => {
  const players = Array.isArray(report.players) ? report.players : [];
  const me = hero ? players.find((p) => p.hero?.slug === hero) ?? null : null;
  const sides: boolean[] = me && !me.radiant ? [false, true] : [true, false];
  const m = report.match ?? ({} as CoachReport['match']);
  const winner = typeof m.radiant_win === 'boolean' ? m.radiant_win : null;
  const score = Array.isArray(m.score) ? m.score : null;
  const adv = Array.isArray(report.timeline?.radiant_gold_adv) ? report.timeline!.radiant_gold_adv.filter(num) : [];
  const spikesBySlot = new Map<number, Map<string, number>>();
  for (const s of Array.isArray(report.spikes) ? report.spikes : []) {
    if (!s) continue;
    const at = new Map<string, number>();
    for (const it of s.items ?? []) if (it?.item?.key && !at.has(it.item.key)) at.set(it.item.key, it.time);
    spikesBySlot.set(s.slot, at);
  }
  const showHead = players.some((p) => num(p.net_worth));
  return (
    <section className="ag-board" aria-label={T.scoreboard[lang]}>
      <h2>{T.scoreboard[lang]}</h2>
      {(winner != null || score || num(m.duration)) && (
        <p className="ag-board-head">
          {winner != null && <b className={winner ? 'is-radiant' : 'is-dire'}>{winner ? T.radiant[lang] : T.dire[lang]} {T.won[lang]}</b>}
          {score && <span><span className="is-radiant">{score[0]}</span> : <span className="is-dire">{score[1]}</span></span>}
          {num(m.duration) && <span>{clock(m.duration)}</span>}
          {m.mode?.[lang] && <span>{m.mode[lang]}</span>}
        </p>
      )}
      {adv.length > 2 && <GoldCurve adv={adv} lang={lang} />}
      {sides.map((radiant) => {
        const team = players.filter((p) => p.radiant === radiant);
        if (!team.length) return null;
        const worth = team.reduce((s, p) => s + (num(p.net_worth) ? p.net_worth : 0), 0);
        return (
          <div key={String(radiant)} className={`ag-side ${radiant ? 'is-radiant' : 'is-dire'}`}>
            <h3>
              <span>{radiant ? T.radiant[lang] : T.dire[lang]}{me && me.radiant === radiant ? ` · ${T.yourSide[lang]}` : ''}</span>
              {worth > 0 && <span className="ag-side-worth">{T.teamWorth[lang]} {thousands(worth)}</span>}
            </h3>
            {showHead && (
              <p className="ag-cols" aria-hidden="true">
                <span>{T.hero[lang]}</span><span>{T.kda[lang]}</span><span>{T.lhdn[lang]}</span><span>{T.worth[lang]}</span><span>{T.gpm[lang]}</span><span>{T.dmg[lang]}</span><span>{T.items[lang]}</span>
              </p>
            )}
            <ul>{team.map((p) => <Row key={p.slot} p={p} me={p === me} spikes={spikesBySlot.get(p.slot) ?? new Map()} lang={lang} />)}</ul>
          </div>
        );
      })}
    </section>
  );
};
