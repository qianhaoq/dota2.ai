/**
 * Daily request budget, reset at 00:00 UTC. Valve limits match-details
 * requests to roughly 100 per Steam account and 500 per IP per day
 * (odota/core svc/retriever.ts); the defaults stay under both. Every request
 * sent to the GC is counted, answered or not, because Valve counts those.
 *
 * `load`/`save` persist the counters so a restart does not hand out the
 * day's budget a second time. Keys are account labels, never login names.
 */
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * @param {{ matchPerAccount?: number, matchPerIp?: number, historyPerAccount?: number,
 *           now?: () => number, load?: () => any, save?: (state: any) => void }} [o]
 */
export function createDailyQuota({
  matchPerAccount = 95, matchPerIp = 480, historyPerAccount = 300,
  now = Date.now, load = () => null, save = () => {},
} = {}) {
  const caps = { match: matchPerAccount, history: historyPerAccount };
  // No prototype: a label such as "constructor" must read as an absent counter.
  const emptyDay = (day) => ({ day, match: Object.create(null), history: Object.create(null) });
  let state = emptyDay(dayOf(now()));
  try {
    const saved = load();
    if (saved && saved.day === state.day) {
      for (const kind of ['match', 'history']) {
        for (const [k, v] of Object.entries(saved[kind] ?? {})) {
          if (Number.isSafeInteger(v) && v > 0) state[kind][k] = v;
        }
      }
    }
  } catch { /* an unreadable file is an empty day: the caps still hold from here on */ }

  function roll() {
    const today = dayOf(now());
    if (today !== state.day) state = emptyDay(today);
  }
  const sum = (kind) => Object.values(state[kind]).reduce((s, n) => s + n, 0);

  return {
    /** Requests this account may still send today. */
    remaining(kind, account) {
      roll();
      const own = caps[kind] - (state[kind][account] ?? 0);
      return Math.max(0, kind === 'match' ? Math.min(own, matchPerIp - sum('match')) : own);
    },
    /** Count one request. False (and nothing counted) when the budget is spent. */
    take(kind, account) {
      if (this.remaining(kind, account) <= 0) return false;
      state[kind][account] = (state[kind][account] ?? 0) + 1;
      try { save(state); } catch { /* counting in memory still holds */ }
      return true;
    },
    secondsToReset() {
      const t = now();
      return Math.max(1, Math.ceil((Date.parse(`${dayOf(t)}T00:00:00Z`) + 86_400_000 - t) / 1000));
    },
    /** Totals only: no account labels leave the process. */
    snapshot(accounts = 0) {
      roll();
      return {
        day: state.day,
        matchUsed: sum('match'),
        matchCap: Math.min(matchPerIp, matchPerAccount * accounts),
        historyUsed: sum('history'),
        historyCap: historyPerAccount * accounts,
      };
    },
  };
}
