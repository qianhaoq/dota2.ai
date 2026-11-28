import React, { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { MAP_BOUNDS } from '../../lib/agent/mapBounds.js';
import { trackEvent } from '../services/analytics';
import { fetchTrack, type AgentHero, type HeroTrack, type TrackDeath } from './api';
import { MomentReplay, heroIcon } from './MomentReplay';
import { MapRouteIcon } from './DotaIcons';

/**
 * Interactive Hero Movement Path & Activity Heatmap over a parsed replay trace (zero model calls).
 *
 * Uses the exact same world bounds and projection (`MAP_BOUNDS`: -8600..+8600, Radiant bottom-left,
 * Dire top-right, river along x + y = 0) as `MomentReplay` and `MiniMap`. Draws ONLY real 1 Hz
 * sampled alive positions: deaths, teleports, and missing samples always break the path, and any
 * missing-sample seconds are explicitly disclosed rather than interpolated.
 */

type Lang = 'en' | 'zh' | 'ru';
type Mode = 'path' | 'heat';
type PresetId = 'full' | '0-10' | '10-20' | '20-30' | '30+' | 'custom';

interface WindowSpec {
  preset: PresetId;
  from: number | null;
  to: number | null;
}

const T = {
  title: { en: 'Movement path & activity heatmap', zh: '移动路径与活动热区', ru: 'Маршрут и тепловая карта активности' },
  subtitle: { en: 'Replay positions by time window · instant', zh: '按时间段查看录像站位 · 即开即看', ru: 'Позиции из реплея по отрезкам · мгновенно' },
  heroLabel: { en: 'Hero', zh: '选择英雄', ru: 'Герой' },
  heroQuickSwitch: { en: 'Quick switch hero', zh: '快捷切换英雄', ru: 'Быстрый выбор героя' },
  modeGroup: { en: 'Map view mode', zh: '视图模式', ru: 'Режим карты' },
  modePath: { en: 'Path', zh: '移动路径', ru: 'Маршрут' },
  modeHeat: { en: 'Heatmap', zh: '活动热区', ru: 'Тепловая карта' },
  windowGroup: { en: 'Time window presets', zh: '时间段快捷选择', ru: 'Быстрый выбор отрезка' },
  fullGame: { en: 'Full game', zh: '整局', ru: 'Весь матч' },
  m0_10: { en: '0–10m', zh: '0–10 分', ru: '0–10 мин' },
  m10_20: { en: '10–20m', zh: '10–20 分', ru: '10–20 мин' },
  m20_30: { en: '20–30m', zh: '20–30 分', ru: '20–30 мин' },
  m30p: { en: '30m+', zh: '30 分+', ru: '30+ мин' },
  fromMin: { en: 'From (min)', zh: '起始(分)', ru: 'От (мин)' },
  toMin: { en: 'To (min)', zh: '结束(分)', ru: 'До (мин)' },
  apply: { en: 'Apply', zh: '应用', ru: 'Применить' },
  invalidRange: { en: 'Start minute must be before or equal to end minute.', zh: '起始分钟不能大于结束分钟。', ru: 'Начальная минута не может быть больше конечной.' },
  loading: { en: 'Loading movement data…', zh: '正在读取移动轨迹…', ru: 'Загрузка маршрута…' },
  failed: { en: 'Could not load movement data for this window.', zh: '该时段的位置数据没有取到。', ru: 'Не удалось загрузить данные за этот отрезок.' },
  mapLabel: { en: '{hero} {mode} from {a} to {b}', zh: '{hero} {a} 到 {b} 的{mode}', ru: '{hero}: {mode} с {a} по {b}' },
  radiant: { en: 'Radiant', zh: '天辉', ru: 'Свет' },
  dire: { en: 'Dire', zh: '夜魇', ru: 'Тьма' },
  river: { en: 'River', zh: '河道', ru: 'Река' },
  you: { en: 'You', zh: '你', ru: 'Вы' },
  ally: { en: 'Ally', zh: '队友', ru: 'Союзник' },
  enemy: { en: 'Enemy', zh: '对手', ru: 'Враг' },
  statWindow: { en: 'Window', zh: '时段', ru: 'Отрезок' },
  statAlive: { en: 'Alive sampled', zh: '存活采样', ru: 'Жив (записей)' },
  statDead: { en: 'Dead', zh: '阵亡时长', ru: 'Мёртв' },
  statMissing: { en: 'Missing', zh: '缺失采样', ru: 'Пропуски' },
  gapNotice: {
    en: '{n} s of position samples missing in this stretch — gaps are left blank and never interpolated.',
    zh: '该时段有 {n} 秒缺少位置采样，断档处已留空，不做插值补全。',
    ru: 'За этот отрезок отсутствует {n} с данных о позиции — пропуски оставлены пустыми без интерполяции.',
  },
  noAlive: {
    en: 'No alive position samples recorded in this time window.',
    zh: '该时段内没有存活状态的位置采样。',
    ru: 'В этом отрезке нет записей позиции живого героя.',
  },
  legendStart: { en: 'Start', zh: '起点', ru: 'Начало' },
  legendEnd: { en: 'End', zh: '终点', ru: 'Конец' },
  legendJump: { en: 'TP / jump', zh: '传送 / 跳点', ru: 'ТП / скачок' },
  legendGap: { en: 'Missing gap', zh: '采样断档', ru: 'Пропуск' },
  legendHeatLow: { en: 'Less time', zh: '停留较少', ru: 'Меньше времени' },
  legendHeatHigh: { en: 'More time (peak {n}s)', zh: '停留集中（峰值 {n} 秒）', ru: 'Больше времени (пик {n} с)' },
  legendDeath: { en: 'Death (click to replay)', zh: '阵亡点（点击回放）', ru: 'Смерть (нажмите для повтора)' },
  deathsHeading: { en: 'Deaths in this window (click to replay on map)', zh: '该时段阵亡时刻（点击跳转地图回放）', ru: 'Смерти за отрезок (нажмите для повтора на карте)' },
  noDeaths: { en: 'No deaths in this window.', zh: '该时段没有阵亡。', ru: 'Смертей за этот отрезок нет.' },
  deathAria: { en: 'Death at {clock} — replay on map', zh: '{clock} 阵亡 — 点击地图回放', ru: 'Смерть на {clock} — повтор на карте' },
  deathBy: { en: 'by {k}', zh: '击杀：{k}', ru: 'убил {k}' },
  deathNoPos: { en: 'no map position', zh: '缺少坐标', ru: 'нет позиции' },
  segmentTip: { en: '{a}–{b} · Click to replay around {m}', zh: '{a}–{b} · 点击重放 {m} 附近', ru: '{a}–{b} · Повтор около {m}' },
  jumpTip: { en: 'Teleport / jump ({a} → {b})', zh: '传送 / 瞬移跳点（{a} → {b}）', ru: 'Телепорт / скачок ({a} → {b})' },
  gapTip: { en: 'Position samples missing ({a}–{b})', zh: '位置采样缺失（{a}–{b}）', ru: 'Нет данных о позиции ({a}–{b})' },
  replayHead: { en: 'Moment replay · {clock}', zh: '时刻回放 · {clock}', ru: 'Повтор момента · {clock}' },
  closeReplay: { en: 'Close replay', zh: '收起回放', ru: 'Скрыть повтор' },
  caption: {
    en: 'Real 1 Hz replay positions only. Gaps from deaths, teleports, or missing samples are never interpolated. Does not show fog of war or vision.',
    zh: '仅绘制录像中的真实每秒位置采样；阵亡、传送或采样缺失造成的断档不做插值补全，也不代表战争迷雾或视野。',
    ru: 'Только реальные ежесекундные позиции из реплея. Пробелы от смертей, телепортов и пропусков не интерполируются; туман войны и обзор не показаны.',
  },
} as const;

const S = 360;
const MAX_ARROWS = 36;
const ARROW_SPACING_PX = 38;

const clockOf = (sec: number) => {
  const s = Math.abs(Math.trunc(sec));
  return `${sec < 0 ? '-' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const formatDur = (sec: number, lang: Lang) => {
  if (sec < 60) return lang === 'zh' ? `${sec} 秒` : lang === 'ru' ? `${sec} с` : `${sec}s`;
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  if (lang === 'zh') return r ? `${m} 分 ${r} 秒` : `${m} 分`;
  if (lang === 'ru') return r ? `${m} м ${r} с` : `${m} м`;
  return r ? `${m}m ${r}s` : `${m}m`;
};

/** Smooth cyan → gold → coral progression along the selected window [0..1]. */
function timeColor(ratio: number): string {
  const r = Math.min(1, Math.max(0, ratio));
  const [c0, c1, k] = r < 0.5
    ? [[79, 195, 247], [229, 174, 78], r * 2]
    : [[229, 174, 78], [240, 106, 84], (r - 0.5) * 2];
  const mix = (a: number, b: number) => Math.round(a + (b - a) * k);
  return `rgb(${mix(c0[0], c1[0])}, ${mix(c0[1], c1[1])}, ${mix(c0[2], c1[2])})`;
}

/** Perceptual warm heatmap color for normalized intensity in (0..1]. */
function heatColor(ratio: number): { fill: string; opacity: number } {
  const t = Math.sqrt(Math.min(1, Math.max(0, ratio)));
  const [c0, c1, k] = t < 0.55
    ? [[217, 160, 62], [239, 128, 56], t / 0.55]
    : [[239, 128, 56], [235, 68, 52], (t - 0.55) / 0.45];
  const mix = (a: number, b: number) => Math.round(a + (b - a) * k);
  return {
    fill: `rgb(${mix(c0[0], c1[0])}, ${mix(c0[1], c1[1])}, ${mix(c0[2], c1[2])})`,
    opacity: Number((0.22 + t * 0.68).toFixed(2)),
  };
}

export type TrackMode = Mode;
export type TrackPresetId = PresetId;

export interface HeroTrackMapHandle {
  /** Open the tactical map, switch to a time preset (and optional path/heat mode), and scroll into view. */
  focusWindow: (preset: PresetId, nextMode?: Mode) => void;
}

export interface HeroTrackMapProps {
  matchId: string;
  /** Default hero (the reviewed player's hero). */
  hero: string;
  lang: Lang;
  /** Optional match roster (used for hero selector before track data returns). */
  heroes?: AgentHero[];
  /** Optional callback fired when the user clicks a death or path point to jump to MomentReplay. */
  onPlayMoment?: (t: number, heroKey: string) => void;
  /** Render inside a collapsible `<details>` disclosure (recommended on the match page). */
  collapsible?: boolean;
  /** Initial open state when `collapsible` is true (default false — loads on demand). */
  defaultOpen?: boolean;
  /** Optional anchor id for sticky navigation jumps. */
  anchorId?: string;
}

interface PathChunk {
  key: string;
  points: string;
  color: string;
  fromT: number;
  toT: number;
  midT: number;
}

interface PathArrow {
  key: string;
  x: number;
  y: number;
  angle: number;
  color: string;
}

export const HeroTrackMap = forwardRef<HeroTrackMapHandle, HeroTrackMapProps>(({
  matchId,
  hero,
  lang,
  heroes: rosterHeroes,
  onPlayMoment,
  collapsible = false,
  defaultOpen = false,
  anchorId,
}, ref) => {
  const t = (b: Record<Lang, string>) => b[lang];
  const uid = useId();
  const rootRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(!collapsible || defaultOpen);
  const [activeHero, setActiveHero] = useState(hero);
  const [mode, setMode] = useState<Mode>('path');
  const [win, setWin] = useState<WindowSpec>({ preset: 'full', from: null, to: null });
  const [startMinInput, setStartMinInput] = useState('0');
  const [endMinInput, setEndMinInput] = useState('45');
  const [rangeError, setRangeError] = useState(false);
  const [data, setData] = useState<HeroTrack | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [knownDuration, setKnownDuration] = useState<number | null>(null);
  const [knownHeroes, setKnownHeroes] = useState<HeroTrack['heroes'] | null>(null);
  const [selectedMoment, setSelectedMoment] = useState<{ hero: string; t: number; clock: string } | null>(null);

  // Sync when the reviewed match/hero changes.
  useEffect(() => {
    setActiveHero(hero);
    setSelectedMoment(null);
    setWin({ preset: 'full', from: null, to: null });
    setKnownDuration(null);
    setKnownHeroes(null);
    setData(null);
    setFailed(false);
  }, [matchId, hero]);

  // Reset cached localized hero labels when UI language changes so the selector updates cleanly.
  useEffect(() => {
    setKnownHeroes(null);
  }, [lang]);

  // Fetch track data whenever open & selection changes. Clear previous payload immediately so stale
  // maps/death markers are never interactive while loading or if the new request fails.
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setData(null);
    setSelectedMoment(null);
    setLoading(true);
    setFailed(false);
    fetchTrack(matchId, activeHero, lang, { from: win.from, to: win.to, viewer: hero })
      .then((res) => {
        if (!alive) return;
        setData(res);
        setKnownHeroes(res.heroes);
        setLoading(false);
        setKnownDuration(res.duration);
        setStartMinInput(String(Math.max(0, Math.floor(res.from / 60))));
        setEndMinInput(String(Math.max(0, Math.ceil(res.to / 60))));
      })
      .catch(() => {
        if (!alive) return;
        setLoading(false);
        setFailed(true);
      });
    return () => { alive = false; };
  }, [open, matchId, activeHero, hero, lang, win.from, win.to]);

  const duration = data?.duration ?? knownDuration ?? 2400;
  const maxMinute = Math.max(1, Math.ceil(duration / 60));

  const presets = useMemo(() => {
    const list: { id: PresetId; label: string; from: number | null; to: number | null }[] = [
      { id: 'full', label: t(T.fullGame), from: null, to: null },
      { id: '0-10', label: t(T.m0_10), from: 0, to: Math.min(600, duration) },
    ];
    if (duration > 600) list.push({ id: '10-20', label: t(T.m10_20), from: 600, to: Math.min(1200, duration) });
    if (duration > 1200) list.push({ id: '20-30', label: t(T.m20_30), from: 1200, to: Math.min(1800, duration) });
    if (duration > 1800) list.push({ id: '30+', label: t(T.m30p), from: 1800, to: duration });
    return list;
  }, [duration, lang]);

  const heroOptions = useMemo(() => {
    const source = data?.heroes?.length ? data.heroes : knownHeroes;
    if (source?.length) {
      return source.map((h) => ({
        key: h.hero,
        label: h.hero_name,
        side: h.side,
      }));
    }
    if (rosterHeroes?.length) {
      const meTeam = rosterHeroes.find((h) => h.hero === hero)?.team ?? null;
      return rosterHeroes.map((h) => ({
        key: h.hero,
        label: h[lang] ?? h.en,
        side: (h.hero === hero ? 'me' : meTeam && h.team === meTeam ? 'ally' : 'enemy') as 'me' | 'ally' | 'enemy',
      }));
    }
    return [{ key: activeHero, label: activeHero, side: 'me' as const }];
  }, [data, knownHeroes, rosterHeroes, hero, activeHero, lang]);

  const bounds = data?.heat?.bounds ?? MAP_BOUNDS;
  const px = (x: number) => ((x - bounds.min_x) / bounds.size) * S;
  const py = (y: number) => S - ((y - bounds.min_y) / bounds.size) * S;

  const pathGeometry = useMemo(() => {
    if (!data) return { chunks: [] as PathChunk[], singles: [] as { key: string; t: number; x: number; y: number; color: string }[], arrows: [] as PathArrow[], firstPt: null as [number, number, number] | null, lastPt: null as [number, number, number] | null };
    const b = data.heat?.bounds ?? MAP_BOUNDS;
    const toX = (x: number) => ((x - b.min_x) / b.size) * S;
    const toY = (y: number) => S - ((y - b.min_y) / b.size) * S;
    const span = Math.max(1, data.to - data.from);
    const chunkSec = Math.max(10, Math.ceil(span / 28));
    const chunks: PathChunk[] = [];
    const singles: { key: string; t: number; x: number; y: number; color: string }[] = [];
    const arrows: PathArrow[] = [];
    let firstPt: [number, number, number] | null = null;
    let lastPt: [number, number, number] | null = null;

    data.segments.forEach((seg, si) => {
      if (!seg.points.length) return;
      if (!firstPt) firstPt = seg.points[0];
      lastPt = seg.points[seg.points.length - 1];
      if (seg.points.length === 1) {
        const [ptT, ptX, ptY] = seg.points[0];
        singles.push({
          key: `s-${si}-${ptT}`,
          t: ptT,
          x: toX(ptX),
          y: toY(ptY),
          color: timeColor((ptT - data.from) / span),
        });
        return;
      }

      let accDist = ARROW_SPACING_PX * 0.6;
      for (let i = 1; i < seg.points.length && arrows.length < MAX_ARROWS; i += 1) {
        const [t1, x1, y1] = seg.points[i - 1];
        const [t2, x2, y2] = seg.points[i];
        const p1x = toX(x1); const p1y = toY(y1);
        const p2x = toX(x2); const p2y = toY(y2);
        const d = Math.hypot(p2x - p1x, p2y - p1y);
        accDist += d;
        if (accDist >= ARROW_SPACING_PX) {
          const back = seg.points[Math.max(0, i - 3)];
          const vx = p2x - toX(back[1]);
          const vy = p2y - toY(back[2]);
          if (Math.hypot(vx, vy) >= 5) {
            arrows.push({
              key: `a-${si}-${t2}`,
              x: p2x,
              y: p2y,
              angle: (Math.atan2(vy, vx) * 180) / Math.PI,
              color: timeColor(((t1 + t2) / 2 - data.from) / span),
            });
            accDist = 0;
          }
        }
      }

      let cur: [number, number, number][] = [seg.points[0]];
      let chunkStart = seg.points[0][0];
      for (let i = 1; i < seg.points.length; i += 1) {
        const pt = seg.points[i];
        cur.push(pt);
        const isLast = i === seg.points.length - 1;
        if (pt[0] - chunkStart >= chunkSec || isLast) {
          const midPt = cur[Math.floor(cur.length / 2)];
          chunks.push({
            key: `c-${si}-${chunkStart}-${pt[0]}`,
            points: cur.map(([, x, y]) => `${toX(x).toFixed(1)},${toY(y).toFixed(1)}`).join(' '),
            color: timeColor((midPt[0] - data.from) / span),
            fromT: cur[0][0],
            toT: pt[0],
            midT: midPt[0],
          });
          cur = [pt];
          chunkStart = pt[0];
        }
      }
    });

    return { chunks, singles, arrows, firstPt, lastPt };
  }, [data]);

  const jumpToMoment = (sec: number, targetHero?: string) => {
    const momentHero = targetHero ?? data?.hero;
    if (!momentHero) return;
    const rounded = Math.round(sec);
    if (selectedMoment && selectedMoment.t === rounded && selectedMoment.hero === momentHero) {
      setSelectedMoment(null);
      return;
    }
    trackEvent('moment_played', { matchId, lang, hero: momentHero });
    onPlayMoment?.(rounded, momentHero);
    setSelectedMoment({ hero: momentHero, t: rounded, clock: clockOf(rounded) });
  };

  const handlePreset = (p: { id: PresetId; from: number | null; to: number | null }) => {
    setRangeError(false);
    setSelectedMoment(null);
    setWin({ preset: p.id, from: p.from, to: p.to });
  };

  useImperativeHandle(ref, () => ({
    focusWindow: (preset, nextMode) => {
      setOpen(true);
      setRangeError(false);
      setSelectedMoment(null);
      if (nextMode) setMode(nextMode);
      const spec: Record<PresetId, { from: number | null; to: number | null }> = {
        full: { from: null, to: null },
        '0-10': { from: 0, to: 600 },
        '10-20': { from: 600, to: 1200 },
        '20-30': { from: 1200, to: 1800 },
        '30+': { from: 1800, to: Math.max(2400, duration) },
        custom: { from: null, to: null },
      };
      const chosen = spec[preset] ?? spec.full;
      setWin({ preset, from: chosen.from, to: chosen.to });
      requestAnimationFrame(() => {
        rootRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      });
    },
  }), [duration]);

  const handleCustomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const a = Number(startMinInput);
    const b = Number(endMinInput);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0 || a > b) {
      setRangeError(true);
      return;
    }
    setRangeError(false);
    setSelectedMoment(null);
    const clampedFrom = Math.min(duration, Math.floor(a * 60));
    const clampedTo = Math.min(duration, Math.max(clampedFrom, Math.floor(b * 60)));
    setWin({ preset: 'custom', from: clampedFrom, to: clampedTo });
  };

  const heroSelectId = `${uid}-hero`;
  const fromInputId = `${uid}-from`;
  const toInputId = `${uid}-to`;
  const clipEndId = `${uid}-end`;

  const sideTag = (side: 'me' | 'ally' | 'enemy') => t(side === 'me' ? T.you : side === 'ally' ? T.ally : T.enemy);

  const renderDeathMarker = (d: TrackDeath, i: number, payloadHero: string) => {
    if (d.x == null || d.y == null) return null;
    const isActive = selectedMoment?.t === Math.round(d.t) && selectedMoment?.hero === payloadHero;
    const label = t(T.deathAria).replace('{clock}', d.clock);
    const activate = () => jumpToMoment(d.t, payloadHero);
    return (
      <g
        key={`d-${d.t}-${i}`}
        className={`ag-track-death${isActive ? ' is-active' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={label}
        transform={`translate(${px(d.x).toFixed(1)} ${py(d.y).toFixed(1)})`}
        onClick={activate}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
          }
        }}
      >
        <title>{`${d.clock}${d.killer ? ` · ${t(T.deathBy).replace('{k}', data?.names[d.killer] ?? d.killer)}` : ''}${d.place_name ? ` · ${d.place_name}` : ''}`}</title>
        <circle r="8.5" className="ag-track-death-bg" />
        <path d="M-3.5 -3.5L3.5 3.5M3.5 -3.5L-3.5 3.5" className="ag-track-death-x" />
      </g>
    );
  };

  const content = (
    <div className="ag-track-body">
      <div className="ag-track-toolbar">
        <div className="ag-track-hero-pick">
          <label htmlFor={heroSelectId}>{t(T.heroLabel)}</label>
          <select
            id={heroSelectId}
            aria-label={t(T.heroLabel)}
            value={activeHero}
            onChange={(e) => {
              const nextHero = e.target.value;
              setActiveHero(nextHero);
              if (nextHero !== activeHero) {
                setData(null);
                setSelectedMoment(null);
              }
            }}
          >
            {heroOptions.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {opt.label} ({sideTag(opt.side)})
              </option>
            ))}
          </select>
        </div>
        <div className="ag-track-modes" role="group" aria-label={t(T.modeGroup)}>
          <button
            type="button"
            className={`ag-chip-btn${mode === 'path' ? ' is-on' : ''}`}
            aria-pressed={mode === 'path'}
            onClick={() => setMode('path')}
          >
            {t(T.modePath)}
          </button>
          <button
            type="button"
            className={`ag-chip-btn${mode === 'heat' ? ' is-on' : ''}`}
            aria-pressed={mode === 'heat'}
            onClick={() => setMode('heat')}
          >
            {t(T.modeHeat)}
          </button>
        </div>
      </div>

      {heroOptions.length > 1 && (
        <div className="ag-track-avatars" role="group" aria-label={t(T.heroQuickSwitch)}>
          {heroOptions.map((opt) => {
            const slug = data?.icons?.[opt.key];
            const active = opt.key === activeHero;
            return (
              <button
                key={`av-${opt.key}`}
                type="button"
                className={`ag-track-av is-${opt.side}${active ? ' is-on' : ''}`}
                aria-pressed={active}
                title={`${opt.label} (${sideTag(opt.side)})`}
                onClick={() => {
                  if (opt.key === activeHero) return;
                  setActiveHero(opt.key);
                  setData(null);
                  setSelectedMoment(null);
                }}
              >
                {slug
                  ? <img src={heroIcon(slug)} alt="" className="ag-track-av-icon" loading="lazy" />
                  : <span className="ag-track-av-dot" aria-hidden="true" />}
                <span className="ag-track-av-name">{opt.label}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="ag-track-timebar">
        <div className="ag-track-presets" role="group" aria-label={t(T.windowGroup)}>
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`ag-chip-btn${win.preset === p.id ? ' is-on' : ''}`}
              aria-pressed={win.preset === p.id}
              onClick={() => handlePreset(p)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <form className="ag-track-range" onSubmit={handleCustomSubmit}>
          <label htmlFor={fromInputId}>
            <span>{t(T.fromMin)}</span>
            <input
              id={fromInputId}
              type="number"
              min={0}
              max={maxMinute}
              step={1}
              value={startMinInput}
              onChange={(e) => { setStartMinInput(e.target.value); setRangeError(false); }}
            />
          </label>
          <label htmlFor={toInputId}>
            <span>{t(T.toMin)}</span>
            <input
              id={toInputId}
              type="number"
              min={0}
              max={maxMinute}
              step={1}
              value={endMinInput}
              onChange={(e) => { setEndMinInput(e.target.value); setRangeError(false); }}
            />
          </label>
          <button type="submit" className="ag-btn ag-track-apply">{t(T.apply)}</button>
        </form>
      </div>
      {rangeError && <p className="ag-warn" role="alert">{t(T.invalidRange)}</p>}

      {loading && !data && <p className="ag-none" role="status">{t(T.loading)}</p>}
      {failed && !loading && <p className="ag-warn" role="alert">{t(T.failed)}</p>}

      {data && (
        <>
          <div className="ag-track-stage">
            <figure className="ag-track-map">
              <svg
                viewBox={`0 0 ${S} ${S}`}
                role="group"
                aria-label={t(T.mapLabel)
                  .replace('{hero}', data.hero_name)
                  .replace('{mode}', t(mode === 'path' ? T.modePath : T.modeHeat))
                  .replace('{a}', clockOf(data.from))
                  .replace('{b}', clockOf(data.to))}
              >
                <defs>
                  <clipPath id={clipEndId}><circle r="9" /></clipPath>
                  <linearGradient id={`${uid}-river`} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#5eb8e8" stopOpacity="0.1" />
                    <stop offset="50%" stopColor="#5eb8e8" stopOpacity="0.28" />
                    <stop offset="100%" stopColor="#5eb8e8" stopOpacity="0.1" />
                  </linearGradient>
                </defs>
                {/* Authentic Dota 2 tactical minimap geometry (exact MAP_BOUNDS -8600..+8600 projection, zero vision/fog claims) */}
                <rect x="0" y="0" width={S} height={S} rx="10" className="ag-replay-bg" />
                {/* Subtle quadrant grid & terrain elevation terraces */}
                <path className="ag-replay-grid" d={[1, 2, 3].map((n) => `M0 ${(S / 4) * n}H${S}M${(S / 4) * n} 0V${S}`).join('')} />
                <path className="ag-track-terrain" d={`M 14 ${S - 118} Q 96 ${S - 110} 118 ${S - 14} M ${S - 14} 118 Q ${S - 96} 110 ${S - 118} 14`} />
                {/* Top, Mid, Bot lane corridors */}
                <path
                  className="ag-track-lanes"
                  d={`M 34 ${S - 34} L 34 34 L ${S - 34} 34 M 34 ${S - 34} L ${S - 34} 34 M 34 ${S - 34} L ${S - 34} ${S - 34} L ${S - 34} 34`}
                />
                {/* Curved diagonal River along x + y = 0 */}
                <path className="ag-track-river-bank" d={`M 6 6 Q ${S * 0.44} ${S * 0.56} ${S - 6} ${S - 6}`} />
                <line className="ag-track-river" stroke={`url(#${uid}-river)`} x1="4" y1="4" x2={S - 4} y2={S - 4}><title>{t(T.river)}</title></line>
                {/* Dual Roshan Pits (7.33+ NW & SE corners) & Twin Gate markers */}
                <g className="ag-track-landmark" aria-hidden="true">
                  <circle cx="58" cy="54" r="7.5" className="ag-track-pit" />
                  <circle cx={S - 58} cy={S - 54} r="7.5" className="ag-track-pit" />
                  <circle cx="24" cy="24" r="4" className="ag-track-gate" />
                  <circle cx={S - 24} cy={S - 24} r="4" className="ag-track-gate" />
                </g>
                {/* Subtle lane tower reference dots (Radiant bottom-left, Dire top-right) */}
                <g className="ag-track-towers is-radiant" aria-hidden="true">
                  <circle cx="34" cy={S - 110} r="2.2" />
                  <circle cx="34" cy={S - 185} r="2.2" />
                  <circle cx="104" cy={S - 104} r="2.2" />
                  <circle cx="144" cy={S - 144} r="2.2" />
                  <circle cx="118" cy={S - 34} r="2.2" />
                  <circle cx="235" cy={S - 34} r="2.2" />
                </g>
                <g className="ag-track-towers is-dire" aria-hidden="true">
                  <circle cx={S - 118} cy="34" r="2.2" />
                  <circle cx={S - 235} cy="34" r="2.2" />
                  <circle cx={S - 104} cy="104" r="2.2" />
                  <circle cx={S - 144} cy="144" r="2.2" />
                  <circle cx={S - 34} cy="110" r="2.2" />
                  <circle cx={S - 34} cy="185" r="2.2" />
                </g>
                {/* Radiant (bottom-left) & Dire (top-right) bases + Ancient diamond crests */}
                <rect x="6" y={S - 54} width="48" height="48" rx="8" className="ag-map-base is-radiant"><title>{t(T.radiant)}</title></rect>
                <polygon points={`24,${S - 40} 32,${S - 32} 24,${S - 24} 16,${S - 32}`} className="ag-track-ancient is-radiant" aria-hidden="true" />
                <rect x={S - 54} y="6" width="48" height="48" rx="8" className="ag-map-base is-dire"><title>{t(T.dire)}</title></rect>
                <polygon points={`${S - 24},24 ${S - 16},32 ${S - 24},40 ${S - 32},32`} className="ag-track-ancient is-dire" aria-hidden="true" />
                <text x="12" y={S - 11} className="ag-track-corner is-radiant">{t(T.radiant)}</text>
                <text x={S - 12} y="19" textAnchor="end" className="ag-track-corner is-dire">{t(T.dire)}</text>

                {/* HEATMAP LAYER */}
                {mode === 'heat' && data.heat.cells.map((cell) => {
                  const cellSize = S / data.heat.grid_size;
                  const x = (cell.gx / data.heat.grid_size) * S;
                  const y = S - ((cell.gy + 1) / data.heat.grid_size) * S;
                  const { fill, opacity } = heatColor(cell.seconds / Math.max(1, data.heat.max_seconds));
                  return (
                    <rect
                      key={`h-${cell.gx}-${cell.gy}`}
                      className="ag-track-cell"
                      x={x.toFixed(1)}
                      y={y.toFixed(1)}
                      width={cellSize.toFixed(2)}
                      height={cellSize.toFixed(2)}
                      rx="2"
                      fill={fill}
                      fillOpacity={opacity}
                    >
                      <title>{formatDur(cell.seconds, lang)}</title>
                    </rect>
                  );
                })}

                {/* PATH LAYER */}
                {mode === 'path' && (
                  <>
                    {/* Verified teleport / Twin Gate jumps between consecutive alive samples */}
                    {data.breaks.filter((b) => b.reason === 'teleport').map((b, i) => (
                      <line
                        key={`j-${b.from_t}-${i}`}
                        className="ag-track-jump"
                        x1={px(b.from_x).toFixed(1)}
                        y1={py(b.from_y).toFixed(1)}
                        x2={px(b.to_x).toFixed(1)}
                        y2={py(b.to_y).toFixed(1)}
                      >
                        <title>{t(T.jumpTip).replace('{a}', clockOf(b.from_t)).replace('{b}', clockOf(b.to_t))}</title>
                      </line>
                    ))}

                    {/* Missing-sample breaks: NEVER draw a line across unknown seconds; show hollow endpoint markers */}
                    {data.breaks.filter((b) => b.reason === 'missing').map((b, i) => (
                      <g key={`g-${b.from_t}-${i}`} className="ag-track-gap-mark">
                        <title>{t(T.gapTip).replace('{a}', clockOf(b.from_t)).replace('{b}', clockOf(b.to_t))}</title>
                        <circle cx={px(b.from_x).toFixed(1)} cy={py(b.from_y).toFixed(1)} r="3.4" />
                        <circle cx={px(b.to_x).toFixed(1)} cy={py(b.to_y).toFixed(1)} r="3.4" />
                      </g>
                    ))}

                    {/* Real contiguous path polylines colored by time */}
                    {pathGeometry.chunks.map((chunk) => (
                      <polyline
                        key={chunk.key}
                        className="ag-track-line"
                        points={chunk.points}
                        stroke={chunk.color}
                        onClick={() => jumpToMoment(chunk.midT, data.hero)}
                      >
                        <title>
                          {t(T.segmentTip)
                            .replace('{a}', clockOf(chunk.fromT))
                            .replace('{b}', clockOf(chunk.toT))
                            .replace('{m}', clockOf(chunk.midT))}
                        </title>
                      </polyline>
                    ))}

                    {/* Isolated single-second alive samples */}
                    {pathGeometry.singles.map((pt) => (
                      <circle
                        key={pt.key}
                        className="ag-track-point"
                        cx={pt.x.toFixed(1)}
                        cy={pt.y.toFixed(1)}
                        r="3"
                        fill={pt.color}
                        onClick={() => jumpToMoment(pt.t, data.hero)}
                      >
                        <title>{clockOf(pt.t)}</title>
                      </circle>
                    ))}

                    {/* Directional chevrons along real movement */}
                    {pathGeometry.arrows.map((ar) => (
                      <path
                        key={ar.key}
                        className="ag-track-arrow"
                        d="M-3.4 -2.5 L2.4 0 L-3.4 2.5"
                        stroke={ar.color}
                        transform={`translate(${ar.x.toFixed(1)} ${ar.y.toFixed(1)}) rotate(${ar.angle.toFixed(1)})`}
                      />
                    ))}

                    {/* Start & End markers */}
                    {pathGeometry.firstPt && (
                      <g className="ag-track-start" transform={`translate(${px(pathGeometry.firstPt[1]).toFixed(1)} ${py(pathGeometry.firstPt[2]).toFixed(1)})`}>
                        <title>{`${t(T.legendStart)} · ${clockOf(pathGeometry.firstPt[0])}`}</title>
                        <circle r="6.5" />
                      </g>
                    )}
                    {pathGeometry.lastPt && (
                      <g className={`ag-track-end is-${data.side}`} transform={`translate(${px(pathGeometry.lastPt[1]).toFixed(1)} ${py(pathGeometry.lastPt[2]).toFixed(1)})`}>
                        <title>{`${data.hero_name} · ${t(T.legendEnd)} · ${clockOf(pathGeometry.lastPt[0])}`}</title>
                        <circle r="11" className="ag-track-end-ring" />
                        {data.icons[data.hero] && (
                          <image
                            href={heroIcon(data.icons[data.hero])}
                            x="-9"
                            y="-9"
                            width="18"
                            height="18"
                            clipPath={`url(#${clipEndId})`}
                            preserveAspectRatio="xMidYMid slice"
                          />
                        )}
                      </g>
                    )}
                  </>
                )}

                {/* DEATH MARKERS (clickable to jump to MomentReplay in BOTH Path and Heatmap modes) */}
                {data.deaths.map((d, i) => renderDeathMarker(d, i, data.hero))}
              </svg>

              {/* Mode-specific legend */}
              <div className="ag-track-legend">
                {mode === 'path' ? (
                  <>
                    <span className="ag-track-grad">
                      <i>{t(T.legendStart)} {clockOf(data.from)}</i>
                      <span className="ag-track-grad-bar is-path" aria-hidden="true" />
                      <i>{t(T.legendEnd)} {clockOf(data.to)}</i>
                    </span>
                    <span className="ag-track-leg-item"><i className="is-jump" aria-hidden="true" />{t(T.legendJump)}</span>
                    {data.stats.missing_seconds > 0 && (
                      <span className="ag-track-leg-item"><i className="is-gap" aria-hidden="true" />{t(T.legendGap)}</span>
                    )}
                  </>
                ) : (
                  <span className="ag-track-grad">
                    <i>{t(T.legendHeatLow)}</i>
                    <span className="ag-track-grad-bar is-heat" aria-hidden="true" />
                    <i>{t(T.legendHeatHigh).replace('{n}', String(data.heat.max_seconds))}</i>
                  </span>
                )}
                {data.deaths.length > 0 && (
                  <span className="ag-track-leg-item"><i className="is-death" aria-hidden="true" />{t(T.legendDeath)}</span>
                )}
              </div>
              <figcaption>{t(T.caption)}</figcaption>
            </figure>

            <div className="ag-track-side">
              {/* Coverage stats */}
              <dl className="ag-track-stats">
                <div>
                  <dt>{t(T.statWindow)}</dt>
                  <dd>{clockOf(data.from)}–{clockOf(data.to)}</dd>
                </div>
                <div>
                  <dt>{t(T.statAlive)}</dt>
                  <dd>{formatDur(data.stats.alive_sampled_seconds, lang)}</dd>
                </div>
                {data.stats.dead_seconds > 0 && (
                  <div>
                    <dt>{t(T.statDead)}</dt>
                    <dd>{formatDur(data.stats.dead_seconds, lang)}</dd>
                  </div>
                )}
                {data.stats.missing_seconds > 0 && (
                  <div className="is-missing">
                    <dt>{t(T.statMissing)}</dt>
                    <dd>{formatDur(data.stats.missing_seconds, lang)}</dd>
                  </div>
                )}
              </dl>

              {/* Honest missing-sample disclosure (Unknown is not false) */}
              {data.stats.missing_seconds > 0 && (
                <p className="ag-track-gap-note" role="note">
                  {t(T.gapNotice).replace('{n}', String(data.stats.missing_seconds))}
                </p>
              )}
              {data.stats.alive_sampled_seconds === 0 && (
                <p className="ag-track-gap-note" role="note">{t(T.noAlive)}</p>
              )}

              {/* Clickable death timestamps for keyboard/mobile/quick replay */}
              <div className="ag-track-deaths">
                <p className="ag-track-deaths-head">{t(T.deathsHeading)}</p>
                {data.deaths.length === 0 ? (
                  <p className="ag-none">{t(T.noDeaths)}</p>
                ) : (
                  <ul className="ag-track-death-list">
                    {data.deaths.map((d, i) => {
                      const active = selectedMoment?.t === Math.round(d.t) && selectedMoment?.hero === data.hero;
                      return (
                        <li key={`dl-${d.t}-${i}`}>
                          <button
                            type="button"
                            className={`ag-track-death-btn${active ? ' is-on' : ''}`}
                            aria-pressed={active}
                            onClick={() => jumpToMoment(d.t, data.hero)}
                          >
                            <time>{d.clock}</time>
                            {d.place_name && <span className="ag-track-death-place">{d.place_name}</span>}
                            {d.killer && <span className="ag-track-death-killer">{t(T.deathBy).replace('{k}', data.names[d.killer] ?? d.killer)}</span>}
                            {d.x == null && <span className="ag-track-death-nopos">{t(T.deathNoPos)}</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </div>

          {selectedMoment && (
            <div className="ag-track-replay">
              <div className="ag-track-replay-head">
                <strong>{t(T.replayHead).replace('{clock}', selectedMoment.clock)}</strong>
                <button type="button" className="ag-link" onClick={() => setSelectedMoment(null)}>
                  {t(T.closeReplay)}
                </button>
              </div>
              <MomentReplay matchId={matchId} hero={selectedMoment.hero} lang={lang} t={selectedMoment.t} />
            </div>
          )}
        </>
      )}
    </div>
  );

  if (collapsible) {
    return (
      <details id={anchorId} ref={rootRef as React.RefObject<HTMLDetailsElement>} className="ag-track-fold" open={open}>
        <summary
          className="ag-track-summary"
          onClick={(e) => {
            e.preventDefault();
            setOpen((v) => !v);
          }}
        >
          <span className="ag-track-summary-copy">
            <span className="ag-track-summary-icon" aria-hidden="true"><MapRouteIcon size={16} /></span>
            <span className="ag-track-summary-title">{t(T.title)}</span>
            <span className="ag-track-summary-sub">{t(T.subtitle)}</span>
          </span>
        </summary>
        {open && content}
      </details>
    );
  }

  return (
    <section id={anchorId} ref={rootRef} className="ag-track" aria-label={t(T.title)}>
      <header className="ag-track-head">
        <span className="ag-track-summary-icon" aria-hidden="true"><MapRouteIcon size={16} /></span>
        <strong className="ag-track-summary-title">{t(T.title)}</strong>
        <span className="ag-track-summary-sub">{t(T.subtitle)}</span>
      </header>
      {content}
    </section>
  );
});
HeroTrackMap.displayName = 'HeroTrackMap';
