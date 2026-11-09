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

const HomeGround: React.FC = () => (
  <svg
    className="d2-home-ground"
    viewBox="0 0 1200 900"
    preserveAspectRatio="none"
    fill="none"
    aria-hidden="true"
  >
    <path className="d2-ground-dire" d="M0 0h1200v165L0 690Z" />
    <path className="d2-ground-radiant" d="M0 690 1200 165v735H0Z" />
    <g className="d2-ground-lane-edges">
      <path d="M70 830V270Q70 70 270 70h860" />
      <path d="m70 830 1060-760" />
      <path d="M70 830h860q200 0 200-200V70" />
    </g>
    <g className="d2-ground-lanes">
      <path d="M70 830V270Q70 70 270 70h860" />
      <path d="m70 830 1060-760" />
      <path d="M70 830h860q200 0 200-200V70" />
    </g>
    <path className="d2-ground-river" d="M-80 175C265 300 770 645 1280 770" />
    <g className="d2-ground-bases">
      <path d="m70 812 18 18-18 18-18-18Z" />
      <path d="m1130 52 18 18-18 18-18-18Z" />
    </g>
  </svg>
);

const MapMotif: React.FC = () => (
  <svg
    className="d2-example-map"
    viewBox="0 0 1000 360"
    preserveAspectRatio="none"
    fill="none"
    aria-hidden="true"
  >
    <path className="d2-map-radiant d2-map-zone-desktop" d="M0 0h560L440 360H0Z" />
    <path className="d2-map-dire d2-map-zone-desktop" d="M560 0h440v360H440Z" />
    <path className="d2-map-radiant d2-map-zone-mobile" d="M0 0h1000v150L0 230Z" />
    <path className="d2-map-dire d2-map-zone-mobile" d="M0 230 1000 150v210H0Z" />
    <g className="d2-map-lanes">
      <path d="M35 320V40h930" />
      <path d="m35 320 930-280" />
      <path d="M35 320h930V40" />
    </g>
    <path className="d2-map-river" d="M540-30C510 80 485 220 450 390" />
    <g className="d2-map-bases">
      <path d="m35 308 12 12-12 12-12-12Z" />
      <path d="m965 28 12 12-12 12-12-12Z" />
    </g>
  </svg>
);

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
      <HomeGround />
      <div className="d2-home-copy">
        <h1 id="home-title" className="d2-home-title">{t('emptyH')}</h1>
        <Composer variant="hero" />
        <p className="d2-home-trust">{t('trust')}</p>
      </div>

      <aside className="d2-example" aria-label={t('stSample')}>
        <MapMotif />
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
