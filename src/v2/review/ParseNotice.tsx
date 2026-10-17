import React, { useMemo, useState } from 'react';
import type { ReviewParseStatus } from '../../types/matchReview';
import { requestMatchParse } from '../../services/dotaApiService';
import { createParseRequestController, shouldOfferParseRequest } from '../../utils/parseRequest';
import { useI18n } from '../i18n/I18nProvider';
import { IconInfo } from './icons';

/**
 * Calm replay-parse notice: shown when parse.status is anything but 'parsed'.
 * Offers the existing "Request parse" single-flight action (same endpoint as
 * the legacy review surface) when the status allows it.
 */
const ParseNotice: React.FC<{ matchId: string; parse: ReviewParseStatus | null }> = ({ matchId, parse }) => {
  const { lang, t } = useI18n();
  const [status, setStatus] = useState<ReviewParseStatus | null>(null);
  const [failed, setFailed] = useState(false);
  // Pending must live in React state: reading controller.isPending() during
  // render doesn't subscribe to anything, so the "Requesting…" label would
  // never appear (or never clear) without another render trigger.
  const [pending, setPending] = useState(false);
  const parseController = useMemo(
    () => createParseRequestController((id, l, signal) => requestMatchParse(id, l, signal)),
    [],
  );

  if (!parse || parse.status === 'parsed') return null;
  const shown = status ?? parse;

  const request = async () => {
    setFailed(false);
    setPending(true);
    const result = await parseController.request(matchId, lang, t('parseRequestFailed'));
    setPending(false);
    if (!result) return;
    if (result.kind === 'status') setStatus(result.status);
    if (result.kind === 'error') setFailed(true);
  };

  return (
    <div className="flex gap-[10px] p-[12px_14px] rounded-[14px] bg-d2-surface-2 text-d2-ink-2 text-d2-15">
      <span className="flex-none mt-[3px]">
        <IconInfo />
      </span>
      <div className="min-w-0">
        <p className="m-0 text-d2-13 font-semibold text-d2-ink-3">{t('parseTitle')}</p>
        <p className="m-[2px_0_0]">{shown.message}</p>
        {shouldOfferParseRequest(shown) && (
          <button
            type="button"
            onClick={() => void request()}
            disabled={pending}
            className="mt-[8px] inline-flex items-center min-h-[36px] px-[14px] rounded-d2-control bg-d2-surface border border-d2-line-2 text-d2-13 font-semibold text-d2-ink-2 shadow-d2-1 disabled:opacity-50"
          >
            {pending ? t('parseRequesting') : t('parseRequest')}
          </button>
        )}
        {failed && <p className="mt-[6px] mb-0 text-d2-13 text-d2-down">{t('parseRequestFailed')}</p>}
      </div>
    </div>
  );
};

export default ParseNotice;
