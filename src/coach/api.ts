import type { CoachReport } from './types';

export class CoachApiError extends Error {
  constructor(public code: string, message: string, public status: number, public retryAfterSec?: number) {
    super(message);
  }
}

export async function fetchCoachReport(
  matchId: string,
  opts: { slot?: number; pos?: number; signal?: AbortSignal } = {},
): Promise<CoachReport> {
  const qs = new URLSearchParams();
  if (opts.slot != null && opts.pos != null) {
    qs.set('slot', String(opts.slot));
    qs.set('pos', String(opts.pos));
  }
  const res = await fetch(`/api/coach/${encodeURIComponent(matchId)}${qs.size ? `?${qs}` : ''}`, { signal: opts.signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new CoachApiError(body.code ?? 'upstream', body.error ?? `HTTP ${res.status}`, res.status, body.retryAfterSec);
  }
  return body as CoachReport;
}

export interface ParseStatus { status: string; jobId?: number | null; retryAfterSec?: number | null; message?: string }

/** Reuses the existing budgeted OpenDota parse-request endpoint. */
export async function requestParse(matchId: string, lang: 'en' | 'zh'): Promise<ParseStatus> {
  const res = await fetch(`/api/review/${encodeURIComponent(matchId)}/parse-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !body.status) return { status: 'failed', message: body.error };
  return body as ParseStatus;
}
