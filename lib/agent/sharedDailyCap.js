/**
 * Shared UTC-daily counter backed by a CAS blob store (GCS `ifGenerationMatch`, #453).
 *
 * One small object per UTC day (`daily-cap.<name>.<YYYY-MM-DD>.json`) keeps the
 * count shared across every Cloud Run instance and across deploys/restarts:
 * - Fast path in memory once today's count reaches `limit` (zero store calls
 *   until the next UTC day).
 * - Optimistic CAS increment (`putIfMatch`) with retries on 412 conflict, and
 *   per-instance serialization so concurrent local callers do not contend with
 *   each other.
 * - **Fail-closed**: if the backing store cannot be read or written (network
 *   error, 5xx, auth failure, or persistent CAS contention), requests are
 *   refused (`reason: 'unavailable'`) rather than admitted without counting,
 *   so an outage can never blow past the daily spend cap.
 */

const NAME = /^[a-z0-9_-]{1,32}$/;
const LOG_INTERVAL_MS = 60_000;

/** UTC calendar day `YYYY-MM-DD` for timestamp `ms`. */
export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole seconds remaining until the next UTC midnight (at least 1). */
export function retryAfterUtcMidnightSec(ms) {
  const d = new Date(ms);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - ms) / 1000));
}

/**
 * @param {{
 *   blobs: { getWithMeta: (key: string) => Promise<{ exists: boolean, body: Buffer | null, generation: string }>, putIfMatch: (key: string, body: Buffer, expectedGeneration: string) => Promise<{ ok: boolean, conflict?: boolean }> },
 *   name: string,
 *   limit: number,
 *   now?: () => number,
 *   maxRetries?: number,
 *   unavailableRetrySec?: number,
 *   log?: (msg: string) => void,
 * }} o
 */
export function createSharedDailyCap({
  blobs,
  name,
  limit,
  now = () => Date.now(),
  maxRetries = 6,
  unavailableRetrySec = 60,
  log = () => {},
}) {
  if (!NAME.test(String(name ?? ''))) throw new Error('invalid_cap_name');
  if (!Number.isFinite(limit) || limit < 1) throw new Error('invalid_cap_limit');
  if (typeof blobs?.getWithMeta !== 'function' || typeof blobs?.putIfMatch !== 'function') {
    throw new Error('cas_blobs_required');
  }

  let cache = { day: '', count: 0 };
  /** Short-lived snapshot read by `check()` so `tryConsume()` can write in one round trip. */
  let snap = null;
  let queue = Promise.resolve();
  let lastErrLogAt = -Infinity;

  const keyFor = (day) => `daily-cap.${name}.${day}.json`;
  const noteError = (op, err) => {
    const t = now();
    if (t - lastErrLogAt < LOG_INTERVAL_MS) return;
    lastErrLogAt = t;
    log(`shared-daily-cap ${name} ${op} failed (${err?.code ?? err?.name ?? 'error'}); failing closed`);
  };
  const parseCount = (buf) => {
    if (!buf) return 0;
    try {
      const parsed = JSON.parse(buf.toString('utf8'));
      const n = Number(parsed?.count);
      return Number.isInteger(n) && n >= 0 ? n : 0;
    } catch {
      return 0;
    }
  };
  const syncCache = (day, count) => {
    if (cache.day !== day) cache = { day, count };
    else if (count > cache.count) cache.count = count;
  };

  async function readState(day) {
    const key = keyFor(day);
    // Download with ifGenerationMatch can race a concurrent writer (412): retry read briefly.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await blobs.getWithMeta(key);
        const count = res.exists ? parseCount(res.body) : 0;
        syncCache(day, count);
        return { ok: true, count, generation: res.generation };
      } catch (err) {
        if (err?.code === 412 && attempt < 2) continue;
        noteError('read', err);
        return { ok: false, reason: 'unavailable', retryAfterSec: unavailableRetrySec };
      }
    }
    return { ok: false, reason: 'unavailable', retryAfterSec: unavailableRetrySec };
  }

  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const enqueue = (fn) => {
    const run = queue.catch(() => {}).then(fn);
    queue = run.catch(() => {});
    return run;
  };

  return {
    isAsync: true,
    /** Synchronous fast-path: true once this instance knows today's shared cap is reached. */
    full(_key = 'all') {
      const day = utcDay(now());
      return cache.day === day && cache.count >= limit;
    },
    retryAfterSec(_key = 'all') {
      return retryAfterUtcMidnightSec(now());
    },
    /**
     * Check whether today's shared cap still has room, reading the store and caching
     * the generation for the immediately following `tryConsume()`. Fails closed on
     * store errors.
     */
    async check(_key = 'all') {
      const t = now();
      const day = utcDay(t);
      if (cache.day === day && cache.count >= limit) {
        return { ok: false, reason: 'daily_cap', retryAfterSec: retryAfterUtcMidnightSec(t) };
      }
      const r = await readState(day);
      if (!r.ok) return r;
      if (r.count >= limit) {
        snap = null;
        return { ok: false, reason: 'daily_cap', retryAfterSec: retryAfterUtcMidnightSec(t) };
      }
      snap = { day, count: r.count, generation: r.generation, at: t };
      return { ok: true, retryAfterSec: 0 };
    },
    /**
     * Atomically consume one slot from today's shared cap via CAS. Fails closed on
     * store errors or exhausted CAS retries.
     * @returns {Promise<{ ok: true, retryAfterSec: number } | { ok: false, reason: 'daily_cap' | 'unavailable', retryAfterSec: number }>}
     */
    tryConsume(_key = 'all') {
      return enqueue(async () => {
        const t0 = now();
        const day0 = utcDay(t0);
        if (cache.day === day0 && cache.count >= limit) {
          return { ok: false, reason: /** @type {'daily_cap'} */ ('daily_cap'), retryAfterSec: retryAfterUtcMidnightSec(t0) };
        }
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
          const t = now();
          const day = utcDay(t);
          if (cache.day === day && cache.count >= limit) {
            return { ok: false, reason: /** @type {'daily_cap'} */ ('daily_cap'), retryAfterSec: retryAfterUtcMidnightSec(t) };
          }
          let count;
          let generation;
          if (attempt === 0 && snap && snap.day === day && t - snap.at < 2000) {
            ({ count, generation } = snap);
            snap = null;
          } else {
            snap = null;
            const r = await readState(day);
            if (!r.ok) return { ok: false, reason: /** @type {'unavailable'} */ ('unavailable'), retryAfterSec: r.retryAfterSec };
            ({ count, generation } = r);
          }
          if (count >= limit) {
            syncCache(day, count);
            return { ok: false, reason: /** @type {'daily_cap'} */ ('daily_cap'), retryAfterSec: retryAfterUtcMidnightSec(t) };
          }
          const next = count + 1;
          const body = Buffer.from(JSON.stringify({ day, count: next, updated_at: t }));
          try {
            const put = await blobs.putIfMatch(keyFor(day), body, generation);
            if (put.ok) {
              syncCache(day, next);
              return { ok: true, retryAfterSec: 0 };
            }
            // 412 CAS conflict: another instance updated the day's counter; re-read and retry.
          } catch (err) {
            noteError('write', err);
            return { ok: false, reason: /** @type {'unavailable'} */ ('unavailable'), retryAfterSec: unavailableRetrySec };
          }
        }
        noteError('contention', { code: 'cas_retries_exhausted' });
        return { ok: false, reason: /** @type {'unavailable'} */ ('unavailable'), retryAfterSec: unavailableRetrySec };
      });
    },
  };
}
