/**
 * Steam Web API as the fallback for "your recent games" when OpenDota is
 * unavailable: IDOTA2Match_570/GetMatchHistory, with the STEAM_WEB_API_KEY the
 * server already uses for hero names.
 *
 * What it gives per match: id, start time, lobby type, and for the player
 * their hero and seat. What it does not: who won, K/D/A, duration, game mode.
 * Those stay absent (shown as unknown), never 0 or a guess. The Steam GC
 * cannot fill in here: it only answers history for its own account
 * (services/steam-retriever/README.md).
 *
 * The key travels in the query string (the API takes it nowhere else), so no
 * URL is ever logged or put in an error. mapWebApiHistory is pure.
 */
const HOST = 'https://api.steampowered.com';
/** `result.status` when the player has not made their match data public. */
const STATUS_PRIVATE = 15;

const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

function webApiError(message, extra) {
  return Object.assign(new Error(message), { upstream: 'steam_web_api', ...extra });
}

/**
 * GetMatchHistory body → rows for shapeRecent(). A profile that hides its
 * match data is an empty list (the page already explains that case). Rows
 * where the player is not among the listed players are dropped: without the
 * hero and seat there is nothing to show or link to.
 */
export function mapWebApiHistory(accountId, body) {
  const result = body?.result;
  if (!result || typeof result !== 'object') throw webApiError('Steam Web API answer unreadable', { status: 502, retryable: true });
  if (result.status === STATUS_PRIVATE) return [];
  if (result.status !== 1) throw webApiError(`Steam Web API status ${int(result.status) ?? 'unknown'}`, { status: 502, retryable: false });
  const list = Array.isArray(result.matches) ? result.matches : [];
  return list.flatMap((m) => {
    const matchId = int(m?.match_id);
    const me = Array.isArray(m?.players) ? m.players.find((p) => p?.account_id === accountId) : null;
    const slot = int(me?.player_slot);
    const hero = int(me?.hero_id);
    if (!matchId || !me || slot == null || !hero) return [];
    return [{ match_id: matchId, start_time: int(m.start_time), lobby_type: int(m.lobby_type), hero_id: hero, player_slot: slot }];
  });
}

/**
 * @param {{ key: string, fetchImpl?: typeof fetch, timeoutMs?: number, log?: (m: string) => void }} o
 */
export function createSteamWebApiClient({ key, fetchImpl = (...a) => fetch(...a), timeoutMs = 8000, log = () => {} }) {
  if (!key || typeof key !== 'string') throw new Error('STEAM_WEB_API_KEY is required');
  const stats = { calls: 0, ok: 0, errors: 0, status: {}, lastStatus: null };
  return {
    /** Rows for shapeRecent(). @param {number} accountId @param {{ signal?: AbortSignal, limit?: number }} [o] */
    async fetchRecent(accountId, { signal, limit = 20 } = {}) {
      const id = int(accountId);
      if (!id) throw webApiError('invalid account id', { status: 400, retryable: false });
      const n = Math.min(Math.max(int(limit) ?? 20, 1), 100);
      const url = `${HOST}/IDOTA2Match_570/GetMatchHistory/v1/?key=${encodeURIComponent(key)}&account_id=${id}&matches_requested=${n}`;
      stats.calls += 1;
      let res;
      try {
        res = await fetchImpl(url, {
          headers: { accept: 'application/json' },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (signal?.aborted) throw err; // the caller left: not an upstream failure
        stats.errors += 1;
        log(`GetMatchHistory: ${err?.name === 'TimeoutError' ? 'timeout' : 'network error'}`);
        // No `cause`: fetch errors can carry the URL, and the URL carries the key.
        throw webApiError(err?.name === 'TimeoutError' ? 'Steam Web API timeout' : 'Steam Web API fetch failed', { status: 503, retryable: true });
      }
      stats.lastStatus = res.status;
      stats.status[res.status] = (stats.status[res.status] ?? 0) + 1;
      if (!res.ok) {
        stats.errors += 1;
        // 401/403: the key is missing rights or revoked. Nothing a retry fixes.
        log(`GetMatchHistory: HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (key rejected)' : ''}`);
        throw webApiError(`Steam Web API HTTP ${res.status}`, { status: res.status === 401 || res.status === 403 ? 502 : res.status, retryable: res.status === 429 || res.status >= 500 });
      }
      const body = await res.json().catch(() => null);
      let rows;
      try { rows = mapWebApiHistory(id, body); } catch (err) { stats.errors += 1; log(`GetMatchHistory: ${err.message}`); throw err; }
      stats.ok += 1;
      return rows;
    },
    snapshot: () => ({ configured: true, ...stats, status: { ...stats.status } }),
  };
}
