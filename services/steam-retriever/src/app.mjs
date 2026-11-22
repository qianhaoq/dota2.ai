/**
 * The HTTP face of the retriever. No Steam code here: `gc` is the logged-in
 * account pool (src/steamPool.mjs, or a fake in tests).
 *
 *   GET /healthz            no auth; counts only, nothing secret
 *   GET /match/:matchId     { match: CMsgDOTAMatch }
 *   GET /history/:accountId?limit=20   { matches: [...] }
 *
 * Everything but /healthz needs `Authorization: Bearer <secret>`.
 * Statuses the caller (lib/upstream/steamGc.js) relies on:
 *   404 no such match · 451 Valve withholds it · 429 daily budget spent
 *   (Retry-After) · 503 no account online · 504 the GC did not answer.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

const MATCH_ID = /^[1-9]\d{0,14}$/;
const ACCOUNT_ID = /^[1-9]\d{0,9}$/;
const GC_OK = 1; // EResult k_EResultOK
const GC_NOT_FOUND = 2;
const GC_BLOCKED = 15;

const digest = (s) => createHash('sha256').update(String(s)).digest();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A small time-bounded cache: repeats inside the window cost no GC request. */
function ttlCache(max, now) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (hit.until <= now()) { map.delete(key); return undefined; }
      return hit.value;
    },
    set(key, value, ttlMs) {
      map.delete(key);
      map.set(key, { value, until: now() + ttlMs });
      while (map.size > max) map.delete(map.keys().next().value);
    },
  };
}

