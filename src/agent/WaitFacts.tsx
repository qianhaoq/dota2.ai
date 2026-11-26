/**
 * Additional deterministic replay facts shown while the review is being written (#363):
 * - the whole game's fight strip (`overview`), with any fight bar clickable to replay on the map;
 * - the player's own key items in the order they were first held (`build:<hero>`).
 *
 * Purely from the parsed replay's `/evidence` endpoint — zero model calls. If neither record can be read,
 * nothing is rendered so the wait screen degrades cleanly.
 */
import React, { useEffect, useState } from 'react';
import { fetchEvidence } from './api';
import { FightStrip, type Fight } from './ReviewDoc';
import { MomentReplay } from './MomentReplay';
import { trackEvent } from '../services/analytics';

type Lang = 'en' | 'zh' | 'ru';

interface BigItem {
  item: string;
  name: string;
  first_held: string;
}

interface OverviewRecord {
  fights: Fight[];
  duration: { t: number } | null;
  turning_fight?: { ref: string } | { none: true } | null;
}

const T: Record<string, Record<Lang, string>> = {
  title: {
    en: 'Fights and your key items',
    zh: '团战走势与你的关键成装',
    ru: 'Драки матча и ваши ключевые предметы',
  },
  playFight: {
    en: 'Replay the fight at',
    zh: '重放这波团战',
    ru: 'Показать драку на',
  },
  fightHint: {
    en: 'Select any fight bar above to replay it on the map.',
    zh: '点上方任意一波团战柱，可在地图上重放。',
    ru: 'Нажмите на любой столбец драки выше, чтобы воспроизвести её на карте.',
  },
  closeFight: {
    en: 'Close fight replay',
    zh: '收起团战回放',
    ru: 'Скрыть повтор драки',
  },
  itemsTitle: {
    en: 'Your key items, when first held',
    zh: '你的关键装备到手时间',
    ru: 'Ваши ключевые предметы по времени покупки',
  },
};

export const WaitFacts: React.FC<{ matchId: string; hero: string; lang: Lang }> = ({ matchId, hero, lang }) => {
  const t = (k: string) => T[k][lang];
  const [overview, setOverview] = useState<OverviewRecord | null>(null);
  const [items, setItems] = useState<{ list: BigItem[]; names: Record<string, string> } | null>(null);
  const [selectedFight, setSelectedFight] = useState<Fight | null>(null);

  useEffect(() => {
    let alive = true;
    setOverview(null);
    setItems(null);
    setSelectedFight(null);
    fetchEvidence(matchId, hero, lang, 'overview')
      .then((r) => {
        if (alive && Array.isArray(r.record?.fights) && r.record?.duration?.t) {
          setOverview(r.record as OverviewRecord);
        }
      })
      .catch(() => {});
    fetchEvidence(matchId, hero, lang, `build:${hero}`)
      .then((r) => {
        if (alive && Array.isArray(r.record?.my_big_items_in_order)) {
          setItems({ list: r.record.my_big_items_in_order as BigItem[], names: r.names ?? {} });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [matchId, hero, lang]);

  const hasFights = Boolean(overview && overview.fights.length > 0 && overview.duration);
  const hasItems = Boolean(items && items.list.length > 0);
  if (!hasFights && !hasItems) return null;

  const toggleFight = (fight: Fight) => {
    if (selectedFight?.ref === fight.ref) {
      setSelectedFight(null);
    } else {
      trackEvent('moment_played', { matchId, lang, hero });
      setSelectedFight(fight);
    }
  };

  const turnRef = overview?.turning_fight && 'ref' in overview.turning_fight ? overview.turning_fight.ref : null;

  return (
    <section className="ag-wait-facts" aria-labelledby="ag-wait-facts-title">
      <h2 id="ag-wait-facts-title">{t('title')}</h2>
      {hasFights && overview?.duration && (
        <div className="ag-wait-fights">
          <FightStrip
            fights={overview.fights}
            duration={overview.duration.t}
            turn={turnRef}
            lang={lang}
            onAsk={() => {}}
            onSelectFight={toggleFight}
            fightActionLabel={t('playFight')}
          />
          <p className="ag-wait-note">{t('fightHint')}</p>
          {selectedFight && (
            <div className="ag-wait-fight-replay">
              <p className="ag-wait-fight-head">
                <span className="ag-wait-clock">{selectedFight.clock}</span>
                <button type="button" className="ag-link" onClick={() => setSelectedFight(null)}>
                  {t('closeFight')}
                </button>
              </p>
              <MomentReplay matchId={matchId} hero={hero} lang={lang} t={selectedFight.from} />
            </div>
          )}
        </div>
      )}
      {hasItems && items && (
        <div className="ag-wait-build">
          <p className="ag-wait-sub">{t('itemsTitle')}</p>
          <ol className="ag-wait-items" aria-label={t('itemsTitle')}>
            {items.list.map((it) => (
              <li key={`${it.item}:${it.first_held}`}>
                <time className="ag-wait-clock">{it.first_held}</time>
                <span className="ag-chip">{items.names[it.item] ?? it.name}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
};
