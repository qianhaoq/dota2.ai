import React from 'react';
import { SafeImg } from '../coach/ui';
import type { CoachReport, Player } from '../coach/types';
import type { AgentHero } from './api';
import { AegisEmblem, CrossedSwordsIcon, FactionCrest } from './DotaIcons';

type Lang = 'en' | 'zh' | 'ru';

const T = {
  match: { en: 'Match', zh: '比赛', ru: 'Матч' },
  radiant: { en: 'Radiant', zh: '天辉', ru: 'Силы Света' },
  dire: { en: 'Dire', zh: '夜魇', ru: 'Силы Тьмы' },
  victory: { en: 'Victory', zh: '胜利', ru: 'Победа' },
  defeat: { en: 'Defeat', zh: '失利', ru: 'Поражение' },
  radiantWin: { en: 'Radiant Victory', zh: '天辉胜利', ru: 'Победа Сил Света' },
  direWin: { en: 'Dire Victory', zh: '夜魇胜利', ru: 'Победа Сил Тьмы' },
  change: { en: 'Change hero', zh: '换英雄', ru: 'Сменить героя' },
  kda: { en: 'K / D / A', zh: '杀 / 死 / 助', ru: 'У / С / П' },
  lhdn: { en: 'LH / DN', zh: '正 / 反补', ru: 'Д / О' },
  nw: { en: 'Net worth', zh: '总经济', ru: 'Нетворс' },
  gpm: { en: 'GPM / XPM', zh: 'GPM / XPM', ru: 'GPM / XPM' },
  dmg: { en: 'Hero dmg', zh: '英雄伤害', ru: 'Урон' },
  items: { en: 'Final items', zh: '终局出装', ru: 'Итоговые предметы' },
  done: { en: 'finished', zh: '成型', ru: 'собран' },
  level: { en: 'Lv', zh: 'Lv', ru: 'Ур.' },
  rosterNav: { en: 'Switch hero perspective', zh: '切换英雄复盘视角', ru: 'Сменить героя для разбора' },
  switchTo: { en: 'Review {h}', zh: '切换查看 {h}', ru: 'Открыть разбор: {h}' },
} as const;

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clockOf = (sec: number) => `${Math.floor(Math.abs(sec) / 60)}:${String(Math.floor(Math.abs(sec)) % 60).padStart(2, '0')}`;
const shortK = (n: number) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const heroLabel = (hero: AgentHero, lang: Lang) => hero[lang] ?? hero.en;

export interface MatchHeroBannerProps {
  matchId: string;
  lang: Lang;
  hero: AgentHero | null;
  roster: AgentHero[];
  board: CoachReport | null;
  onPickHero: (key: string | null) => void;
  extra?: React.ReactNode;
}

