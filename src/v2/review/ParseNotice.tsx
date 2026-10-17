import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewParseStatus } from '../../types/matchReview';
import { requestMatchParse } from '../../services/dotaApiService';
import { createParseRequestController, shouldOfferParseRequest } from '../../utils/parseRequest';
import { useI18n } from '../i18n/I18nProvider';
import { IconInfo } from './icons';

/** Countdown start for the auto re-check: the server's retryAfterSec, 30s when
 * missing, clamped to 5..600s so a bad value can neither freeze the notice nor
 * spam the refresh. */
export const PARSE_REFRESH_DEFAULT_SEC = 30;
export const parseRefreshCountdownSec = (sec: number | null | undefined): number =>
  sec == null || !Number.isFinite(sec)
    ? PARSE_REFRESH_DEFAULT_SEC
    : Math.min(600, Math.max(5, Math.round(sec)));

/** Statuses a requested parse can sit in while the replay isn't ready yet —
 * the window where the countdown and "Check again" apply. */
const WAITING_STATUSES: ReadonlySet<ReviewParseStatus['status']> = new Set(['requested', 'pending', 'throttled']);

/**
 * Calm replay-parse notice: shown when parse.status is anything but 'parsed'.
 * Offers the existing "Request parse" single-flight action (same endpoint as
 * the legacy review surface) when the status allows it. Once the parse is
 * requested/pending/throttled, counts down from retryAfterSec and re-fetches
 * via onRefresh when it hits zero (or immediately via "Check again").
 */
const ParseNotice: React.FC<{
  matchId: string;
  parse: ReviewParseStatus | null;
  /** Re-fetch the match facts/conclusions for the current hero (no page reload). */
  onRefresh?: () => void;
}> = ({ matchId, parse, onRefresh }) => {
  const { lang, t } = useI18n();
  const [status, setStatus] = useState<ReviewParseStatus | null>(null);
  const [failed, setFailed] = useState(false);
  // Pending must live in React state: reading controller.isPending() during
  // render doesn't subscribe to anything, so the "Requesting…" label would
  // never appear (or never clear) without another render trigger.
  const [pending, setPending] = useState(false);
  // True once our parse request was accepted — gates the "Check again" button.
  const [submitted, setSubmitted] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const parseController = useMemo(
    () => createParseRequestController((id, l, signal) => requestMatchParse(id, l, signal)),
    [],
  );

  // An in-flight parse request outlives nothing: unmount (hero/match change,
  // error path) aborts it, like legacy ReviewEntry — otherwise the request
  // keeps running and its result lands in a dead component.
  useEffect(() => () => parseController.abort(), [parseController]);

  // A fresh server payload (refresh, hero change) supersedes the local
  // request-result snapshot — a 'parsed' refresh must actually clear the notice.
  useEffect(() => {
    setStatus(null);
  }, [parse]);

  // onRefresh may be a new closure every parent render; the countdown effect
  // reads the latest one through a ref so its identity can't reset the timer.
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  const visible = parse != null && parse.status !== 'parsed';
  const shown = status ?? parse;
  const waiting = visible && shown != null && WAITING_STATUSES.has(shown.status);
  const canRefresh = onRefresh != null;

  // While the parse sits in the requested/pending/throttled window, count down
  // from retryAfterSec and re-fetch at zero. A new payload (the refresh
  // landing, a hero change) restarts the countdown with its own value.
  useEffect(() => {
    if (!waiting || !canRefresh) {
      setCountdown(null);
      return undefined;
    }
    let left = parseRefreshCountdownSec(shown?.retryAfterSec);
    setCountdown(left);
    const id = window.setInterval(() => {
      left -= 1;
      if (left > 0) {
        setCountdown(left);
        return;
      }
      window.clearInterval(id);
      setCountdown(null);
      onRefreshRef.current?.();
    }, 1000);
    return () => window.clearInterval(id);
  }, [waiting, canRefresh, shown]);

  if (!visible) return null;

  const request = async () => {
    setFailed(false);
    setPending(true);
    const result = await parseController.request(matchId, lang, t('parseRequestFailed'));
    setPending(false);
    if (!result) return;
    if (result.kind === 'status') {
      setStatus(result.status);
      setSubmitted(true);
    }
    if (result.kind === 'error') setFailed(true);
  };

  return (
    <div className="flex gap-[10px] p-[12px_14px] rounded-[14px] bg-d2-surface-2 text-d2-ink-2 text-d2-15">
      <span className="flex-none mt-[3px]">
        <IconInfo />
      </span>
      <div className="min-w-0">
        <p className="m-0 text-d2-13 font-semibold text-d2-ink-3">{t('parseTitle')}</p>
        <p className="m-[2px_0_0]">{shown!.message}</p>
        {/* While a countdown runs, the parse request is already in flight
            server-side — "Check again" is the action, not another request. */}
        {shouldOfferParseRequest(shown) && countdown == null && (
          <button
            type="button"
            onClick={() => void request()}
            disabled={pending}
            className="mt-[8px] inline-flex items-center min-h-[36px] px-[14px] rounded-d2-control bg-d2-surface border border-d2-line-2 text-d2-13 font-semibold text-d2-ink-2 shadow-d2-1 disabled:opacity-50"
          >
            {pending ? t('parseRequesting') : t('parseRequest')}
          </button>
        )}
        {countdown != null && countdown > 0 && (
          <p className="mt-[6px] mb-0 text-d2-13">{t('parseCheckIn').replace('{n}', String(countdown))}</p>
        )}
        {submitted && canRefresh && (
          <button
            type="button"
            onClick={() => onRefresh!()}
            className="mt-[8px] inline-flex items-center min-h-[36px] px-[14px] rounded-d2-control bg-d2-surface border border-d2-line-2 text-d2-13 font-semibold text-d2-ink-2 shadow-d2-1"
          >
            {t('parseCheckAgain')}
          </button>
        )}
        {failed && <p className="mt-[6px] mb-0 text-d2-13 text-d2-down">{t('parseRequestFailed')}</p>}
      </div>
    </div>
  );
};

export default ParseNotice;
