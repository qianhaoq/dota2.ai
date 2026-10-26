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
    <div className="bg-d2-surface-2 border border-d2-line-2 rounded-d2-card shadow-d2-2 p-[16px] relative overflow-hidden">
      {/* Gold accent corner */}
      <div className="absolute -right-[70px] -top-[30px] w-[160px] h-[160px] border border-d2-gold/10 rotate-45 pointer-events-none" />
      <div className="flex gap-[12px] items-center relative">
        <div
          className="w-[44px] h-[38px] rounded-[4px] overflow-hidden border border-d2-line flex-none relative"
          aria-hidden="true"
        >
          {heroSlug ? (
            <>
              <img className="w-full h-full object-cover" src={`https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${heroSlug}.png`} alt="" />
              <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
            </>
          ) : (
            <span className="w-full h-full grid place-items-center text-d2-17 font-semibold text-d2-ink-2 bg-d2-surface-3">{displayName.slice(0, 1)}</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-[8px] min-w-0">
            <h2 className="text-d2-17 font-semibold tracking-[-0.01em] text-d2-ink m-0 truncate font-serif">{displayName}</h2>
            {outcome && (
              <span
                className={`inline-flex items-center h-[22px] px-[8px] rounded-d2-chip text-d2-12 font-bold tracking-wide uppercase whitespace-nowrap border ${
                  won ? 'bg-d2-up-bg text-d2-up border-d2-up/30' : 'bg-d2-down-bg text-d2-down border-d2-down/30'
                }`}
              >
                {t(won ? 'badgeWin' : 'badgeLoss')}
              </span>
            )}
            <span className="d2-tnum ml-auto text-d2-15 font-semibold text-d2-ink-2 whitespace-nowrap font-mono">
              {duration}
            </span>
          </div>
          <div className={`d2-tnum text-d2-13 ${isRadiant ? 'text-d2-radiant' : 'text-d2-dire'}`}>
            {t(isRadiant ? 'sideRadiant' : 'sideDire')}{kda ? ` · ${kda}` : ''}
          </div>
        </div>
      </div>
      {chart}
    </div>
  );
};

export default ResultHeader;
