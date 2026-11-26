/**
 * How much credit the model account has left, read with the key a run would spend from — so a bulk run from a
 * developer's machine (scripts/probe-chat.mjs) stops before it takes the account to zero.
 *
 * Why: a developer's key and the site's key can bill one account, and a different key says nothing about that. On
 * 2026-11-25 the probe runs emptied the account the site runs on, and the site failed a visitor's review until it
 * was topped up. A run now reads the balance before it starts and as it goes, and leaves a floor untouched.
 *
 * DeepSeek only: GET https://api.deepseek.com/user/balance answers
 * { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] } (checked live
 * 2026-11-25). No other provider's balance endpoint is known here, and a balance that cannot be read is not
 * "enough": the verdict is then "do not go".
 */

/** What a run leaves in the account unless told otherwise, in the account's currency. */
export const DEFAULT_BALANCE_FLOOR = 50;
/** Site-level thresholds (#365): warn in logs before credit runs low; pause new reviews before visitors hit mid-run 402s. */
export const SITE_BALANCE_WARN = 20;
export const SITE_BALANCE_PAUSE = 1;
export const SITE_BALANCE_EVERY_MS = 5 * 60_000;
const BALANCE_URL = { deepseek: 'https://api.deepseek.com/user/balance' };
const TIMEOUT_MS = 15000;

export const hasBalanceEndpoint = (provider) => Boolean(BALANCE_URL[provider]);

/**
 * @param {{ provider: string, apiKey: string, fetchFn?: typeof fetch }} o
 * @returns {Promise<{ known: true, available: boolean, total: number, currency: string } | { known: false, reason: string }>}
 *   total: the largest balance the account holds in one currency (an account can hold more than one). The reason
 *   of an unknown balance never carries the key or the provider's response body.
 */
