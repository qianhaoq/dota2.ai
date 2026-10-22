import React, { useState } from 'react';
import { buildFakedoorSubmission } from '../../utils/fakedoor';
import { trackEvent } from '../../services/analytics';
import { useI18n } from '../i18n/I18nProvider';
import { claimSession } from './analytics';
import { IconInfo } from './icons';

/** sessionStorage marker: the fake-door card is interacted with at most once per session. */
const FAKEDOOR_SESSION_KEY = 'dota2ai.fakedoorV2Dismissed';

/** Empty contact is fine (anonymous interest), but a non-empty one must be a
 * plausible email — local part @ domain with a TLD, no spaces. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FdState = 'open' | 'sending' | 'thanks' | 'error';

/**
 * Light-styled fake-door card (handoff §1 screen 8), equivalent to the legacy
 * FakedoorSteamCTA: same /api/feedback endpoint and payload builder, same
 * `fakedoor_clicked {kind:'steam_autoreview'}` analytics event, max once per
 * session. "$3/mo when it launches. No charge now."
 */
const FakedoorCard: React.FC = () => {
  const { lang, t } = useI18n();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return window.sessionStorage.getItem(FAKEDOOR_SESSION_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [state, setState] = useState<FdState>('open');
  const [contact, setContact] = useState('');
  const [emailError, setEmailError] = useState(false);

  if (dismissed) return null;

  /** Once per session: "Not now" AND a successful submission both count. */
  const markSeen = () => {
    try {
      window.sessionStorage.setItem(FAKEDOOR_SESSION_KEY, '1');
    } catch {
      // sessionStorage unavailable — stays hidden for this mount only.
    }
  };

  const emit = (action: 'notify' | 'dismiss') => {
    if (claimSession('dota2ai.fakedoorV2Clicked')) trackEvent('fakedoor_clicked', { action, kind: 'steam_autoreview' });
  };

  const close = () => {
    emit('dismiss');
    setDismissed(true);
    markSeen();
  };

  const notify = async () => {
    if (state === 'sending' || state === 'thanks') return;
    // A non-empty contact that isn't an email never leaves the card: no
    // request, no analytics event, no session marker — just inline feedback.
    const trimmed = contact.trim();
    if (trimmed && !EMAIL_RE.test(trimmed)) {
      setEmailError(true);
      return;
    }
    setEmailError(false);
    emit('notify');
    setState('sending');
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildFakedoorSubmission(contact, lang)),
      });
      if (!res.ok) throw new Error(`feedback failed: ${res.status}`);
      // The thanks state stays visible for this mount; the marker keeps the
      // card from reappearing on a later remount in the same session.
      markSeen();
      setState('thanks');
    } catch {
      setState('error');
    }
  };

  return (
    <div className="flex gap-[10px] p-[12px] rounded-[12px] bg-d2-surface border border-d2-line-2 shadow-d2-1">
      <span className="flex-none mt-[2px]">
        <IconInfo />
      </span>
      <div className="min-w-0 flex-1">
        <p className="m-0 text-d2-15 font-semibold text-d2-ink">{t('fdTitle')}</p>
        <p className="m-[2px_0_0] text-d2-13 text-d2-ink-3">
          {t('fdBody')} <span className="font-semibold text-d2-ink">{t('fdNoCharge')}</span>
        </p>

        {state === 'thanks' ? (
          <p className="m-[10px_0_0] text-d2-13 font-medium text-d2-up" role="status">
            {contact.trim() ? t('fdThanks') : t('fdThanksAnon')}
          </p>
        ) : (
          <div className="mt-[10px] flex flex-col gap-[8px] sm:flex-row sm:items-center">
            <input
              type="email"
              value={contact}
              onChange={(e) => {
                setContact(e.target.value);
                if (emailError) setEmailError(false);
              }}
              placeholder={t('fdEmailPh')}
              autoComplete="email"
              maxLength={200}
              disabled={state === 'sending'}
              aria-invalid={emailError || undefined}
              className="flex-1 min-w-0 min-h-[40px] px-[12px] rounded-d2-control bg-d2-surface-2 border border-d2-line text-d2-13 text-d2-ink placeholder:text-d2-ink-4 outline-none focus:border-d2-accent disabled:opacity-50"
            />
            <div className="flex gap-[8px]">
              <button
                type="button"
                onClick={() => void notify()}
                disabled={state === 'sending'}
                className="inline-flex items-center justify-center min-h-[40px] px-[14px] rounded-d2-control bg-d2-ink text-d2-surface text-d2-13 font-semibold disabled:opacity-40"
              >
                {state === 'sending' ? t('fdSending') : t('fdNotify')}
              </button>
              <button
                type="button"
                disabled={state === 'sending'}
                onClick={close}
                className="inline-flex items-center justify-center min-h-[40px] px-[14px] rounded-d2-control bg-d2-surface border border-d2-line-2 text-d2-13 font-semibold text-d2-ink-2"
              >
                {t('fdNotNow')}
              </button>
            </div>
          </div>
        )}
        {state === 'error' && <p className="mt-[8px] mb-0 text-d2-13 text-d2-down" role="alert">{t('fdError')}</p>}
        {emailError && <p className="mt-[8px] mb-0 text-d2-13 text-d2-down" role="alert">{t('fdEmailInvalid')}</p>}
      </div>
    </div>
  );
};

export default FakedoorCard;
