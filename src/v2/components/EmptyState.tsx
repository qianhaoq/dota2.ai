import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n/I18nProvider';
import { buildCarryQuery } from '../carryQuery';
import { heroDisplayName } from '../review/heroDisplayName';
import Composer from './Composer';
import './EmptyState.css';

export const SAMPLE_MATCH_ID = '9035042364';

// The actual roster in OpenDota match 9035042364 (also covered by the checked-in
// review fixtures). Only roster and review structure are previewed — no copied
// or invented sample conclusions.
const SAMPLE_RADIANT = ['faceless_void', 'pudge', 'mirana', 'windrunner', 'legion_commander'];
const SAMPLE_DIRE = ['hoodwink', 'doom_bringer', 'sniper', 'ogre_magi', 'skeleton_king'];
const HERO_CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes';

const MapMotif: React.FC = () => (
  <svg className="d2-example-map" viewBox="0 0 180 180" fill="none" aria-hidden="true">
    <path d="M18 18h144v144H18z" stroke="currentColor" />
    <path d="M25 25 155 155M25 90V25h65M90 155h65V90" stroke="currentColor" strokeWidth="5" />
    <path d="m19 153 31-25 21 5 25-29 6-23 30-24 29-37" stroke="currentColor" strokeWidth="2" strokeDasharray="4 5" />
    <path d="m27 145 12 12-12 12-12-12zM153 23l12 12-12 12-12-12z" fill="currentColor" stroke="none" />
    <circle cx="91" cy="91" r="5" fill="currentColor" stroke="none" />
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
            width="64"
            height="56"
            loading="lazy"
            decoding="async"
          />
        ))}
      </div>
    </div>
  );
};

/** Match-ID-first home with a clearly labeled preview of the real sample match. */
const EmptyState: React.FC = () => {
  const { lang, t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();

  const openSample = () => {
    navigate({ pathname: `/m/${SAMPLE_MATCH_ID}`, search: buildCarryQuery(location.search, lang) });
  };

  const reviewParts = [
    { key: 'cardTurning', description: 'turningDesc' },
    { key: 'cardMistake', description: 'mistakeDesc' },
    { key: 'cardNext', description: 'nextDesc' },
  ] as const;

  return (
    <section className="d2-home-layout" aria-labelledby="home-title">
      <div className="d2-home-copy">
        <p className="d2-home-eyebrow"><span aria-hidden="true" />{t('homeEyebrow')}</p>
        <h1 id="home-title" className="d2-home-title">{t('emptyH')}</h1>
        <p className="d2-home-intro">{t('emptyP')}</p>

        <Composer variant="hero" />

        <div className="d2-home-trust">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 3l7 2.7v5.6c0 4.6-3 8.4-7 9.7-4-1.3-7-5.1-7-9.7V5.7L12 3z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
            <path d="M8.8 12l2.2 2.2 4.3-4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{t('trust')}</span>
        </div>
      </div>

      <aside className="d2-example" aria-labelledby="example-title">
        <MapMotif />
        <div className="d2-example-heading">
          <p className="d2-example-eyebrow">{t('exampleEyebrow')}</p>
          <a
            className="d2-example-match d2-tnum"
            href={`https://opendota.com/matches/${SAMPLE_MATCH_ID}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${t('sourceMatch')}: OpenDota ${SAMPLE_MATCH_ID}`}
          >
            {SAMPLE_MATCH_ID}<span aria-hidden="true"> ↗</span>
          </a>
        </div>
        <h2 id="example-title" className="d2-example-title">{t('exampleTitle')}</h2>

        <div className="d2-example-roster">
          <Lineup side="radiant" heroes={SAMPLE_RADIANT} />
          <Lineup side="dire" heroes={SAMPLE_DIRE} />
        </div>

        <p className="d2-example-note">{t('exampleNote')}</p>
        <ol className="d2-review-parts">
          {reviewParts.map((part, index) => (
            <li key={part.key}>
              <span className="d2-part-number d2-tnum">0{index + 1}</span>
              <span><strong>{t(part.key)}</strong><small>{t(part.description)}</small></span>
            </li>
          ))}
        </ol>

        <button type="button" onClick={openSample} className="d2-sample-button">
          <span className="d2-tnum">{t('stSample')}</span>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="d2-example-sources">
          <span>{t('sourceMatch')} · <a href={`https://opendota.com/matches/${SAMPLE_MATCH_ID}`} target="_blank" rel="noopener noreferrer">OpenDota</a></span>
          <span>{t('sourceArt')} · <a href="https://www.dota2.com/heroes" target="_blank" rel="noopener noreferrer">Valve / Steam CDN</a></span>
        </div>
      </aside>
    </section>
  );
};

export default EmptyState;
