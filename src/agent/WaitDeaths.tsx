/**
 * Something to look at while the review is being written: the player's own deaths, each one replayable on the map.
 *
 * A review takes two to three minutes; the replay is already parsed when it starts. Nothing here is a judgment:
 * the times and the labels are the death summary the review itself reads (`deaths:<hero>`, death_context), and
 * a label is shown only where that summary lists the death — a death it could not tell about gets no label,
 * not the opposite one, and is still listed: its time is known from whichever list has it. The replay is the same one the review's moments use.
 */
import React, { useEffect, useState } from 'react';
import { fetchEvidence } from './api';
import { MomentReplay } from './MomentReplay';
import { trackEvent } from '../services/analytics';

type Lang = 'en' | 'zh';
const T: Record<string, Record<Lang, string>> = {
  title: { en: 'While the coach reads the replay: your {n} deaths', zh: '教练看录像的这几分钟，先看你的 {n} 次阵亡' },
  one: { en: 'While the coach reads the replay: your one death', zh: '教练看录像的这几分钟，先看你唯一的一次阵亡' },
  none: { en: 'While the coach reads the replay', zh: '教练正在看录像' },
  noneBody: { en: 'You did not die once this game.', zh: '这局你一次都没有阵亡。' },
  how: { en: 'Facts from the replay, no verdict yet. Each one can be played on the map.', zh: '这些是录像里的事实，还不是结论。每一次都能在地图上重放。' },
  by: { en: 'Last hit by', zh: '最后一击来自' },
  times: { en: '×{n}', zh: '{n} 次' },
  play: { en: 'Replay on the map', zh: '在地图上重放' },
  close: { en: 'Close the replay', zh: '收起回放' },
  untimed: { en: '{n} more with no time in this summary.', zh: '另有 {n} 次，这份汇总里没有时间。' },
  in_a_fight: { en: 'in a fight', zh: '团战中' },
  outside_fights: { en: 'outside a fight', zh: '团战外' },
  no_ally_within_2200_at_death: { en: 'no ally within 2200', zh: '2200 范围内没有队友' },
  three_or_more_enemy_heroes_dealing_damage: { en: '3+ enemies hitting you', zh: '三个以上敌人在打你' },
  traded_within_15s: { en: 'an enemy died within 15 s', zh: '15 秒内有敌人倒下' },
  not_traded_within_15s: { en: 'no enemy died within 15 s', zh: '15 秒内没有敌人倒下' },
};
/** The labels shown, in this order: each is a list of death times in the summary's `deaths_where`. */
const LABELS = ['in_a_fight', 'outside_fights', 'no_ally_within_2200_at_death', 'three_or_more_enemy_heroes_dealing_damage', 'traded_within_15s', 'not_traded_within_15s'] as const;
const seconds = (clock: string): number | null => { const m = /^(-)?(\d{1,3}):([0-5]\d)$/.exec(clock); return m ? (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : null; };

interface Summary { deaths_total: number; killed_by: Record<string, number>; deaths_where: Record<string, string[]> }

export const WaitDeaths: React.FC<{ matchId: string; hero: string; lang: Lang }> = ({ matchId, hero, lang }) => {
  const t = (k: string) => T[k][lang];
  const [data, setData] = useState<{ record: Summary; names: Record<string, string> } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    setData(null); setOpen(null);
    // An extra: if it cannot be read, the wait looks as it did before.
    fetchEvidence(matchId, hero, lang, `deaths:${hero}`).then((r) => { if (alive && Number.isInteger(r.record?.deaths_total) && r.record.deaths_where) setData({ record: r.record, names: r.names ?? {} }); }).catch(() => {});
    return () => { alive = false; };
  }, [matchId, hero, lang]);
  if (!data) return null;

  const { record, names } = data;
  const where = (k: string): string[] => (Array.isArray(record.deaths_where[k]) ? record.deaths_where[k] : []);
  // Every death the summary gives a time for, in game order: the times of all its lists together. Not only "in a
  // fight" and "outside one" — a death whose positions the replay lacks is in neither, and is still a death at a
  // known time: it is listed, without the labels that could not be told.
  const rows = [...new Set(Object.values(record.deaths_where).flatMap((list) => (Array.isArray(list) ? list.filter((c): c is string => typeof c === 'string') : [])))]
    .map((clock) => ({ clock, at: seconds(clock) }))
    .filter((r): r is { clock: string; at: number } => r.at != null)
    .sort((a, b) => a.at - b.at);
  const untimed = Math.max(0, record.deaths_total - rows.length);
  const killers = Object.entries(record.killed_by ?? {}).filter(([, n]) => Number.isInteger(n) && n > 0).sort((a, b) => b[1] - a[1]);
  const toggle = (at: number) => {
    if (open !== at) trackEvent('moment_played', { matchId, lang, hero });
    setOpen(open === at ? null : at);
  };

  return (
    <section className="ag-wait" aria-labelledby="ag-wait-title">
      <h2 id="ag-wait-title">{record.deaths_total === 0 ? t('none') : record.deaths_total === 1 ? t('one') : t('title').replace('{n}', String(record.deaths_total))}</h2>
      {record.deaths_total === 0 ? <p>{t('noneBody')}</p> : (
        <>
          <p>{t('how')}</p>
          {killers.length > 0 && (
            <p className="ag-wait-by"><span>{t('by')}</span>{killers.map(([k, n]) => <span key={k} className="ag-chip is-enemy">{names[k] ?? k} {t('times').replace('{n}', String(n))}</span>)}</p>
          )}
          <ul className="ag-wait-list">
            {rows.map((r) => (
              <li key={r.clock}>
                <span className="ag-wait-clock">{r.clock}</span>
                <div>
                  <p className="ag-wait-tags">{LABELS.filter((k) => where(k).includes(r.clock)).map((k) => <span key={k} className="ag-chip">{t(k)}</span>)}</p>
                  {/* The time is in the row beside it; in the button's name too, so eleven buttons are not one name read eleven times. */}
                  <button type="button" className="ag-link" aria-expanded={open === r.at} aria-label={`${open === r.at ? t('close') : t('play')} · ${r.clock}`} onClick={() => toggle(r.at)}>{open === r.at ? t('close') : t('play')}</button>
                  {open === r.at && <MomentReplay matchId={matchId} hero={hero} lang={lang} t={r.at} />}
                </div>
              </li>
            ))}
          </ul>
          {untimed > 0 && <p className="ag-wait-note">{t('untimed').replace('{n}', String(untimed))}</p>}
        </>
      )}
    </section>
  );
};
