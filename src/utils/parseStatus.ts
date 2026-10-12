import type { Language } from '../types';
import type { ReviewParseStatus } from '../types/matchReview';

const REVIEW_PARSE_STATUSES: ReadonlySet<string> = new Set([
  'requested',
  'pending',
  'parsed',
  'failed',
  'throttled',
]);

/**
 * Extract the OpenDota parse status from a /api/review payload (GET JSON body,
 * POST JSON result, or an SSE facts event). Returns null when absent/invalid —
 * parse status is optional and must never break the review flow.
 */
export function parseReviewParseStatus(raw: unknown): ReviewParseStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.status !== 'string' || !REVIEW_PARSE_STATUSES.has(obj.status)) return null;
  return {
    status: obj.status as ReviewParseStatus['status'],
    jobId: typeof obj.jobId === 'number' && Number.isFinite(obj.jobId) ? obj.jobId : null,
    retryAfterSec:
      typeof obj.retryAfterSec === 'number' && Number.isFinite(obj.retryAfterSec)
        ? obj.retryAfterSec
        : null,
    message: typeof obj.message === 'string' ? obj.message : '',
  };
}

/** Banner is shown for anything that is not fully parsed replay data. */
export function shouldShowParseStatusBanner(parse: ReviewParseStatus | null | undefined): boolean {
  return Boolean(parse) && parse!.status !== 'parsed';
}

/** Bilingual "retry in ~N s" hint shown under the server message. */
export function parseRetryAfterLabel(lang: Language, retryAfterSec: number | null): string | null {
  if (retryAfterSec == null || retryAfterSec <= 0) return null;
  const sec = Math.round(retryAfterSec);
  return lang === 'zh' ? `约 ${sec} 秒后可重试` : `Retry in ~${sec}s`;
}
