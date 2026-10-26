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
 * session. Notify-on-launch only — no price in the copy.
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
    <div className="p-[16px] rounded-[12px] bg-d2-surface-2 border border-d2-gold/30 shadow-d2-2 relative overflow-hidden">
      {/* Decorative gold gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-d2-gold/5 to-transparent pointer-events-none" />
      <div className="relative">
        <div className="flex items-center gap-[8px] mb-[8px]">
          <svg className="w-[20px] h-[20px] text-d2-gold-2" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="16" cy="16" r="14" />
            <path d="m8 19 6-6 5 4 5-7M9 20l5 5" strokeWidth="2" />
            <circle cx="22.5" cy="9.5" r="3" strokeWidth="1.5" />
            <circle cx="9" cy="21" r="2.5" strokeWidth="1.5" />
          </svg>
          <span className="text-d2-gold-2 text-d2-12 font-bold uppercase tracking-wider">{t('fdTitle')}</span>
        </div>
        <p className="m-0 text-d2-15 text-d2-ink-2">
          {t('fdBody')}
        </p>

        {state === 'thanks' ? (
          <p className="m-[12px_0_0] text-d2-13 font-medium text-d2-up" role="status">
            {contact.trim() ? t('fdThanks') : t('fdThanksAnon')}
          </p>
        ) : (
          <div className="mt-[12px] flex flex-col gap-[8px] sm:flex-row sm:items-center">
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
              className="flex-1 min-w-0 min-h-[40px] px-[12px] rounded-d2-control bg-d2-surface-3 border border-d2-line text-d2-13 text-d2-ink placeholder:text-d2-ink-4 outline-none focus:border-d2-gold disabled:opacity-50"
            />
            <div className="flex gap-[8px]">
              <button
                type="button"
                onClick={() => void notify()}
                disabled={state === 'sending'}
                className="inline-flex items-center justify-center min-h-[40px] px-[16px] rounded-d2-control bg-gradient-to-b from-[#ff7159] to-[#ed4e36] text-white text-d2-13 font-bold uppercase tracking-wide shadow-[inset_0_1px_#ffb09f,inset_0_-1px_#9e2819] hover:brightness-110 disabled:opacity-40 transition-all"
                style={{ clipPath: 'polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px))' }}
              >
                {state === 'sending' ? t('fdSending') : t('fdNotify')}
              </button>
              <button
                type="button"
                disabled={state === 'sending'}
                onClick={close}
                className="inline-flex items-center justify-center min-h-[40px] px-[14px] rounded-d2-control bg-d2-surface-3 border border-d2-line text-d2-13 font-semibold text-d2-ink-3 hover:bg-d2-surface-2 hover:text-d2-ink-2 transition-colors"
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
