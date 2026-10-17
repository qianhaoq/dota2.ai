import React from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import V2Shell from '../V2Shell';
import { useI18n } from '../i18n/I18nProvider';

/**
 * `/m/:matchId?hero=&lang=` — placeholder conversational review page in the
 * v2 shell. Reads and displays matchId + hero; the actual review UI lands in
 * a later PR. Non-numeric match IDs get a friendly message.
 */
const MatchPage: React.FC = () => {
  const { matchId } = useParams<{ matchId: string }>();
  const [searchParams] = useSearchParams();
  const { t } = useI18n();
  const hero = searchParams.get('hero');
  const valid = Boolean(matchId && /^\d+$/.test(matchId));

  return (
    <V2Shell>
      {valid ? (
        <section className="py-[20px]">
          <h1 className="text-d2-17 font-semibold tracking-[-0.01em] text-d2-ink m-0">
            {t('matchLabel')} <span className="d2-tnum">{matchId}</span>
            <span className="text-d2-ink-4 font-normal">
              {' · '}
              {t('heroLabel')}: {hero ?? t('noHero')}
            </span>
          </h1>
          <p className="mt-[8px] mb-0 text-d2-15 text-d2-ink-3">{t('reviewPending')}</p>
        </section>
      ) : (
        <section className="py-[20px]">
          <p className="m-0 text-d2-15 text-d2-ink-2 bg-d2-surface rounded-[12px] shadow-d2-1 p-[12px]">
            {t('invalidMatch')}
          </p>
        </section>
      )}
    </V2Shell>
  );
};

export default MatchPage;
