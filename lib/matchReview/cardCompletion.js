/**
 * Card-review completion across an ordered provider chain (DeepSeek, then
 * Gemini). Each provider attempt runs under its own app-owned deadline capped
 * by the request-wide budget. A provider whose transport fails (deadline,
 * network, 4xx/5xx) is skipped for the rest of the request, so the
 * validation retry goes straight to the provider that last answered.
 * Client disconnects are rethrown untouched.
 */
import { withCompletionDeadline, cardAttemptDeadlineMs } from '../completionDeadline.js';
import { isClientAbortError } from './parseRequestSubmit.js';

/**
 * @typedef {{ name: string, create: (signal: AbortSignal) => Promise<any> }} CardProvider
 */

/**
 * @param {{
 *   providers: CardProvider[],
 *   failed: Set<string>,
 *   startedAt: number,
 *   budgetMs: number,
 *   perAttemptMs: number,
 *   minAttemptMs: number,
 *   signal?: AbortSignal,
 *   now?: () => number,
 *   onProviderError?: (info: { provider: string, error: string }) => void,
 * }} opts
 * @returns {Promise<{ text: string, provider: string }>}
 */
export async function requestCardCompletion(opts) {
  const now = opts.now ?? Date.now;
  let lastErr = null;
  for (const p of opts.providers) {
    if (opts.failed.has(p.name)) continue;
    const ms = cardAttemptDeadlineMs({
      startedAt: opts.startedAt,
      now: now(),
      budgetMs: opts.budgetMs,
      perAttemptMs: opts.perAttemptMs,
      minAttemptMs: opts.minAttemptMs,
    });
    if (ms === 0) {
      // Request budget exhausted before this provider was tried: not a
      // provider failure, so do not mark or report it.
      const e = new Error('card request budget exhausted');
      e.name = 'CompletionDeadlineError';
      throw e;
    }
    try {
      const res = await withCompletionDeadline((signal) => p.create(signal), { ms, signal: opts.signal });
      return { text: res?.choices?.[0]?.message?.content || '', provider: p.name };
    } catch (err) {
      if (isClientAbortError(err, opts.signal)) throw err;
      opts.failed.add(p.name);
      // `raw` lets the caller log provider/status/error class with a redacted
      // message (lib/llmErrors.js) instead of just the classified category.
      opts.onProviderError?.({ provider: p.name, error: err?.name === 'CompletionDeadlineError' ? 'deadline' : (err?.status ? `http_${err.status}` : (err?.name || 'error')), raw: err });
      lastErr = err;
    }
  }
  const e = lastErr || new Error('no card provider available');
  if (!lastErr) e.name = 'NoCardProviderError';
  throw e;
}
