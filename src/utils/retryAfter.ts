/**
 * Parse rate-limit (`Retry-After`) hints for HTTP 429 responses (server PR
 * #89). The header is either delay-seconds ("30") or an HTTP-date
 * ("Wed, 21 Oct 2026 07:28:00 GMT"); the JSON body may carry a
 * `{ retryAfterSec: n }` fallback when the header is absent or garbage.
 * Everything is clamped to a sane 1..3600s window so a hostile or broken
 * value can neither freeze the UI for hours nor trip it into a busy loop.
 */
export const RETRY_AFTER_MIN_SEC = 1;
export const RETRY_AFTER_MAX_SEC = 3600;

export const clampRetryAfterSec = (seconds: number): number => {
  if (!Number.isFinite(seconds)) return RETRY_AFTER_MIN_SEC;
  return Math.min(RETRY_AFTER_MAX_SEC, Math.max(RETRY_AFTER_MIN_SEC, Math.ceil(seconds)));
};

/** Delay-seconds or HTTP-date header → clamped whole seconds, or null when unparseable. */
export const parseRetryAfterHeader = (
  value: string | null | undefined,
  now: number = Date.now(),
): number | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return clampRetryAfterSec(Number(trimmed));
  // Negative delay-seconds is not a valid value — don't let V8's lenient
  // Date.parse accept it as a (way past) HTTP-date.
  if (/^-\d/.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  if (!Number.isNaN(at)) return clampRetryAfterSec((at - now) / 1000);
  return null;
};

/** Header first, then the body's `retryAfterSec`, then give up (null = wait unknown). */
export const retryAfterFrom = (
  header: string | null | undefined,
  bodyValue: unknown,
  now: number = Date.now(),
): number | null => {
  const fromHeader = parseRetryAfterHeader(header, now);
  if (fromHeader != null) return fromHeader;
  if (typeof bodyValue === 'number' && Number.isFinite(bodyValue)) {
    return clampRetryAfterSec(bodyValue);
  }
  return null;
};