export const MatchHeroBanner: React.FC<MatchHeroBannerProps> = ({
  matchId,
  lang,
  hero,
  roster,
  board,
  onPickHero,
  extra = null,
}) => {
  const t = (b: Record<Lang, string>) => b[lang];
  const m = board?.match;
  const players = Array.isArray(board?.players) ? board!.players : [];
  const seat: Player | null = hero
    ? players.find((p) => (hero.hero_id != null && p.hero?.id === hero.hero_id) || p.hero?.slug === hero.hero) ?? null
    : null;

  const radiantWin = typeof m?.radiant_win === 'boolean' ? m.radiant_win : null;
  const playerWon = hero && radiantWin != null ? (hero.team === 'radiant' ? radiantWin : !radiantWin) : null;
  const score = Array.isArray(m?.score) && m.score.length >= 2 ? m.score : null;
  const duration = num(m?.duration) ? clockOf(m.duration) : null;
  const mode = m?.mode?.[lang] ?? m?.mode?.en ?? null;

  const imgOf = (h: AgentHero) =>
    players.find((p) => (h.hero_id != null && p.hero?.id === h.hero_id) || p.hero?.slug === h.hero)?.hero?.img ?? null;

  // Spike completion times for the player's items (if available from CoachReport).
  const itemTimes = new Map<string, number>();
  if (seat && Array.isArray(board?.spikes)) {
    const mine = board!.spikes.find((s) => s?.slot === seat.slot);
    for (const it of mine?.items ?? []) {
      if (it?.item?.key && !itemTimes.has(it.item.key)) itemTimes.set(it.item.key, it.time);
    }
  }

  const hasKda = Array.isArray(seat?.kda) && seat.kda.length >= 3 && seat.kda.every(num);
  const items = Array.isArray(seat?.items) ? seat.items.slice(0, 6) : [];
  const hasStats = Boolean(
    seat && (hasKda || num(seat.net_worth) || num(seat.gpm) || num(seat.hero_damage) || items.length > 0),
  );

  const radiantRoster = roster.filter((h) => h.team === 'radiant');
  const direRoster = roster.filter((h) => h.team === 'dire');
  const showQuickRoster = Boolean(hero && roster.length >= 2);
  const heroImg = hero ? imgOf(hero) : null;

  const auraClass = radiantWin === true ? 'is-radiant-win' : radiantWin === false ? 'is-dire-win' : '';

  return (
    <header className={`ag-head ag-banner ${auraClass}${hero ? ' has-hero' : ''}`}>
      <div className="ag-banner-bar" aria-hidden="true" />

      <div className="ag-banner-top">
        <p className="cx-eyebrow">
          <AegisEmblem size={13} className="ag-banner-aegis" />
          <span>{t(T.match)} {matchId}{m?.patch ? ` · ${m.patch}` : ''}</span>
        </p>

        {(radiantWin != null || score || duration || mode) && (
          <div className="ag-banner-telemetry">
            {radiantWin != null && (
              <span className={`ag-banner-outcome ${radiantWin ? 'is-radiant' : 'is-dire'}`}>
                <FactionCrest side={radiantWin ? 'radiant' : 'dire'} size={13} />
                {t(radiantWin ? T.radiantWin : T.direWin)}
              </span>
            )}
            {score && (
              <span className="ag-banner-score">
                <b className="is-radiant">{score[0]}</b>
                <CrossedSwordsIcon size={12} className="ag-banner-vs-icon" />
                <b className="is-dire">{score[1]}</b>
              </span>
            )}
            {duration && <span className="ag-banner-meta-pill">{duration}</span>}
            {mode && <span className="ag-banner-meta-pill is-mode">{mode}</span>}
          </div>
        )}
      </div>

      {hero && (
        <div className="ag-banner-hero-row">
          <div className="ag-head-hero">
            <div className={`ag-hero-frame is-${hero.team}`}>
              {heroImg
                ? <SafeImg src={heroImg} alt="" className="ag-portrait ag-portrait--lg" />
                : <span className="ag-portrait ag-portrait--lg ag-portrait--blank" aria-hidden="true" />}
              {num(seat?.level) && (
                <span className="ag-hero-lvl" title={`${t(T.level)} ${seat.level}`}>{seat.level}</span>
              )}
            </div>
            <div className="ag-hero-ident">
              <div className="ag-hero-name-line">
                <strong>{heroLabel(hero, lang)}</strong>
                <span className={`ag-team is-${hero.team}`}>
                  <FactionCrest side={hero.team} size={12} />
                  {t(T[hero.team])}
                </span>
                {playerWon != null && (
                  <span className={`ag-result-pill ${playerWon ? 'is-win' : 'is-loss'}`}>
                    {t(playerWon ? T.victory : T.defeat)}
                  </span>
                )}
              </div>
              <button type="button" className="ag-link ag-change-btn" onClick={() => onPickHero(null)}>
                {t(T.change)}
              </button>
            </div>
          </div>

          {hasStats && seat && (
            <div className="ag-hud-strip">
              <dl className="ag-hud-stats">
                {hasKda && (
                  <div className="ag-hud-stat">
                    <dt>{t(T.kda)}</dt>
                    <dd className="ag-hud-kda">
                      <span className="is-k">{seat.kda[0]}</span>
                      <i>/</i>
                      <span className="is-d">{seat.kda[1]}</span>
                      <i>/</i>
                      <span className="is-a">{seat.kda[2]}</span>
                    </dd>
                  </div>
                )}
                {num(seat.last_hits) && (
                  <div className="ag-hud-stat">
                    <dt>{t(T.lhdn)}</dt>
                    <dd>{seat.last_hits} / {num(seat.denies) ? seat.denies : '–'}</dd>
                  </div>
                )}
                {num(seat.net_worth) && (
                  <div className="ag-hud-stat is-gold">
                    <dt>{t(T.nw)}</dt>
                    <dd>{shortK(seat.net_worth)}</dd>
                  </div>
                )}
                {num(seat.gpm) && (
                  <div className="ag-hud-stat">
                    <dt>{t(T.gpm)}</dt>
                    <dd>{seat.gpm}{num(seat.xpm) ? ` / ${seat.xpm}` : ''}</dd>
                  </div>
                )}
                {num(seat.hero_damage) && (
                  <div className="ag-hud-stat">
                    <dt>{t(T.dmg)}</dt>
                    <dd>{shortK(seat.hero_damage)}</dd>
                  </div>
                )}
              </dl>

              {items.length > 0 && (
                <div className="ag-hud-inv" aria-label={t(T.items)}>
                  {Array.from({ length: 6 }, (_, idx) => {
                    const it = items[idx];
                    if (!it) return <span key={`empty-${idx}`} className="ag-inv-slot is-empty" aria-hidden="true" />;
                    const at = itemTimes.get(it.key);
                    const name = it[lang] ?? it.en ?? it.key;
                    const label = at != null ? `${name} · ${t(T.done)} ${clockOf(at)}` : name;
                    return (
                      <span key={`${it.key}-${idx}`} className="ag-inv-slot" title={label}>
                        {it.img
                          ? <SafeImg src={it.img} alt={label} className="ag-inv-img" />
                          : <span className="ag-inv-text">{name.slice(0, 4)}</span>}
                        {at != null && <span className="ag-inv-time">{clockOf(at)}</span>}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {showQuickRoster && (
        <nav className="ag-banner-roster" aria-label={t(T.rosterNav)}>
          <div className="ag-roster-side is-radiant">
            <span className="ag-roster-tag">{t(T.radiant)}</span>
            <div className="ag-roster-chips">
              {radiantRoster.map((h) => {
                const active = h.hero === hero?.hero;
                const img = imgOf(h);
                const label = heroLabel(h, lang);
                return (
                  <button
                    key={h.hero}
                    type="button"
                    className={`ag-roster-chip is-radiant${active ? ' is-active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                    aria-label={t(T.switchTo).replace('{h}', label)}
                    title={label}
                    onClick={() => { if (!active) onPickHero(h.hero); }}
                  >
                    {img ? <SafeImg src={img} alt="" className="ag-roster-img" /> : <span className="ag-roster-fallback">{label.slice(0, 2)}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          <span className="ag-roster-vs" aria-hidden="true">VS</span>

          <div className="ag-roster-side is-dire">
            <div className="ag-roster-chips">
              {direRoster.map((h) => {
                const active = h.hero === hero?.hero;
                const img = imgOf(h);
                const label = heroLabel(h, lang);
                return (
                  <button
                    key={h.hero}
                    type="button"
                    className={`ag-roster-chip is-dire${active ? ' is-active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                    aria-label={t(T.switchTo).replace('{h}', label)}
                    title={label}
                    onClick={() => { if (!active) onPickHero(h.hero); }}
                  >
                    {img ? <SafeImg src={img} alt="" className="ag-roster-img" /> : <span className="ag-roster-fallback">{label.slice(0, 2)}</span>}
                  </button>
                );
              })}
            </div>
            <span className="ag-roster-tag">{t(T.dire)}</span>
          </div>
        </nav>
      )}

      {extra}
    </header>
  );
};
