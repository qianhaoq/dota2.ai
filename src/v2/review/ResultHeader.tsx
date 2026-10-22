import React from 'react';
import { heroDisplayName } from './heroDisplayName';
import { useI18n } from '../i18n/I18nProvider';

/**
 * Review result header (handoff §1 screen 4): hero, WIN/LOSS badge (d2 up /
 * down), duration and KDA from the API payload; hero labels use the shared
 * localized hero metadata.
 */
const ResultHeader: React.FC<{
  heroName: string;
  kda: string;
  isRadiant: boolean;
  outcome: 'win' | 'loss' | null;
  duration: string;
  heroSlug?: string;
  chart?: React.ReactNode;
}> = ({ heroName, kda, isRadiant, outcome, duration, heroSlug, chart }) => {
  const { t, lang } = useI18n();
  const displayName = heroDisplayName(heroSlug ?? heroName, lang);
  const won = outcome === 'win';

  return (
    <div className="bg-d2-surface rounded-d2-card shadow-d2-2 p-[16px]">
      <div className="flex gap-[12px] items-center">
        <span
          className="w-[44px] h-[44px] rounded-[10px] bg-[#ECEEF2] grid place-items-center text-d2-17 font-semibold text-d2-ink-2 flex-none"
          aria-hidden="true"
        >
          {heroSlug ? <img className="w-full h-full object-cover rounded-d2-avatar" src={`https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${heroSlug}.png`} alt="" /> : displayName.slice(0, 1)}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-[8px] min-w-0">
            <h2 className="text-d2-17 font-semibold tracking-[-0.01em] text-d2-ink m-0 truncate">{displayName}</h2>
            {outcome && (
              <span
                className={`inline-flex items-center h-[22px] px-[8px] rounded-d2-chip text-d2-12 font-semibold whitespace-nowrap ${
                  won ? 'bg-d2-up-bg text-d2-up' : 'bg-d2-down-bg text-d2-down'
                }`}
              >
                {t(won ? 'badgeWin' : 'badgeLoss')}
              </span>
            )}
            <span className="d2-tnum ml-auto text-d2-15 font-semibold text-d2-ink-2 whitespace-nowrap">
              {duration}
            </span>
          </div>
          <div className="d2-tnum text-d2-13 text-d2-ink-3">
            {t(isRadiant ? 'sideRadiant' : 'sideDire')}{kda ? ` · ${kda}` : ''}
          </div>
        </div>
      </div>
      {chart}
    </div>
  );
};

export default ResultHeader;