export async function readBalance({ provider, apiKey, fetchFn = globalThis.fetch }) {
  const url = BALANCE_URL[provider];
  if (!url) return { known: false, reason: `no balance endpoint is known for ${provider}` };
  if (!apiKey) return { known: false, reason: 'no API key' };
  let body;
  try {
    const res = await fetchFn(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { known: false, reason: `the balance endpoint answered ${res.status}` };
    body = await res.json();
  } catch (e) {
    return { known: false, reason: `the balance endpoint could not be read (${e?.name ?? 'error'})` };
  }
  const held = (Array.isArray(body?.balance_infos) ? body.balance_infos : [])
    .map((b) => ({ currency: String(b?.currency ?? ''), total: Number(b?.total_balance) }))
    .filter((b) => b.currency && Number.isFinite(b.total));
  if (typeof body?.is_available !== 'boolean' || !held.length) return { known: false, reason: 'the balance endpoint answered in a shape not known here' };
  const most = held.reduce((a, b) => (b.total > a.total ? b : a));
  return { known: true, available: body.is_available, total: most.total, currency: most.currency };
}

/**
 * Whether a run may spend from this account: only with a known balance, an account open for calls, and the floor
 * still under the balance.
 * @returns {{ go: boolean, reason: string }}
 */
export function balanceVerdict(balance, floor = DEFAULT_BALANCE_FLOOR) {
  if (!balance?.known) return { go: false, reason: `the balance is not known: ${balance?.reason ?? 'not read'}` };
  if (!balance.available) return { go: false, reason: 'the account is not open for calls (no credit left)' };
  if (balance.total < floor) return { go: false, reason: `the balance, ${balance.total} ${balance.currency}, is under the floor of ${floor}` };
  return { go: true, reason: `balance ${balance.total} ${balance.currency}, floor ${floor}` };
}

/**
 * Periodic balance monitor for the live server (#365):
 * - Checks offered models that have a balance endpoint (deduplicated by provider + key).
 * - Unknown is NOT empty on the live site: if the balance endpoint fails or a provider has none,
 *   visitors are never blocked.
 * - Logs a warning when a known balance drops below `warnBelow`, and pauses new reviews with
 *   `model_out_of_credit` when `!available` or `total < pauseBelow` until topped up.
 *
 * @param {{
 *   models: { id: string, provider: string, apiKey: string }[],
 *   warnBelow?: number,
 *   pauseBelow?: number,
 *   everyMs?: number,
 *   readBalanceFn?: typeof readBalance,
 *   now?: () => number,
 *   log?: (msg: string) => void,
 * }} o
 */
export function createBalanceMonitor(o) {
  const warnBelow = Number.isFinite(o.warnBelow) && o.warnBelow >= 0 ? o.warnBelow : SITE_BALANCE_WARN;
  const pauseBelow = Number.isFinite(o.pauseBelow) && o.pauseBelow >= 0 ? o.pauseBelow : SITE_BALANCE_PAUSE;
  const everyMs = Number.isFinite(o.everyMs) && o.everyMs > 0 ? o.everyMs : SITE_BALANCE_EVERY_MS;
  const readFn = o.readBalanceFn ?? readBalance;
  const now = o.now ?? (() => Date.now());
  const log = o.log ?? (() => {});

  // Group model IDs sharing one (provider, apiKey) so one account is queried once per tick.
  const groups = new Map();
  for (const m of o.models ?? []) {
    if (!m?.id || !m?.apiKey || !hasBalanceEndpoint(m.provider)) continue;
    const k = `${m.provider}:${m.apiKey}`;
    const g = groups.get(k) ?? { provider: m.provider, apiKey: m.apiKey, ids: [] };
    g.ids.push(m.id);
    groups.set(k, g);
  }

  /** @type {Map<string, { reason: 'model_out_of_credit', until: number }>} */
  const paused = new Map();
  /** @type {Map<string, 'ok' | 'low' | 'paused'>} */
  const lastState = new Map();
  let inflight = null;

  async function check() {
    if (!groups.size) return;
    if (inflight) return inflight;
    inflight = (async () => {
      for (const [k, g] of groups) {
        const b = await readFn({ provider: g.provider, apiKey: g.apiKey });
        // Unknown balance is never treated as empty on the live server.
        if (!b?.known) continue;
        const label = g.ids.join(',');
        const prev = lastState.get(k) ?? 'ok';
        if (!b.available || b.total < pauseBelow) {
          const until = now() + everyMs;
          for (const id of g.ids) paused.set(id, { reason: 'model_out_of_credit', until });
          lastState.set(k, 'paused');
          log(`model balance exhausted models=${label} balance=${b.total} ${b.currency} available=${b.available} pause_below=${pauseBelow}`);
        } else {
          for (const id of g.ids) paused.delete(id);
          if (b.total < warnBelow) {
            lastState.set(k, 'low');
            log(`model balance low models=${label} balance=${b.total} ${b.currency} warn_below=${warnBelow}`);
          } else {
            if (prev !== 'ok') log(`model balance restored models=${label} balance=${b.total} ${b.currency}`);
            lastState.set(k, 'ok');
          }
        }
      }
    })().finally(() => { inflight = null; });
    return inflight;
  }

  function down(modelId) {
    const entry = modelId ? paused.get(modelId) : null;
    if (!entry) return null;
    const left = entry.until - now();
    if (left <= 0) { paused.delete(modelId); return null; }
    return { reason: entry.reason, retry_in_sec: Math.max(1, Math.ceil(left / 1000)) };
  }

  function healthy(modelId) {
    if (!modelId) return false;
    for (const [k, g] of groups) {
      if (g.ids.includes(modelId)) {
        const s = lastState.get(k);
        return s === 'ok' || s === 'low';
      }
    }
    return false;
  }

  let timer = null;
  function start() {
    if (!groups.size || timer) return;
    void check();
    timer = setInterval(() => { void check(); }, everyMs);
    timer.unref?.();
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { check, down, healthy, start, stop };
}
