import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n/I18nProvider';
import { buildCarryQuery } from '../carryQuery';
import { parseMatchInput } from '../parseMatchInput';
import { IconStop } from '../review/icons';

/**
 * Follow-up text caps (backend contract): the composer refuses input past
 * FOLLOW_UP_MAX_CHARS and MatchPage hard-slices before sending (pastes can
 * bypass maxLength). The counter turns on near the limit.
 */
export const FOLLOW_UP_MAX_CHARS = 2000;
export const FOLLOW_UP_COUNTER_FROM = 1800;

/**
 * Sticky bottom composer (handoff §3). In match mode, submitting a numeric
 * match ID or an opendota/dotabuff/stratz link navigates to /m/:id preserving
 * lang. In follow-up mode (MatchPage), a *different* match id/link still
 * navigates; anything else is sent to the page as a follow-up question. While
 * a stream is in flight the input disables and the send button becomes Stop;
 * `locked` (429 countdown) disables submit without switching to Stop.
 * The home uses the same parser and navigation in the non-sticky hero variant.
 */
const Composer: React.FC<{
  mode?: 'match' | 'followUp';
  variant?: 'compact' | 'hero';
  disabled?: boolean;
  locked?: boolean;
  onSubmitQuestion?: (value: string) => void;
  onStop?: () => void;
  currentMatchId?: string;
  /** Refill the input after a rejected submit (400 message_too_long keeps the
   * user's text so they can shorten it). A new object re-applies even when the
   * value is unchanged — hence the nonce. */
  restore?: { value: string; nonce: number } | null;
}> = ({ mode = 'match', variant = 'compact', disabled = false, locked = false, onSubmitQuestion, onStop, currentMatchId, restore }) => {
  const { lang, t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  const hero = variant === 'hero';

  useEffect(() => {
    if (restore) setValue(restore.value);
  }, [restore]);

  const goToMatch = (id: string) => {
    setValue('');
    setError(false);
    navigate({ pathname: `/m/${id}`, search: buildCarryQuery(location.search, lang) });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const id = parseMatchInput(trimmed);

    if (mode === 'followUp' && onSubmitQuestion) {
      // A pasted different match id/link starts a new review instead.
      if (id && id !== currentMatchId) {
        goToMatch(id);
        return;
      }
      setValue('');
      setError(false);
      onSubmitQuestion(trimmed);
      return;
    }

    if (id) {
      goToMatch(id);
    } else {
      setError(true);
    }
  };

  const describedBy = hero && error ? 'home-match-error' : undefined;

  return (
    <div className={hero ? 'd2-home-composer' : 'flex-none bg-gradient-to-t from-d2-bg via-d2-bg/95 to-transparent pt-[10px] pb-[calc(12px+env(safe-area-inset-bottom))]'}>
      <div className={hero ? undefined : 'max-w-d2-chat mx-auto px-[16px]'}>
        {hero && <label className="d2-home-input-label" htmlFor="home-match-input">{t('homeInputLabel')}</label>}
        {!hero && error && (
          <p role="alert" className="text-d2-13 text-d2-down mb-[8px]">
            {t('notMatch')}
          </p>
        )}
        <form
          onSubmit={submit}
          autoComplete="off"
          className={hero
            ? 'd2-home-form'
            : 'flex items-center gap-[8px] h-[52px] pl-[16px] pr-[6px] bg-d2-surface-2 border border-d2-line rounded-d2-card shadow-d2-2 focus-within:border-d2-gold/50'}
        >
          <input
            id={hero ? 'home-match-input' : undefined}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(false);
            }}
            placeholder={mode === 'followUp' ? t('followUpPh') : t('inputPh')}
            aria-label={hero ? t('homeInputLabel') : mode === 'followUp' ? t('followUpPh') : t('inputAria')}
            aria-describedby={describedBy}
            aria-invalid={error || undefined}
            disabled={disabled || locked}
            maxLength={mode === 'followUp' ? FOLLOW_UP_MAX_CHARS : undefined}
            autoCapitalize="none"
            spellCheck={false}
            className={hero
              ? 'd2-home-input'
              : 'flex-1 min-w-0 border-0 outline-none bg-transparent text-d2-15 text-d2-ink h-full placeholder:text-d2-ink-4 disabled:opacity-50'}
          />
          {disabled && onStop ? (
            <button
              type="button"
              onClick={onStop}
              aria-label={t('stopAria')}
              className="w-[44px] h-[44px] rounded-[12px] bg-d2-coral grid place-items-center flex-none text-white hover:brightness-110 transition-all"
            >
              <IconStop />
            </button>
          ) : hero ? (
            <button type="submit" className="d2-home-submit" disabled={!value.trim() || disabled || locked}>
              <span>{t('reviewMatch')}</span>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : (
            <button
              type="submit"
              aria-label={t('sendAria')}
              disabled={!value.trim() || disabled || locked}
              className="w-[44px] h-[44px] border-l border-d2-line-2 grid place-items-center flex-none text-d2-gold-2 transition-colors duration-d2-fast hover:text-d2-gold-pale disabled:text-d2-disabled disabled:opacity-40"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </form>
        {hero && error && <p id="home-match-error" role="alert" className="d2-home-input-error">{t('notMatch')}</p>}
        {mode === 'followUp' && value.length > FOLLOW_UP_COUNTER_FROM && (
          <p className="m-0 mt-[4px] text-right text-d2-12 text-d2-ink-4">
            {t('charCounter')
              .replace('{count}', String(value.length))
              .replace('{max}', String(FOLLOW_UP_MAX_CHARS))}
          </p>
        )}
      </div>
    </div>
  );
};

export default Composer;
