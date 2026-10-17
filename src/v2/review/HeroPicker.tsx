import React from 'react';
import type { MatchPlayerFact } from '../../types/matchReview';
import { useI18n } from '../i18n/I18nProvider';
import { IconInfo } from './icons';

/**
 * "Which one was you?" hero picker (handoff §1 screen 3): the ten players as
 * a 2×5 grid (Radiant row / Dire row), hero name + K/D/A straight from the
 * payload. The avatar is a text/initial badge — no external image URLs.
 * Names wrap onto at most 2 centered lines without ever splitting mid-word
 * ("Windranger" must render whole, not "Windrange|r"); a single word wider
 * than the tile hyphenates via CSS (hyphens:auto plus a lang attribute for
 * the hyphenation dictionary) instead of being clipped, and the full name
 * stays available via title + aria-label.
 */
const HeroPicker: React.FC<{
  players: MatchPlayerFact[];
  winner: 'radiant' | 'dire' | null;
  selectedHeroId: number | null;
  onPick: (player: MatchPlayerFact) => void;
}> = ({ players, winner, selectedHeroId, onPick }) => {
  const { lang, t } = useI18n();

  const team = (isRadiant: boolean) => {
    const side = isRadiant ? 'sideRadiant' : 'sideDire';
    const won = winner === (isRadiant ? 'radiant' : 'dire');
    return (
      <>
        <div className="flex items-center gap-[6px] my-[14px] mx-0 text-d2-13 font-semibold text-d2-ink-3">
          <span
            className={`w-[8px] h-[8px] rounded-full ${isRadiant ? 'bg-d2-up' : 'bg-d2-down'}`}
            aria-hidden="true"
          />
          {t(side)} <span className="font-normal text-d2-ink-4">· {t(won ? 'sideWon' : 'sideLost')}</span>
        </div>
        <div className="grid grid-cols-5 gap-[2px] -mx-[10px]">
          {players
            .filter((p) => p.isRadiant === isRadiant)
            .map((p) => {
              const name = lang === 'zh' ? p.nameZh : p.nameEn;
              const selected = selectedHeroId === p.heroId;
              return (
                <button
                  key={p.heroId}
                  type="button"
                  onClick={() => onPick(p)}
                  aria-label={`${name}, ${p.kills}/${p.deaths}/${p.assists}`}
                  title={name}
                  aria-pressed={selected}
                  className={`flex flex-col items-center gap-[4px] py-[6px] px-0 rounded-[12px] border min-w-0 transition-colors duration-d2-fast active:scale-[0.96] ${
                    selected
                      ? 'border-d2-accent bg-d2-accent-bg'
                      : 'border-transparent hover:bg-d2-surface-2'
                  }`}
                >
                  <span className="w-[48px] h-[48px] rounded-[10px] bg-[#ECEEF2] grid place-items-center text-d2-17 font-semibold text-d2-ink-2 flex-none">
                    {name.slice(0, 1)}
                  </span>
                  <span
                    lang={lang === 'zh' ? 'zh-CN' : 'en'}
                    className="w-full min-w-0 min-h-[30px] text-center text-[11px] leading-[14px] sm:text-d2-12 font-medium text-d2-ink-2 [word-break:normal] [overflow-wrap:normal] [hyphens:auto] [-webkit-hyphens:auto] line-clamp-2 overflow-hidden tracking-[-0.01em]"
                  >
                    {name}
                  </span>
                  <span className="d2-tnum text-d2-12 text-d2-ink-4">
                    {p.kills}/{p.deaths}/{p.assists}
                  </span>
                </button>
              );
            })}
        </div>
      </>
    );
  };

  return (
    <div className="bg-d2-surface rounded-d2-card shadow-d2-2 p-[16px]">
      <div className="text-d2-15 font-semibold text-d2-ink">{t('pickHeading')}</div>
      {team(true)}
      {team(false)}
      <div className="mt-[12px] flex items-center gap-[6px] text-d2-12 text-d2-ink-4">
        <IconInfo />
        <span>{t('pickNote')}</span>
      </div>
    </div>
  );
};

export default HeroPicker;
