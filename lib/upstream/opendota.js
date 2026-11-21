/**
 * The one way out to api.opendota.com.
 *
 * - API key on every request when OPENDOTA_API_KEY is set (never logged).
 * - Instance token bucket (OPENDOTA_RPM): page requests a user is waiting on
 *   ('high') go before background work ('low': pro cases, meta stats).
 * - Identical GETs in flight share one upstream request.
 * - 429/503 honour Retry-After. A 429 opens a cooldown: until it ends, calls
 *   fail fast with a 429 instead of hitting OpenDota again, so callers fall
 *   back to the stale data they already keep. The cooldown can be shared
 *   across instances (see `cooldown` below).
 * - Counters for /api/health/upstream: calls per endpoint, statuses, 429s,
 *   merged requests, queue waits, and OpenDota's own remaining-quota headers.
 *
 * Errors carry { status, retryable, upstream: 'opendota' } like the old
 * fetchWithRetry, so mapOpenDotaFetchError and every stale-on-error path keep
 * working unchanged.
 */

export const OPENDOTA_BASE = 'https://api.opendota.com/api';

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Path with ids collapsed, for per-endpoint counters: /matches/:id */
export function endpointOf(url) {
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\/api/, '').replace(/\/\d+(?=\/|$)/g, '/:id') || '/';
  } catch {
    return 'invalid';
  }
}

/** URL without its query string (where the key lives), for logs. */
export function redact(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url).split('?')[0];
  }
}

/** Retry-After as milliseconds (seconds or an HTTP date), or null. */
export function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const s = Number(value);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

export function withKey(url, apiKey) {
  if (!apiKey) return url;
  const u = new URL(url);
  if (!u.searchParams.has('api_key')) u.searchParams.set('api_key', apiKey);
  return u.toString();
}

function upstreamError(message, { status, retryable, retryAfterSec, cause } = {}) {
  const err = new Error(message, cause ? { cause } : undefined);
  if (status != null) err.status = status;
  err.retryable = retryable ?? (status != null ? RETRYABLE.has(status) : true);
  err.upstream = 'opendota';
  if (retryAfterSec != null) err.retryAfterSec = retryAfterSec;
  return err;
}

