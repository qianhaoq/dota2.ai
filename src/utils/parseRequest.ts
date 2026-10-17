import type { Language } from '../types';
import type { ReviewParseStatus } from '../types/matchReview';

/**
 * Whether the parse-status banner should offer a manual "Request parse"
 * action. Unparsed / failed matches always offer it; pending / throttled only
 * once the server-provided cooldown has elapsed (or was absent). A parse that
 * was just requested or already parsed is left alone.
 */
export function shouldOfferParseRequest(parse: ReviewParseStatus | null | undefined): boolean {
  if (!parse) return false;
  switch (parse.status) {
    case 'unparsed':
    case 'failed':
      return true;
    case 'pending':
    case 'throttled':
      return !(parse.retryAfterSec != null && parse.retryAfterSec > 0);
    default:
      return false;
  }
}

export function isParseAbortError(err: unknown): boolean {
  return (
    typeof err === 'object'
    && err !== null
    && (err as { name?: unknown }).name === 'AbortError'
  );
}

export type ParseRequestFn = (
  matchId: number | string,
  lang: Language,
  signal?: AbortSignal,
) => Promise<ReviewParseStatus>;

export type ParseRequestResult =
  | { kind: 'status'; status: ReviewParseStatus }
  | { kind: 'error'; message: string }
  | { kind: 'aborted' };

export interface ParseRequestController {
  /** True while a parse request is in flight. */
  isPending(): boolean;
  /** Abort the in-flight request (unmount / match change); it resolves as aborted. */
  abort(): void;
  /**
   * Single-flight parse request: while one request is in flight, further
   * calls resolve to null immediately and the helper is NOT invoked again.
   * Server-shaped errors surface their message; anything else (network
   * failure) falls back to the caller's localized failureMessage. matchId may
   * be a string (v2 passes ids through without numeric coercion).
   */
  request(matchId: number | string, lang: Language, failureMessage: string): Promise<ParseRequestResult | null>;
}

export function createParseRequestController(requestFn: ParseRequestFn): ParseRequestController {
  let pending: Promise<ParseRequestResult> | null = null;
  let controller: AbortController | null = null;

  return {
    isPending: () => pending !== null,

    abort() {
      controller?.abort();
    },

    request(matchId, lang, failureMessage) {
      if (pending) return Promise.resolve(null);
      const current = new AbortController();
      controller = current;
      const run = (async (): Promise<ParseRequestResult> => {
        try {
          const status = await requestFn(matchId, lang, current.signal);
          if (current.signal.aborted) return { kind: 'aborted' };
          return { kind: 'status', status };
        } catch (err) {
          if (isParseAbortError(err) || current.signal.aborted) return { kind: 'aborted' };
          const message =
            err instanceof Error && err.name === 'MatchFactsError' && err.message
              ? err.message
              : failureMessage;
          return { kind: 'error', message };
        } finally {
          if (controller === current) controller = null;
          pending = null;
        }
      })();
      pending = run;
      return run;
    },
  };
}
