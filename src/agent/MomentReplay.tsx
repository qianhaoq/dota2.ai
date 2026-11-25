import React, { useEffect, useId, useRef, useState } from 'react';
import { fetchMoment, type Moment } from './api';

/**
 * A moment of the game, replayed on the map: where the ten heroes stood in the seconds around a game time the
 * review cites, one position a second, as the replay recorded them.
 *
 * It plays when asked for (never on its own) and can be scrubbed. A hero with no sample at a second is not
 * drawn at that second; one outside the square shown is named under it. A mark is where a hero stood: nothing
 * here says who could see whom.
 */

type Lang = 'en' | 'zh';
const T = {
  loading: { en: 'Loading the moment…', zh: '正在取这一刻…' },
  failed: { en: 'This moment could not be loaded.', zh: '这一刻没有取到。' },
  play: { en: 'Play', zh: '播放' },
  pause: { en: 'Pause', zh: '暂停' },
  scrub: { en: 'Game time', zh: '比赛时间' },
  label: { en: 'The map from {a} to {b}', zh: '{a} 到 {b} 的站位' },
  you: { en: 'You', zh: '你' },
  ally: { en: 'Allies', zh: '队友' },
  enemy: { en: 'Enemies', zh: '对手' },
  died: { en: '{h} died', zh: '{h} 阵亡' },
  cast: { en: '{h}: {a}', zh: '{h}：{a}' },
  castOn: { en: '{h}: {a} on {t}', zh: '{h}：{a} → {t}' },
  ult: { en: 'ultimate', zh: '大招' },
  events: { en: 'What happened in these seconds', zh: '这几秒里发生的事' },
  wardMine: { en: 'Your side\'s ward', zh: '你方的眼' },
  wardEnemy: { en: 'Their ward', zh: '对方的眼' },
  observer: { en: 'observer', zh: '假眼' },
  sentry: { en: 'sentry', zh: '真眼' },
  wards: { en: 'Wards', zh: '眼' },
  outside: { en: 'Not in this part of the map: {n}', zh: '不在这块地图里：{n}' },
  unsampled: { en: 'No position in the replay at this second: {n}', zh: '这一秒录像里没有位置：{n}' },
  river: { en: 'river', zh: '河道' },
  wardNote: { en: 'A ward is drawn where it stood. What it let anyone see is not in the replay data.', zh: '眼画在它插的位置。它让谁看到了什么，录像数据里没有。' },
  note: { en: 'One position a second, from the replay. A mark is where a hero stood, not what anyone could see.', zh: '每秒一个位置，来自录像。标记是英雄站的地方，不代表谁能看到谁。' },
} as const;

