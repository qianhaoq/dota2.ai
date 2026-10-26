import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n/I18nProvider';
import { buildCarryQuery } from '../carryQuery';
import type { DictKey } from '../i18n/en';

export const SAMPLE_MATCH_ID = '9035042364';

/**
 * Empty state (handoff §1 screen 1): greeting, trust line and three starter
 * chips — sample match / Steam (placeholder) / "What can you tell me".
 */
const EmptyState: React.FC = () => {
  const { lang, t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [notice, setNotice] = useState<DictKey | null>(null);

  const openSample = () => {
    navigate({ pathname: `/m/${SAMPLE_MATCH_ID}`, search: buildCarryQuery(location.search, lang) });
  };

  return (
    <section className="py-[20px]">
      {/* Dota mark logo */}
      <div className="w-[44px] h-[44px] text-d2-gold-2 mb-[16px]" aria-hidden="true">
        <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 5 16 1l13 4v22l-13 4L3 27Z" />
          <path d="m3 5 9 9 8-8 9 9M3 27l9-9 8 8 9-9" />
          <path d="m13 14 7-7 5 5-7 7Z" fill="currentColor" stroke="none" />
        </svg>
      </div>
      <h1 className="text-d2-22 font-semibold tracking-[-0.02em] text-d2-ink m-0 font-serif">{t('emptyH')}</h1>
      <p className="mt-[8px] mb-0 text-d2-15 text-d2-ink-3">{t('emptyP')}</p>

      <div className="flex flex-wrap gap-[8px] mt-[20px]">
        <button
          type="button"
          onClick={openSample}
          className="inline-flex items-center min-h-[44px] px-[14px] rounded-d2-chip bg-d2-surface-2 border border-d2-line text-d2-13 font-medium text-d2-ink-2 shadow-d2-1 transition-colors duration-d2-fast hover:border-d2-gold/50 hover:text-d2-gold-2"
        >
          <span className="d2-tnum">{t('stSample')}</span>
        </button>
        <button
          type="button"
          onClick={() => setNotice('steamRef')}
          className="inline-flex items-center min-h-[44px] px-[14px] rounded-d2-chip bg-d2-surface-2 border border-d2-line text-d2-13 font-medium text-d2-ink-2 shadow-d2-1 transition-colors duration-d2-fast hover:border-d2-gold/50 hover:text-d2-gold-2"
        >
          {t('stSteam')}
        </button>
        <button
          type="button"
          onClick={() => setNotice('whatAns')}
          className="inline-flex items-center min-h-[44px] px-[14px] rounded-d2-chip bg-d2-surface-2 border border-d2-line text-d2-13 font-medium text-d2-ink-2 shadow-d2-1 transition-colors duration-d2-fast hover:border-d2-gold/50 hover:text-d2-gold-2"
        >
          {t('stWhat')}
        </button>
      </div>

      {notice && (
        <p className="mt-[16px] mb-0 text-d2-15 text-d2-ink-2 bg-d2-surface-2 border border-d2-line-2 rounded-[12px] shadow-d2-1 p-[12px]">
          {t(notice)}
        </p>
      )}

      <div className="flex gap-[10px] mt-[16px] p-[12px] rounded-[12px] bg-d2-surface-2 border border-d2-line-2 shadow-d2-1 text-d2-13 text-d2-ink-3">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="flex-none mt-[1px] text-d2-gold" aria-hidden="true">
          <path d="M12 3l7 2.7v5.6c0 4.6-3 8.4-7 9.7-4-1.3-7-5.1-7-9.7V5.7L12 3z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M8.8 12l2.2 2.2 4.3-4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{t('trust')}</span>
      </div>
    </section>
  );
};

export default EmptyState;
