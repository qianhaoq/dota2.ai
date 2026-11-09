import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n/I18nProvider';
import { buildCarryQuery } from '../carryQuery';
import { heroDisplayName } from '../review/heroDisplayName';
import Composer from './Composer';
import './EmptyState.css';

export const SAMPLE_MATCH_ID = '9035042364';

// The actual roster in OpenDota match 9035042364 (also covered by the checked-in
// review fixtures). Only the roster is previewed — no copied or invented conclusions.
const SAMPLE_RADIANT = ['faceless_void', 'pudge', 'mirana', 'windrunner', 'legion_commander'];
const SAMPLE_DIRE = ['hoodwink', 'doom_bringer', 'sniper', 'ogre_magi', 'skeleton_king'];
const HERO_CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes';

const Lineup: React.FC<{ side: 'radiant' | 'dire'; heroes: string[] }> = ({ side, heroes }) => {
  const { lang, t } = useI18n();
  return (
    <div className={`d2-lineup d2-lineup-${side}`}>
      <div className="d2-lineup-label">
        <span className="d2-side-mark" aria-hidden="true" />
        {t(side === 'radiant' ? 'sideRadiant' : 'sideDire')}
      </div>
      <div className="d2-lineup-heroes">
        {heroes.map((hero) => (
          <img
            key={hero}
            src={`${HERO_CDN}/${hero}.png`}
            alt={heroDisplayName(hero, lang)}
            width="160"
            height="100"
            loading="lazy"
            decoding="async"
          />
        ))}
      </div>
    </div>
  );
};

/** Match-ID-first home with a visual preview of the real sample match. */
const EmptyState: React.FC = () => {
  const { lang, t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();

  const openSample = () => {
    navigate({ pathname: `/m/${SAMPLE_MATCH_ID}`, search: buildCarryQuery(location.search, lang) });
  };

  return (
    <section className="d2-home-layout" aria-labelledby="home-title">
      <div className="d2-home-scene" aria-hidden="true" />
      <div className="d2-home-copy">
        <h1 id="home-title" className="d2-home-title">{t('emptyH')}</h1>
        <Composer variant="hero" />
        <p className="d2-home-trust">{t('trust')}</p>
      </div>

      <aside className="d2-example" aria-label={t('stSample')}>
        <div className="d2-example-roster">
          <Lineup side="radiant" heroes={SAMPLE_RADIANT} />
          <Lineup side="dire" heroes={SAMPLE_DIRE} />
        </div>
        <button type="button" onClick={openSample} className="d2-sample-button">
          <span className="d2-tnum">{t('stSample')}</span>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </aside>
    </section>
  );
};

export default EmptyState;
