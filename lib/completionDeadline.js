import { combineAbortSignals } from './abortSignals.js';

/**
 * Run `fn(signal)` under an application-owned deadline that stays armed until
 * `fn` settles (including non-streaming body parsing, which the OpenAI SDK's
 * own `timeout` does not cover once headers arrive). On expiry the signal is
 * aborted (cancelling upstream work) and a CompletionDeadlineError is thrown,
 * distinct from a client-disconnect abort so callers can serve fallback.
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} fn
 * @param {{ ms: number, signal?: AbortSignal }} opts
 * @returns {Promise<T>}
 */
export async function withCompletionDeadline(fn, { ms, signal }) {
  const deadline = new AbortController();
  let expired = false;
  let rejectDeadline;
  const deadlinePromise = new Promise((_, reject) => { rejectDeadline = reject; });
  deadlinePromise.catch(() => {});
  const timer = setTimeout(() => {
    expired = true;
    deadline.abort();
    const err = new Error(`completion deadline exceeded (${ms}ms)`);
    err.name = 'CompletionDeadlineError';
    rejectDeadline(err);
  }, ms);
  try {
    const combined = combineAbortSignals([signal, deadline.signal]);
    return await Promise.race([fn(combined), deadlinePromise]);
  } catch (err) {
    if (expired && !signal?.aborted) {
      const e = new Error(`completion deadline exceeded (${ms}ms)`);
      e.name = 'CompletionDeadlineError';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
