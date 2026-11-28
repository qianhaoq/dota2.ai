import React, { useId } from 'react';
import { SafeImg } from '../coach/ui';
import type { CoachReport, Player } from '../coach/types';
import { CrossedSwordsIcon, FactionCrest } from './DotaIcons';

type Lang = 'en' | 'zh' | 'ru';
type Bi = Record<Lang, string>;

const T = {
  scoreboard: { en: 'Scoreboard', zh: '记分板', ru: 'Таблица матча' },
  radiant: { en: 'Radiant', zh: '天辉', ru: 'Силы Света' },
  dire: { en: 'Dire', zh: '夜魇', ru: 'Силы Тьмы' },
  won: { en: 'victory', zh: '胜利', ru: 'победа' },
  you: { en: 'you', zh: '你', ru: 'вы' },
  yourSide: { en: 'your side', zh: '你方', ru: 'ваша команда' },
  teamWorth: { en: 'net worth', zh: '总经济', ru: 'ценность' },
  gold: { en: 'Gold lead by minute', zh: '每分钟经济差', ru: 'Перевес по золоту по минутам' },
  goldUp: { en: 'Radiant ahead', zh: '天辉领先', ru: 'Впереди Силы Света' },
  goldMine: { en: 'Your side ahead', zh: '你方领先', ru: 'Ваша команда впереди' },
  goldTheirs: { en: 'Their side ahead', zh: '对方领先', ru: 'Соперники впереди' },
  theirSide: { en: 'their side', zh: '对方', ru: 'соперники' },
  goldDown: { en: 'Dire ahead', zh: '夜魇领先', ru: 'Впереди Силы Тьмы' },
  goldEnd: { en: 'at the end', zh: '结束时', ru: 'в конце' },
  goldReplay: { en: 'Net worth lead by minute (from the replay)', zh: '每分钟净值差（来自录像）', ru: 'Перевес по нетворсу (из реплея)' },
  goldReplayEarned: { en: 'Gold lead by minute (from the replay)', zh: '每分钟经济差（来自录像）', ru: 'Перевес по золоту (из реплея)' },
  goldNone: { en: 'No minute-by-minute gold for this game yet: it comes with the replay review or with OpenDota\'s parse of the match.', zh: '这局还没有每分钟经济：录像复盘或 OpenDota 解析之后才有。', ru: 'Поминутного графика золота пока нет — он появится после разбора реплея или парсинга OpenDota.' },
  hero: { en: 'Hero', zh: '英雄', ru: 'Герой' },
  level: { en: 'Lvl', zh: '等级', ru: 'Ур.' },
  kda: { en: 'K / D / A', zh: '杀 / 死 / 助', ru: 'У / С / П' },
  lhdn: { en: 'LH / DN', zh: '正补 / 反补', ru: 'Д / О' },
  worth: { en: 'Net worth', zh: '经济', ru: 'Нетворс' },
  gpm: { en: 'GPM', zh: 'GPM', ru: 'GPM' },
  dmg: { en: 'Hero dmg', zh: '英雄伤害', ru: 'Урон' },
  items: { en: 'Items', zh: '出装', ru: 'Предметы' },
  done: { en: 'finished', zh: '成型', ru: 'собран' },
} satisfies Record<string, Bi>;

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clock = (s: number) => `${Math.floor(Math.abs(s) / 60)}:${String(Math.floor(Math.abs(s)) % 60).padStart(2, '0')}`;
const thousands = (n: number) => n.toLocaleString('en-US');
/** 18,681 → "18.7k"; under 1,000 as it is. */
const k = (n: number) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/**
 * The gold lead per minute, drawn as one line around zero.
 *
 * `adv` is Radiant's lead (OpenDota's radiant_gold_adv, or the replay's own). When the review is for a player
 * (`mine`: their side), the curve is told from that side, like every sentence of the review: above the line is
 * "your side ahead", below is "their side ahead", whichever team they were on. The colours stay the teams' own
 * (the same as the scoreboard under it), not "good / bad". With no player it reads Radiant above, Dire below.
 */