const S = 320;
/** How long each second of the game stays on screen. */
export const STEP_MS = 350;
const TRAIL = 4;
const clockOf = (t: number) => `${t < 0 ? '-' : ''}${Math.floor(Math.abs(t) / 60)}:${String(Math.abs(t) % 60).padStart(2, '0')}`;
/** The minimap icon of a hero, by the game's own name for it. */
export const heroIcon = (slug: string) => `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/icons/${slug}.png`;
const calm = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const MomentReplay: React.FC<{ matchId: string; hero: string; lang: Lang; t: number }> = ({ matchId, hero, lang, t }) => {
  const [data, setData] = useState<Moment | null>(null);
  const [failed, setFailed] = useState(false);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const clip = useId();
  const say = (b: Record<Lang, string>) => b[lang];

  useEffect(() => {
    let alive = true;
    setData(null); setFailed(false); setPlaying(false);
    fetchMoment(matchId, hero, lang, t).then((m) => {
      if (!alive) return;
      setData(m);
      // Asked for, so it plays from the start — unless the reader has asked for less motion: then it opens on the moment itself.
      const at = Math.max(0, m.frames.findIndex((f) => f.t === m.t));
      if (calm()) setI(at); else { setI(0); setPlaying(m.frames.length > 1); }
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [matchId, hero, lang, t]);

  useEffect(() => {
    if (!playing || !data) return undefined;
    if (i >= data.frames.length - 1) { setPlaying(false); return undefined; }
    const id = setTimeout(() => setI((v) => v + 1), STEP_MS);
    return () => clearTimeout(id);
  }, [playing, i, data]);

  // The list of what happened follows the second shown: the row of that second is brought into its box (the
  // box scrolls, never the page).
  const list = useRef<HTMLOListElement>(null);
  const shown = data ? data.frames[Math.min(i, data.frames.length - 1)].t : null;
  useEffect(() => {
    const box = list.current; const now = box?.querySelector<HTMLElement>('li.is-now');
    if (box && now) box.scrollTop = Math.max(0, now.offsetTop - box.clientHeight / 2);
  }, [shown]);

  if (failed) return <p className="ag-none">{say(T.failed)}</p>;
  if (!data) return <p className="ag-none">{say(T.loading)}</p>;

  const frame = data.frames[Math.min(i, data.frames.length - 1)];
  const { box } = data;
  const px = (x: number) => ((x - box.x) / box.size) * S;
  const py = (y: number) => S - ((y - box.y) / box.size) * S;
  const inside = (p: readonly number[] | null): p is [number, number, 0 | 1] => p != null && p[0] >= box.x && p[0] <= box.x + box.size && p[1] >= box.y && p[1] <= box.y + box.size;
  const N = (k: string) => data.names[k] ?? k;
  const outside = data.heroes.filter((_, k) => frame.at[k] != null && !inside(frame.at[k])).map((h) => N(h.hero));
  // A hero the replay has no position of at this second is not on the map: say so, or the gap reads as "was not there".
  const unsampled = data.heroes.filter((_, k) => frame.at[k] == null).map((h) => N(h.hero));
  // The river runs along x + y = 0: the part of it that crosses the square shown, for bearings.
  const ra = Math.max(box.x, -(box.y + box.size)); const rb = Math.min(box.x + box.size, -box.y);
  // The player is drawn last, so no other mark covers them.
  const order = data.heroes.map((h, k) => ({ h, k })).sort((a, b) => Number(a.h.side === 'me') - Number(b.h.side === 'me'));
  // Where a hero came from: back from this second, only while the replay has them, in the square, at every second.
  // A second without a sample, or one outside the square, ends the trail: joining across it would draw a path nobody recorded.
  const trail = (k: number) => {
    const points: string[] = [];
    for (let j = i; j >= Math.max(0, i - TRAIL); j -= 1) {
      const p = data.frames[j].at[k];
      if (!inside(p)) break;
      points.unshift(`${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`);
    }
    return points.length > 1 ? points.join(' ') : '';
  };
  // Wards standing at the second shown (placed by then — or placed at a time the replay did not record — and not gone yet).
  const wards = (data.wards ?? []).filter((w) => (w.from == null || w.from <= frame.t) && (w.to == null || w.to > frame.t));
  // Casts and deaths in one list, in order: what happened, beside where everyone stood.
  const casts = data.casts ?? [];
  const events = [
    ...casts.map((c) => ({ t: c.t, kind: 'cast' as const, hero: c.hero, text: say(c.target ? T.castOn : T.cast).replace('{h}', N(c.hero)).replace('{a}', N(c.ability)).replace('{t}', c.target ? N(c.target) : ''), ultimate: c.ultimate === true })),
    ...data.deaths.map((d) => ({ t: d.t, kind: 'death' as const, hero: d.hero, text: say(T.died).replace('{h}', N(d.hero)), ultimate: false })),
  ].sort((a, b) => a.t - b.t);
  // Who is casting in the second shown: their mark pulses once.
  const casting = new Set(casts.filter((c) => Math.floor(c.t) === frame.t).map((c) => c.hero));
  const last = data.frames.length - 1;
  const toggle = () => { if (!playing && i >= last) setI(0); setPlaying((v) => !v); };

  return (
    <figure className="ag-replay">
      <svg viewBox={`0 0 ${S} ${S}`} role="img" aria-label={say(T.label).replace('{a}', clockOf(data.from)).replace('{b}', clockOf(data.to))}>
        <defs><clipPath id={clip}><circle r="8" /></clipPath></defs>
        <rect x="0" y="0" width={S} height={S} rx="8" className="ag-replay-bg" />
        <path className="ag-replay-grid" d={[1, 2, 3].map((n) => `M0 ${(S / 4) * n}H${S}M${(S / 4) * n} 0V${S}`).join('')} />
        {rb > ra && <line className="ag-replay-river" x1={px(ra)} y1={py(-ra)} x2={px(rb)} y2={py(-rb)}><title>{say(T.river)}</title></line>}
        {wards.map((w) => (
          <g key={`w${w.x},${w.y},${w.kind}`} className={`ag-replay-ward is-${w.side} is-${w.kind}`} transform={`translate(${px(w.x).toFixed(1)} ${py(w.y).toFixed(1)})`}>
            <title>{`${say(w.side === 'mine' ? T.wardMine : T.wardEnemy)} · ${say(T[w.kind])}`}</title>
            {w.kind === 'observer' ? <path d="M0 -5L5 0L0 5L-5 0Z" /> : <rect x="-3.5" y="-3.5" width="7" height="7" />}
          </g>
        ))}
        {data.heroes.map((h, k) => { const points = trail(k); return points ? <polyline key={`t${h.hero}`} className={`ag-replay-trail is-${h.side}`} points={points} /> : null; })}
        {order.map(({ h, k }) => {
          const p = frame.at[k];
          if (!inside(p)) return null;
          const slug = data.icons[h.hero];
          return (
            <g key={h.hero} className={`ag-replay-hero is-${h.side} ${p[2] === 0 ? 'is-dead' : ''}${casting.has(h.hero) ? ' is-casting' : ''}`} transform={`translate(${px(p[0]).toFixed(1)} ${py(p[1]).toFixed(1)})`}>
              <title>{N(h.hero)}</title>
              <circle r={h.side === 'me' ? 12 : 10} className="ag-replay-ring" />
              {slug && <image href={heroIcon(slug)} x="-8" y="-8" width="16" height="16" clipPath={`url(#${clip})`} preserveAspectRatio="xMidYMid slice" />}
              {h.side === 'me' && <text y="25" textAnchor="middle">{say(T.you)}</text>}
            </g>
          );
        })}
      </svg>
      <div className="ag-replay-controls">
        <button type="button" className="ag-replay-play" aria-label={say(playing ? T.pause : T.play)} onClick={toggle}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">{playing ? <path d="M6 4h4v16H6zM14 4h4v16h-4z" /> : <path d="M7 4l13 8-13 8z" />}</svg>
        </button>
        <input type="range" min={0} max={last} step={1} value={i} aria-label={say(T.scrub)} aria-valuetext={clockOf(frame.t)} onChange={(e) => { setPlaying(false); setI(Number(e.target.value)); }} />
        <output className={frame.t === data.t ? 'is-moment' : ''}>{clockOf(frame.t)}</output>
      </div>
      {data.place_name && <p className="ag-replay-place">{clockOf(data.t)} · {data.place_name}</p>}
      <ul className="ag-replay-legend">
        <li className="is-me">{say(T.you)}</li><li className="is-ally">{say(T.ally)}</li><li className="is-enemy">{say(T.enemy)}</li>
        {(data.wards ?? []).length > 0 && <li className="is-ward">{say(T.wards)}: ◆ {say(T.observer)} · ■ {say(T.sentry)}</li>}
      </ul>
      {/* The list scrolls inside its box, so a keyboard has to be able to reach it (tabIndex) and scroll it. */}
      {events.length > 0 && (
        <ol className="ag-replay-deaths" aria-label={say(T.events)} ref={list} tabIndex={0}>
          {events.map((e, n) => (
            <li key={`${e.t}${e.hero}${e.kind}${n}`} className={`is-${e.kind}${e.t <= frame.t + 1 ? ' is-past' : ''}${Math.floor(e.t) === frame.t ? ' is-now' : ''}${e.ultimate ? ' is-ultimate' : ''}`}>
              <time>{clockOf(Math.floor(e.t))}</time> {e.text}{e.ultimate && <span className="ag-replay-ult"> · {say(T.ult)}</span>}
            </li>
          ))}
        </ol>
      )}
      {outside.length > 0 && <p className="ag-replay-outside">{say(T.outside).replace('{n}', outside.join(lang === 'zh' ? '、' : ', '))}</p>}
      {unsampled.length > 0 && <p className="ag-replay-outside">{say(T.unsampled).replace('{n}', unsampled.join(lang === 'zh' ? '、' : ', '))}</p>}
      <figcaption>{say(T.note)}{(data.wards ?? []).length > 0 ? ` ${say(T.wardNote)}` : ''}</figcaption>
    </figure>
  );
};
