import type { CaseStudies, CoachReport, RecentMatches } from './types';

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

/** Professional case studies for one player; slow on a cold cache. */
export async function fetchCoachCases(
  matchId: string,
  opts: { slot: number; pos?: number | null; signal?: AbortSignal },
): Promise<CaseStudies> {
  const qs = new URLSearchParams({ slot: String(opts.slot) });
  if (opts.pos != null) qs.set('pos', String(opts.pos));
  const res = await fetch(`/api/coach/${encodeURIComponent(matchId)}/cases?${qs}`, { signal: opts.signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new CoachApiError(body.code ?? 'upstream', body.error ?? `HTTP ${res.status}`, res.status, body.retryAfterSec);
  return body as CaseStudies;
}

/** `provider: 'self_hosted'` when our own parser handled it; `reason: 'replay_gone'` when Valve no longer has the replay. */
export interface ParseStatus { status: string; jobId?: number | null; retryAfterSec?: number | null; message?: string; provider?: string; reason?: string }

/** The budgeted parse-request endpoint (OpenDota, or our own parser when OpenDota is unavailable). */
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

export interface AskTurn { q: string; a: string }
export interface AskEvents { onText: (text: string, fallback: boolean) => void; onNotice?: (notice: string) => void }

/**
 * Follow-up question on one player's report. Streams SSE `data:` frames:
 * `{ text, fallback? }`, `{ notice }`, then `{ done: true }`.
 */
export async function askCoach(
  matchId: string,
  input: { slot: number; pos?: number | null; lang: 'en' | 'zh'; question: string; history: AskTurn[] },
  events: AskEvents,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/coach/${encodeURIComponent(matchId)}/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new CoachApiError(body.code ?? 'upstream', body.error ?? `HTTP ${res.status}`, res.status, body.retryAfterSec);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let msg: { text?: string; fallback?: boolean; notice?: string; done?: boolean };
      try { msg = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (msg.text) events.onText(msg.text, Boolean(msg.fallback));
      if (msg.notice) events.onNotice?.(msg.notice);
      if (msg.done) return;
    }
  }
  // EOF without the terminal frame: a proxy or the server cut the answer.
  throw new CoachApiError('incomplete', 'The answer stream ended early', 0);
}

/** A player's recent games (Steam friend code -> match picker). */
export async function fetchRecentMatches(accountId: string, signal?: AbortSignal): Promise<RecentMatches> {
  const res = await fetch(`/api/coach/players/${encodeURIComponent(accountId)}/recent`, { signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new CoachApiError(body.code ?? 'upstream', body.error ?? `HTTP ${res.status}`, res.status, body.retryAfterSec);
  return body as RecentMatches;
}

/** Hero vs hero brief (pro + public games at a bracket), ready-made lines in both languages. */
export async function fetchMatchup(hero: number, vs: number, rank?: string | null, signal?: AbortSignal): Promise<{ lines: { en: string[]; zh: string[] } }> {
  const q = `hero=${hero}&vs=${vs}${rank ? `&rank=${encodeURIComponent(rank)}` : ''}`;
  const res = await fetch(`/api/coach/matchup?${q}`, { signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new CoachApiError(body.code ?? 'upstream', body.error ?? `HTTP ${res.status}`, res.status);
  return body;
}

/** A validated `dota-coach-ui/2` surface, as `lib/coach/cards.js` emits it. */
export interface CardSurface {
  catalog: string; engine: string; match_id: number; slot: number;
  cards: { id: string; component: string; title: { en: string; zh: string }; authority: string; tone: string; data: Record<string, unknown>; actions: unknown[]; evidence: unknown[] }[];
}

// One request per match+seat per session: switching seats back and forth must
// not spend the caller's rate limit. Failures are not cached (retry later).
const cardsCache = new Map<string, Promise<CardSurface>>();

/** GET /api/coach/:id/cards?seat= — validated (wrong catalog or shape → error, never rendered). */
export function fetchCoachCards(matchId: string, seat: number): Promise<CardSurface> {
  const key = `${matchId}:${seat}`;
  const hit = cardsCache.get(key);
  if (hit) return hit;
  const p = (async () => {
    const res = await fetch(`/api/coach/${encodeURIComponent(matchId)}/cards?seat=${seat}`);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new CoachApiError(body?.code ?? 'upstream', body?.error ?? `HTTP ${res.status}`, res.status, body?.retryAfterSec);
    const { validateSurface } = await import('../../lib/coach/cards.js');
    const surface = validateSurface(body) as CardSurface | null;
    if (!surface) throw new CoachApiError('invalid', 'Unexpected cards payload', res.status);
    return surface;
  })();
  cardsCache.set(key, p);
  p.catch(() => cardsCache.delete(key));
  return p;
}

/** Test hook: forget cached surfaces. */
export function clearCardsCache() { cardsCache.clear(); }