const GoldCurve: React.FC<{ adv: number[]; lang: Lang; title?: Bi; mine?: 'radiant' | 'dire' | null }> = ({ adv: radiantAdv, lang, title = T.gold, mine = null }) => {
  const uid = useId();
  // The side drawn above the line, and its lead.
  const up: 'radiant' | 'dire' = mine ?? 'radiant';
  const down: 'radiant' | 'dire' = up === 'radiant' ? 'dire' : 'radiant';
  const adv = up === 'radiant' ? radiantAdv : radiantAdv.map((v) => -v);
  const who = (side: 'radiant' | 'dire') => (mine ? `${(side === mine ? T.yourSide : T.theirSide)[lang]}${lang === 'zh' ? '（' : ' ('}${T[side][lang]}${lang === 'zh' ? '）' : ')'}` : T[side][lang]);
  const ahead = (side: 'radiant' | 'dire') => (mine ? (side === mine ? T.goldMine : T.goldTheirs)[lang] : (side === 'radiant' ? T.goldUp : T.goldDown)[lang]);
  const W = 640; const H = 136; const pad = 6;
  const max = Math.max(2000, ...adv.map((v) => Math.abs(v)));
  const x = (i: number) => pad + (i / Math.max(1, adv.length - 1)) * (W - 2 * pad);
  const y = (v: number) => H / 2 - (v / max) * (H / 2 - pad);
  const line = adv.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${x(0)},${H / 2} ${line} ${x(adv.length - 1)},${H / 2}`;
  const end = adv[adv.length - 1];
  const leader = end >= 0 ? up : down;
  const ticks = adv.map((_, i) => i).filter((i) => i > 0 && i % 10 === 0);
  const upColor = up === 'radiant' ? '#4cd478' : '#e85a4f';
  const downColor = down === 'radiant' ? '#4cd478' : '#e85a4f';
  return (
    <figure className="ag-gold">
      <figcaption>
        <span>{title[lang]}</span>
        <span className="ag-gold-end">{T.goldEnd[lang]} <b className={`is-${leader}`}>{who(leader)} +{thousands(Math.abs(Math.round(end)))}</b></span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`${title[lang]}: ${T.goldEnd[lang]} ${who(leader)} +${thousands(Math.abs(Math.round(end)))}`}>
        <defs>
          <clipPath id="ag-gold-up"><rect x="0" y="0" width={W} height={H / 2} /></clipPath>
          <clipPath id="ag-gold-down"><rect x="0" y={H / 2} width={W} height={H / 2} /></clipPath>
          <linearGradient id={`${uid}-grad-up`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={upColor} stopOpacity="0.4" />
            <stop offset="100%" stopColor={upColor} stopOpacity="0.04" />
          </linearGradient>
          <linearGradient id={`${uid}-grad-down`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={downColor} stopOpacity="0.04" />
            <stop offset="100%" stopColor={downColor} stopOpacity="0.4" />
          </linearGradient>
        </defs>
        {ticks.map((i) => <line key={i} className="ag-gold-tick" x1={x(i)} x2={x(i)} y1={0} y2={H} />)}
        <polygon className={`ag-gold-area is-${up}`} fill={`url(#${uid}-grad-up)`} points={area} clipPath="url(#ag-gold-up)" />
        <polygon className={`ag-gold-area is-${down}`} fill={`url(#${uid}-grad-down)`} points={area} clipPath="url(#ag-gold-down)" />
        <line className="ag-gold-zero" x1={0} x2={W} y1={H / 2} y2={H / 2} />
        <polyline className="ag-gold-line" points={line} />
      </svg>
      <div className="ag-gold-axis" aria-hidden="true">
        <span className={`is-${up}`}>▲ {ahead(up)}</span>
        {/* A minute label under a side label (the first and last eighth of the width) would be cut: only its line is drawn. */}
        <span>{ticks.filter((i) => x(i) / W > 0.14 && x(i) / W < 0.86).map((i) => <i key={i} style={{ left: `${(x(i) / W) * 100}%` }}>{i}:00</i>)}</span>
        <span className={`is-${down}`}>▼ {ahead(down)}</span>
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
  const heroName = p.hero ? (p.hero[lang] ?? p.hero.en) : '';
  return (
    <li className={`${p.radiant ? 'is-radiant' : 'is-dire'}${me ? ' is-me' : ''}`}>
      <span className="ag-row-hero">
        {p.hero?.img ? <SafeImg src={p.hero.img} alt={heroName} className="ag-portrait" /> : <span className="ag-portrait ag-portrait--blank" />}
        <span className="ag-row-name">{heroName}</span>{me && <em>{T.you[lang]}</em>}
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
export const MatchBoard: React.FC<{ report: CoachReport; hero?: string | null; lang: Lang; /** The replay's own lead per minute: used when the match record has no gold curve. */ replayLead?: number[] | null; /** What that lead is: gold earned (summed from the replay's combat log) or net worth (the replay's graph). */ replayLeadIs?: 'gold' | 'net_worth' }> = ({ report, hero = null, lang, replayLead = null, replayLeadIs = 'net_worth' }) => {
  const players = Array.isArray(report.players) ? report.players : [];
  const me = hero ? players.find((p) => p.hero?.slug === hero) ?? null : null;
  const sides: boolean[] = me && !me.radiant ? [false, true] : [true, false];
  const m = report.match ?? ({} as CoachReport['match']);
  const winner = typeof m.radiant_win === 'boolean' ? m.radiant_win : null;
  const score = Array.isArray(m.score) ? m.score : null;
  const recorded = Array.isArray(report.timeline?.radiant_gold_adv) ? report.timeline!.radiant_gold_adv.filter(num) : [];
  // OpenDota's curve when the match record has it (what the review's tools were told); else the replay's own.
  const adv = recorded.length > 2 ? recorded : Array.isArray(replayLead) ? replayLead.filter(num) : [];
  const fromReplay = recorded.length <= 2 && adv.length > 2;
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
          {winner != null && <b className={winner ? 'is-radiant' : 'is-dire'}><FactionCrest side={winner ? 'radiant' : 'dire'} size={15} /> {winner ? T.radiant[lang] : T.dire[lang]} {T.won[lang]}</b>}
          {score && <span className="ag-board-score"><span className="is-radiant">{score[0]}</span> <CrossedSwordsIcon size={12} /> <span className="is-dire">{score[1]}</span></span>}
          {num(m.duration) && <span className="ag-board-pill">{clock(m.duration)}</span>}
          {(m.mode?.[lang] ?? m.mode?.en) && <span className="ag-board-pill">{m.mode?.[lang] ?? m.mode?.en}</span>}
        </p>
      )}
      {adv.length > 2 ? <GoldCurve adv={adv} lang={lang} mine={me ? (me.radiant ? 'radiant' : 'dire') : null} title={fromReplay ? (replayLeadIs === 'gold' ? T.goldReplayEarned : T.goldReplay) : T.gold} /> : showHead && <p className="ag-gold-none">{T.goldNone[lang]}</p>}
      {sides.map((radiant) => {
        const team = players.filter((p) => p.radiant === radiant);
        if (!team.length) return null;
        const worth = team.reduce((s, p) => s + (num(p.net_worth) ? p.net_worth : 0), 0);
        return (
          <div key={String(radiant)} className={`ag-side ${radiant ? 'is-radiant' : 'is-dire'}`}>
            <h3>
              <span className="ag-side-title"><FactionCrest side={radiant ? 'radiant' : 'dire'} size={13} />{radiant ? T.radiant[lang] : T.dire[lang]}{me && me.radiant === radiant ? ` · ${T.yourSide[lang]}` : ''}</span>
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
