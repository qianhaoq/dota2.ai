/**
 * One way to read www.dota2.com/datafeed for the whole server (the home page's
 * patch news and the patch advisor's notes ask for the same documents): each
 * URL is fetched at most once per `ttlMs`, callers asking at the same time
 * share one request, and a failure is not kept.
 */
export function createValveFetch({ fetch: doFetch = globalThis.fetch, ttlMs = 10 * 60_000, timeoutMs = 10_000, now = Date.now } = {}) {
  const cache = new Map(); // url → { at, promise }
  return async function fetchJson(url) {
    const hit = cache.get(url);
    if (hit && now() - hit.at < ttlMs) return hit.promise;
    const promise = (async () => {
      const res = await doFetch(url, { headers: { 'user-agent': 'dota2.ai patch data' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return res.json();
    })();
    cache.set(url, { at: now(), promise });
    promise.catch(() => { if (cache.get(url)?.promise === promise) cache.delete(url); });
    // Keep the cache to the documents in use: a few lists and a few releases' notes.
    if (cache.size > 64) cache.delete(cache.keys().next().value);
    return promise;
  };
}