/**
 * @param {{
 *   secret: string,
 *   gc: { size(): number, ready(): string[],
 *         matchDetails(account: string, matchId: string, o: { timeoutMs: number }): Promise<{ result?: number, match?: any }>,
 *         history(account: string, accountId: number, limit: number, o: { timeoutMs: number }): Promise<{ matches?: any[] }> },
 *   quota: ReturnType<import('./quota.mjs').createDailyQuota>,
 *   now?: () => number, log?: (line: string) => void,
 *   gcTimeoutMs?: number, minIntervalMs?: number, maxQueueMs?: number,
 *   okTtlMs?: number, missTtlMs?: number, historyTtlMs?: number,
 * }} o
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRetrieverApp({
  secret, gc, quota, now = Date.now, log = () => {},
  gcTimeoutMs = 6000, minIntervalMs = 250, maxQueueMs = 4000,
  okTtlMs = 10 * 60_000, missTtlMs = 60_000, historyTtlMs = 60_000,
}) {
  if (typeof secret !== 'string' || secret.length < 24) {
    throw new Error('STEAM_RETRIEVER_SECRET must be set (24+ characters)');
  }
  const want = digest(secret);
  const cache = ttlCache(500, now);
  /** key → { promise, waiters }: one GC request per key, however many callers. */
  const jobs = new Map();
  let turn = 0; // round-robin among equally used accounts
  let gate = Promise.resolve(); // spaces GC requests minIntervalMs apart
  let queued = 0;
  let lastSentAt = -Infinity;

  function authorized(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    // Compare digests: equal length whatever was sent, constant time.
    return Boolean(m) && timingSafeEqual(digest(m[1]), want);
  }

  /** The ready account with the most budget left, or why there is none. */
  function pick(kind) {
    const ready = gc.ready();
    if (ready.length === 0) return { status: 503, code: 'no_account_online', retryAfter: 30 };
    const usable = ready.map((a) => ({ a, left: quota.remaining(kind, a) })).filter((x) => x.left > 0);
    if (usable.length === 0) return { status: 429, code: 'daily_quota', retryAfter: quota.secondsToReset() };
    const best = Math.max(...usable.map((x) => x.left));
    const top = usable.filter((x) => x.left === best);
    return { account: top[turn++ % top.length].a };
  }

  /**
   * Wait for our turn, then count the request against the account. Budget is
   * only spent on a request someone is still waiting for: a line too long to
   * be answered in time is refused up front, and a request whose callers all
   * left while it queued is dropped.
   */
  async function send(kind, wanted, run) {
    if (queued * minIntervalMs > maxQueueMs) return { status: 503, code: 'busy', retryAfter: Math.ceil(maxQueueMs / 1000) };
    queued += 1;
    const mine = gate.then(async () => {
      const wait = lastSentAt + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      if (!wanted()) return { status: 499, code: 'abandoned' };
      const chosen = pick(kind);
      if (!chosen.account) return chosen;
      if (!quota.take(kind, chosen.account)) return { status: 429, code: 'daily_quota', retryAfter: quota.secondsToReset() };
      lastSentAt = now();
      return chosen;
    }).finally(() => { queued -= 1; });
    gate = mine.then(() => {}, () => {});
    const chosen = await mine;
    if (!chosen.account) return chosen;
    try {
      return { value: await run(chosen.account) };
    } catch (err) {
      const timeout = err?.code === 'gc_timeout';
      log(`${kind}: ${timeout ? 'GC did not answer' : `GC request failed (${err?.code || err?.name || 'error'})`}`);
      return timeout ? { status: 504, code: 'gc_timeout' } : { status: 502, code: 'gc_error' };
    }
  }

  /** Join the job for `key` (starting it if needed). `leave()` when the caller goes away. */
  function join(key, work) {
    const hit = cache.get(key);
    if (hit) return { promise: Promise.resolve(hit), leave() {} };
    let job = jobs.get(key);
    if (!job) {
      job = { waiters: 0, promise: null };
      job.promise = work(() => job.waiters > 0).finally(() => jobs.delete(key));
      jobs.set(key, job);
    }
    job.waiters += 1;
    let left = false;
    return { promise: job.promise, leave() { if (!left) { left = true; job.waiters -= 1; } } };
  }

  const match = (id) => join(`m:${id}`, async (wanted) => {
    const sent = await send('match', wanted, (account) => gc.matchDetails(account, id, { timeoutMs: gcTimeoutMs }));
    if (!sent.value) return sent;
    const { result, match: m } = sent.value;
    let out;
    if (result === GC_NOT_FOUND) out = { status: 404, code: 'not_found' };
    else if (result === GC_BLOCKED) out = { status: 451, code: 'valve_blocked' };
    else if (result === GC_OK && m && String(m.match_id) === id) out = { status: 200, body: { match: m } };
    else {
      log(`match: unexpected GC result ${Number.isInteger(result) ? result : 'none'}`);
      return { status: 502, code: 'gc_result', result: Number.isInteger(result) ? result : null };
    }
    // A match that just ended can be unknown for a moment: keep misses briefly.
    cache.set(`m:${id}`, out, out.status === 404 ? missTtlMs : okTtlMs);
    return out;
  });

  const history = (accountId, limit) => join(`h:${accountId}:${limit}`, async (wanted) => {
    const sent = await send('history', wanted, (account) => gc.history(account, accountId, limit, { timeoutMs: gcTimeoutMs }));
    if (!sent.value) return sent;
    const out = { status: 200, body: { matches: Array.isArray(sent.value.matches) ? sent.value.matches : [] } };
    cache.set(`h:${accountId}:${limit}`, out, historyTtlMs);
    return out;
  });

  function reply(res, out) {
    const body = out.body ?? { code: out.code, ...(out.result !== undefined ? { result: out.result } : {}) };
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    if (out.retryAfter) headers['retry-after'] = String(out.retryAfter);
    res.writeHead(out.status, headers);
    res.end(JSON.stringify(body));
  }

  return (req, res) => {
    let url;
    try { url = new URL(req.url ?? '/', 'http://retriever.local'); } catch { return reply(res, { status: 400, code: 'bad_request' }); }
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, { status: 405, code: 'method_not_allowed' });
    if (url.pathname === '/healthz') {
      const readyAccounts = gc.ready().length;
      return reply(res, { status: 200, body: { ok: readyAccounts > 0, accounts: gc.size(), readyAccounts, ...quota.snapshot(gc.size()) } });
    }
    if (!authorized(req)) return reply(res, { status: 401, code: 'unauthorized' });
    const [, route, id, extra] = url.pathname.split('/');
    let work;
    if (route === 'match' && extra === undefined) {
      if (!MATCH_ID.test(id ?? '')) return reply(res, { status: 400, code: 'invalid_match_id' });
      work = match(id);
    } else if (route === 'history' && extra === undefined) {
      if (!ACCOUNT_ID.test(id ?? '') || Number(id) >= 4294967295) return reply(res, { status: 400, code: 'invalid_account_id' });
      const raw = url.searchParams.get('limit');
      const limit = raw == null ? 20 : Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) return reply(res, { status: 400, code: 'invalid_limit' });
      work = history(Number(id), limit);
    } else {
      // Not 404: to the caller a 404 means "Valve has no such match".
      return reply(res, { status: 400, code: 'no_such_route' });
    }
    // The caller hung up before the answer: stop holding its place in the line.
    res.on('close', () => { if (!res.writableEnded) work.leave(); });
    work.promise.then((out) => { if (!res.destroyed) reply(res, out); }, () => { if (!res.destroyed) reply(res, { status: 500, code: 'internal' }); });
  };
}
