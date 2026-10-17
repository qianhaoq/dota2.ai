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
 */
const Composer: React.FC<{
  mode?: 'match' | 'followUp';
  disabled?: boolean;
  locked?: boolean;
  onSubmitQuestion?: (value: string) => void;
  onStop?: () => void;
  currentMatchId?: string;
  /** Refill the input after a rejected submit (400 message_too_long keeps the
   * user's text so they can shorten it). A new object re-applies even when the
   * value is unchanged — hence the nonce. */
  restore?: { value: string; nonce: number } | null;
}> = ({ mode = 'match', disabled = false, locked = false, onSubmitQuestion, onStop, currentMatchId, restore }) => {
  const { lang, t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);

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
            placeholder={mode === 'followUp' ? t('followUpPh') : t('inputPh')}
            aria-label={mode === 'followUp' ? t('followUpPh') : t('inputAria')}
            disabled={disabled || locked}
            maxLength={mode === 'followUp' ? FOLLOW_UP_MAX_CHARS : undefined}
            className="flex-1 min-w-0 border-0 outline-none bg-transparent text-d2-15 h-full placeholder:text-d2-ink-4 disabled:opacity-50"
          />
          {disabled && onStop ? (
            <button
              type="button"
              onClick={onStop}
              aria-label={t('stopAria')}
              className="w-[44px] h-[44px] rounded-[12px] bg-d2-ink grid place-items-center flex-none text-d2-surface"
            >
              <IconStop />
            </button>
          ) : (
            <button
              type="submit"
              aria-label={t('sendAria')}
              disabled={!value.trim() || disabled || locked}
              className="w-[44px] h-[44px] rounded-[12px] bg-d2-ink grid place-items-center flex-none transition-opacity duration-d2-fast disabled:opacity-25"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 19V5M5 12l7-7 7 7" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </form>
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
