import { ACCOUNT_STORAGE_KEY, PROFILE_CHANGED_EVENT, REVIEWED_STORAGE_KEY, SEEN_STORAGE_KEY } from '../../../../src/coach/accountInput';
import { GOAL_CHECKS_STORAGE_KEY, GOAL_STORAGE_KEY } from '../../../../src/coach/goalStore';

export interface DshRemoteRequest {
  method?: string;
  url: string;
  body?: string | null;
}

export interface DshRemoteResponse {
  status: number;
  body: unknown;
  retryAfterSec?: number;
}

export interface DshUserProfile {
  accountId: string | null;
  reviewed: string[];
  seenUntil: number | null;
  goal: Record<string, unknown> | null;
  goalChecks: Record<string, unknown>[];
}

export interface Dota2AiClientRemote {
  request(
    req: DshRemoteRequest,
    signal?: AbortSignal,
  ): Promise<{ ok: true; value: DshRemoteResponse } | { ok: false; error: Error }>;
  stream(
    req: DshRemoteRequest,
    signal?: AbortSignal,
  ): AsyncIterable<Record<string, unknown>>;
  getProfile(): Promise<{ ok: true; value: DshUserProfile } | { ok: false; error: Error }>;
  saveProfile(
    patch: Partial<DshUserProfile>,
  ): Promise<{ ok: true; value: DshUserProfile } | { ok: false; error: Error }>;
}

const STREAM_ROUTE = /^\/api\/(?:agent\/[^/]+\/chat|coach\/[^/]+\/ask|patch\/chat)(?:\?|$)/;

/**
 * Convert `runtimeFetch(url, init)` calls from `src/agent/api.ts`, `src/coach/api.ts`,
 * and `src/patch/api.ts` into DSH Typert Remote invocations (`dsh web` WS & Electron IPC).
 */
export function createDshApiFetch(remote: Dota2AiClientRemote): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : init?.body != null ? String(init.body) : null;
    const signal = init?.signal ?? undefined;

    if (method === 'POST' && STREAM_ROUTE.test(input)) {
      const encoder = new TextEncoder();
      const abort = new AbortController();
      if (signal) {
        if (signal.aborted) abort.abort(signal.reason);
        else signal.addEventListener('abort', () => abort.abort(signal.reason), { once: true });
      }
      const iterator = (signal ? remote.stream({ method, url: input, body }, abort.signal) : remote.stream({ method, url: input, body }))[Symbol.asyncIterator]();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await iterator.next();
            if (next.done) {
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
          } catch (err) {
            if (abort.signal.aborted) {
              controller.error(err);
              return;
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: 'failed' })}\n\ndata: ${JSON.stringify({ done: true })}\n\n`));
            controller.close();
          }
        },
        async cancel() {
          abort.abort();
          await iterator.return?.().catch(() => {});
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      });
    }

    const reqPayload: DshRemoteRequest = { method, url: input, ...(body !== null ? { body } : {}) };
    const result = signal ? await remote.request(reqPayload, signal) : await remote.request(reqPayload);
    if (!result.ok) {
      return new Response(JSON.stringify({ code: 'upstream', error: result.error.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (result.value.retryAfterSec != null) {
      headers.set('Retry-After', String(result.value.retryAfterSec));
    }
    return new Response(JSON.stringify(result.value.body ?? {}), {
      status: result.value.status,
      headers,
    });
  };
}

/**
 * Hydrate browser `localStorage` from `$DSH_HOME/dota2ai/profile.json` and mirror
 * subsequent changes back so Steam account, reviewed matches, and training goals
 * survive `dsh web` random port changes and sync with `dota2ai_goal_check`.
 */
export async function mountProfileSync(remote: Dota2AiClientRemote): Promise<() => void> {
  try {
    const res = await remote.getProfile();
    if (res.ok && typeof window !== 'undefined' && window.localStorage) {
      const p = res.value;
      if (p.accountId) window.localStorage.setItem(ACCOUNT_STORAGE_KEY, p.accountId);
      if (Array.isArray(p.reviewed) && p.reviewed.length > 0) {
        window.localStorage.setItem(REVIEWED_STORAGE_KEY, JSON.stringify(p.reviewed));
      }
      if (typeof p.seenUntil === 'number' && p.seenUntil > 0) {
        window.localStorage.setItem(SEEN_STORAGE_KEY, String(p.seenUntil));
      }
      if (p.goal) {
        window.localStorage.setItem(GOAL_STORAGE_KEY, JSON.stringify(p.goal));
      }
      if (Array.isArray(p.goalChecks) && p.goalChecks.length > 0) {
        window.localStorage.setItem(GOAL_CHECKS_STORAGE_KEY, JSON.stringify(p.goalChecks));
      }
    }
  } catch {
    // Non-fatal: page still works with in-browser storage.
  }

  if (typeof window === 'undefined') return () => {};

  const pushSnapshot = () => {
    try {
      const s = window.localStorage;
      const accountId = s.getItem(ACCOUNT_STORAGE_KEY) || null;
      const reviewed = JSON.parse(s.getItem(REVIEWED_STORAGE_KEY) || '[]');
      const seenRaw = Number(s.getItem(SEEN_STORAGE_KEY));
      const seenUntil = Number.isFinite(seenRaw) && seenRaw > 0 ? seenRaw : null;
      const goalRaw = s.getItem(GOAL_STORAGE_KEY);
      const goal = goalRaw ? JSON.parse(goalRaw) : null;
      const checksRaw = s.getItem(GOAL_CHECKS_STORAGE_KEY);
      const goalChecks = checksRaw ? JSON.parse(checksRaw) : [];
      void remote.saveProfile({
        accountId,
        reviewed: Array.isArray(reviewed) ? reviewed : [],
        seenUntil,
        goal,
        goalChecks: Array.isArray(goalChecks) ? goalChecks : [],
      });
    } catch {
      // Ignore storage serialization errors.
    }
  };

  const events = [PROFILE_CHANGED_EVENT, 'dota2ai:goal', 'dota2ai:goal-checks'];
  for (const ev of events) window.addEventListener(ev, pushSnapshot);
  return () => {
    for (const ev of events) window.removeEventListener(ev, pushSnapshot);
  };
}
