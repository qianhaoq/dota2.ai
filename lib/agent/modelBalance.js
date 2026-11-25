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
const BALANCE_URL = { deepseek: 'https://api.deepseek.com/user/balance' };
const TIMEOUT_MS = 15000;

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
