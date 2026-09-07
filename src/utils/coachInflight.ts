import type { CoachMessage } from '../components/coach/coachMessage';

export const META_FETCH_TIMEOUT_MS = 30_000;
export const SUGGEST_FETCH_TIMEOUT_MS = 30_000;
export const REVIEW_SUGGESTIONS_TIMEOUT_MS = 20_000;

/** User-visible copy when a coach request is cancelled via Stop. */
export function coachCancelledMessage(lang: 'zh' | 'en'): string {
  return lang === 'zh' ? '已停止' : 'Cancelled';
}

/** User-visible copy when a non-stream fetch exceeds its timeout. */
export function coachFetchTimeoutMessage(lang: 'zh' | 'en'): string {
  return lang === 'zh' ? '请求超时，请重试' : 'Request timed out, please try again';
}

/** Abort after `ms`; cleared when `clear()` is called. */
export function createTimeoutAbort(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

/** Race `promise` against a wall-clock timeout (rejects when the timer aborts). */
export async function awaitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const timeout = createTimeoutAbort(timeoutMs);
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        if (timeout.signal.aborted) {
          reject(new Error('timeout'));
          return;
        }
        timeout.signal.addEventListener(
          'abort',
          () => reject(new Error('timeout')),
          { once: true },
        );
      }),
    ]);
  } finally {
    timeout.clear();
  }
}

/** Invalidate in-flight coach work (Stop / supersede). */
export function invalidateCoachInflightGeneration(generationRef: { current: number }): void {
  generationRef.current += 1;
}

/** Claim the next generation after invalidation; returned id must be checked in callbacks. */
export function claimCoachInflightGeneration(generationRef: { current: number }): number {
  const next = generationRef.current + 1;
  generationRef.current = next;
  return next;
}

/** True when `captured` is still the active coach inflight generation. */
export function isCoachInflightCurrent(
  generationRef: { current: number },
  captured: number,
): boolean {
  return generationRef.current === captured;
}

/** Clear streaming flags on all in-flight coach messages (e.g. after Stop). */
export function clearStreamingCoachMessages(
  messages: CoachMessage[],
  cancelledLabel?: string,
): CoachMessage[] {
  let changed = false;
  const next = messages.map((msg) => {
    if (!msg.isStreaming) return msg;
    changed = true;
    return {
      ...msg,
      isStreaming: false,
      ...(cancelledLabel && !msg.content && !msg.error ? { error: cancelledLabel } : {}),
    };
  });
  return changed ? next : messages;
}
