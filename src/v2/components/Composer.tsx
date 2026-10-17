import React, { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { parseMatchId } from '../../utils/parseMatchId';
import { useI18n } from '../i18n/I18nProvider';
import { buildCarryQuery } from '../carryQuery';

/**
 * Sticky bottom composer (handoff §3). Submitting a numeric match ID or an
 * opendota/dotabuff/stratz match link navigates to /m/:id preserving lang.
 */
const Composer: React.FC = () => {
  const { lang, t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const id = parseMatchId(value);
    if (id) {
      setError(false);
      setValue('');
      navigate({ pathname: `/m/${id}`, search: buildCarryQuery(location.search, lang) });
    } else {
      setError(true);
    }
  };

  return (
    <div className="flex-none bg-gradient-to-b from-transparent to-d2-bg pt-[10px] pb-[calc(12px+env(safe-area-inset-bottom))]">
      <div className="max-w-d2-chat mx-auto px-[16px]">
        {error && (
          <p role="alert" className="text-d2-13 text-d2-down mb-[8px]">
            {t('notMatch')}
          </p>
        )}
        <form
          onSubmit={submit}
          autoComplete="off"
          className="flex items-center gap-[8px] h-[52px] pl-[16px] pr-[6px] bg-d2-surface border border-d2-line-2 rounded-d2-card shadow-d2-2 focus-within:border-[#A5B4FC]"
        >
          <input
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(false);
            }}
            placeholder={t('inputPh')}
            aria-label={t('inputAria')}
            className="flex-1 min-w-0 border-0 outline-none bg-transparent text-d2-15 h-full placeholder:text-d2-ink-4"
          />
          <button
            type="submit"
            aria-label={t('sendAria')}
            disabled={!value.trim()}
            className="w-[44px] h-[44px] rounded-[12px] bg-d2-ink grid place-items-center flex-none transition-opacity duration-d2-fast disabled:opacity-25"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 19V5M5 12l7-7 7 7" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
};

export default Composer;