/** Resolve with `p`, or reject when `signal` aborts first (the shared request goes on for others). */
function raceAbort(p, signal) {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

/**
 * Local cooldown store. A shared one (PR: GCS-backed) has the same shape:
 * get() → until (ms epoch) or 0, possibly cached; set(until, reason).
 */
export function createLocalCooldown() {
  let until = 0;
  return { get: () => until, set: (t) => { until = Math.max(until, t); } };
}

/**
 * @param {{
 *   apiKey?: string,
 *   rpm?: number,                 // requests per minute for this instance
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   cooldown?: { get: () => number | Promise<number>, set: (until: number, reason?: string) => void | Promise<void> },
 *   maxRetryWaitMs?: number,      // longest Retry-After we wait in place; longer ones fail fast
 *   maxQueueWaitMs?: number,      // a request queued longer than this fails with 429 (stale data instead)
 *   log?: (msg: string) => void,
 * }} [options]
 */
export function createOpenDotaClient(options = {}) {
  const apiKey = options.apiKey || '';
  const rpm = options.rpm > 0 ? options.rpm : (apiKey ? 1200 : 50);
  const fetchImpl = options.fetchImpl ?? ((...a) => fetch(...a));
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const cooldown = options.cooldown ?? createLocalCooldown();
  const maxRetryWaitMs = options.maxRetryWaitMs ?? 8000;
  const maxQueueWaitMs = options.maxQueueWaitMs ?? 15000;
  const log = options.log ?? (() => {});

  // ---- token bucket ----
  const capacity = Math.max(3, Math.round(rpm / 10));
  const perMs = rpm / 60000;
  let tokens = capacity;
  let refilledAt = now();
  const queues = { high: [], low: [] };
  let timer = null;
  const refill = () => {
    const t = now();
    tokens = Math.min(capacity, tokens + (t - refilledAt) * perMs);
    refilledAt = t;
  };
  const pump = () => {
    timer = null;
    refill();
    for (const q of [queues.high, queues.low]) {
      while (q.length && tokens >= 1) {
        tokens -= 1;
        q.shift().resolve();
      }
    }
    if (queues.high.length || queues.low.length) {
      timer = setTimeout(pump, Math.max(5, Math.ceil((1 - tokens) / perMs)));
    }
  };
  const acquire = (priority) => {
    refill();
    const q = priority === 'low' ? queues.low : queues.high;
    if (!queues.high.length && (priority === 'low' ? !queues.low.length : true) && tokens >= 1) {
      tokens -= 1;
      return Promise.resolve(0);
    }
    const queuedAt = now();
    return new Promise((resolve, reject) => {
      const entry = { resolve: () => { clearTimeout(entry.expire); resolve(now() - queuedAt); } };
      entry.expire = setTimeout(() => {
        const i = q.indexOf(entry);
        if (i >= 0) q.splice(i, 1);
        stats.queueTimeouts += 1;
        reject(upstreamError('HTTP 429', { status: 429, retryAfterSec: Math.ceil(maxQueueWaitMs / 1000) }));
      }, maxQueueWaitMs);
      q.push(entry);
      if (!timer) timer = setTimeout(pump, Math.max(5, Math.ceil((1 - tokens) / perMs)));
    });
  };

  // ---- counters ----
  const stats = {
    calls: 0, merged: 0, cooldownRejects: 0, queueTimeouts: 0, queueWaitMs: 0,
    status: {}, endpoints: {}, rateLimited: 0, lastRateLimitAt: null,
    remaining: { minute: null, day: null, at: null },
  };
  const bump = (endpoint, key) => {
    const e = stats.endpoints[endpoint] ?? (stats.endpoints[endpoint] = { calls: 0, errors: 0, rateLimited: 0 });
    e[key] += 1;
  };

  const inflight = new Map();

  async function once(url, { retries, delay, timeoutMs, priority }) {
    const endpoint = endpointOf(url);
    const keyed = withKey(url, apiKey);
    const failIfCooling = async () => {
      const until = await cooldown.get();
      if (until > now()) {
        stats.cooldownRejects += 1;
        throw upstreamError('HTTP 429', { status: 429, retryAfterSec: Math.ceil((until - now()) / 1000) });
      }
    };
    for (let attempt = 0; attempt <= retries; attempt++) {
      await failIfCooling();
      stats.queueWaitMs += await acquire(priority);
      // A 429 elsewhere may have opened a cooldown while this one waited for a token.
      await failIfCooling();
      stats.calls += 1;
      bump(endpoint, 'calls');
      const started = now();
      let res;
      try {
        res = await fetchImpl(keyed, timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {});
      } catch (err) {
        bump(endpoint, 'errors');
        log(`${redact(url)} attempt=${attempt + 1}/${retries + 1} status=network latencyMs=${now() - started} error=${err?.name || 'Error'}`);
        if (attempt === retries) throw upstreamError(err?.name === 'TimeoutError' ? 'OpenDota timeout' : 'OpenDota fetch failed', { cause: err });
        await sleep(delay * 2 ** attempt);
        continue;
      }
      stats.status[res.status] = (stats.status[res.status] ?? 0) + 1;
      const rm = res.headers?.get?.('x-rate-limit-remaining-minute');
      const rd = res.headers?.get?.('x-rate-limit-remaining-day');
      if (rm != null || rd != null) stats.remaining = { minute: rm != null ? Number(rm) : null, day: rd != null ? Number(rd) : null, at: new Date(now()).toISOString() };
      if (res.ok) {
        // The body can still fail (timeout, disconnect, bad JSON): retry it like a network error.
        try {
          const body = await res.json();
          if (attempt > 0) log(`${redact(url)} attempt=${attempt + 1}/${retries + 1} status=${res.status} ok`);
          return body;
        } catch (err) {
          bump(endpoint, 'errors');
          log(`${redact(url)} attempt=${attempt + 1}/${retries + 1} status=${res.status} body_error=${err?.name || 'Error'}`);
          if (attempt === retries) throw upstreamError('OpenDota response unreadable', { cause: err });
          await sleep(delay * 2 ** attempt);
          continue;
        }
      }
      bump(endpoint, 'errors');
      log(`${redact(url)} attempt=${attempt + 1}/${retries + 1} status=${res.status} latencyMs=${now() - started}`);
      const wait = retryAfterMs(res.headers?.get?.('retry-after'), now());
      if (res.status === 429) {
        stats.rateLimited += 1;
        stats.lastRateLimitAt = new Date(now()).toISOString();
        bump(endpoint, 'rateLimited');
        const pause = wait ?? 60000;
        await cooldown.set(now() + pause, `429 on ${endpoint}`);
        if (attempt === retries || pause > maxRetryWaitMs) {
          throw upstreamError('HTTP 429', { status: 429, retryAfterSec: Math.ceil(pause / 1000) });
        }
        await sleep(pause);
        continue;
      }
      if (!RETRYABLE.has(res.status) || attempt === retries) {
        throw upstreamError(`HTTP ${res.status}`, { status: res.status, retryAfterSec: wait != null ? Math.ceil(wait / 1000) : undefined });
      }
      // A long Retry-After is not shortened: fail now, callers serve stale data.
      if (wait != null && wait > maxRetryWaitMs) {
        throw upstreamError(`HTTP ${res.status}`, { status: res.status, retryAfterSec: Math.ceil(wait / 1000) });
      }
      await sleep(wait ?? delay * 2 ** attempt);
    }
    throw upstreamError('OpenDota fetch failed');
  }

  /**
   * GET JSON from OpenDota. `url` is a full api.opendota.com URL without the key.
   * @param {string} url
   * @param {{ retries?: number, delay?: number, timeoutMs?: number, signal?: AbortSignal, priority?: 'high' | 'low' }} [opts]
   */
  function getJson(url, opts = {}) {
    // An already-aborted caller starts nothing.
    if (opts.signal?.aborted) return Promise.reject(opts.signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const o = { retries: opts.retries ?? 2, delay: opts.delay ?? 500, timeoutMs: opts.timeoutMs, priority: opts.priority === 'low' ? 'low' : 'high' };
    let p = inflight.get(url);
    if (p) {
      stats.merged += 1;
    } else {
      p = once(url, o).finally(() => inflight.delete(url));
      // The shared promise may outlive every caller (all aborted): never an unhandled rejection.
      p.catch(() => {});
      inflight.set(url, p);
    }
    return raceAbort(p, opts.signal);
  }

  function snapshot() {
    refill();
    return {
      keyed: Boolean(apiKey),
      rpm,
      tokens: Math.floor(tokens),
      queued: { high: queues.high.length, low: queues.low.length },
      inflight: inflight.size,
      ...stats,
      status: { ...stats.status },
      endpoints: Object.fromEntries(Object.entries(stats.endpoints).map(([k, v]) => [k, { ...v }])),
      remaining: { ...stats.remaining },
    };
  }

  return { getJson, snapshot, isOpenDota: (url) => typeof url === 'string' && url.startsWith(OPENDOTA_BASE) };
}
