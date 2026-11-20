/**
 * Turns what a player can actually find into a 32-bit Steam account id
 * ("friend code"): the friend code itself, a SteamID64, [U:1:n], or a
 * Steam / OpenDota / Dotabuff / STRATZ profile link. Vanity Steam URLs
 * (/id/name) cannot be resolved without a Steam API call, so they get their
 * own error to explain what to paste instead.
 */

const STEAM64_BASE = 76561197960265728n;
const MAX_ACCOUNT = 2n ** 32n - 1n;
const PROFILE_HOSTS = ['steamcommunity.com', 'opendota.com', 'dotabuff.com', 'stratz.com'];

export type AccountParse = { ok: true; accountId: string } | { ok: false; reason: 'invalid' | 'vanity' };

function fromDigits(d: string): string | null {
  if (!/^\d{1,20}$/.test(d)) return null;
  const n = BigInt(d);
  if (n >= 1n && n <= MAX_ACCOUNT) return n.toString();
  // SteamID64 of an individual account.
  if (n > STEAM64_BASE && n - STEAM64_BASE <= MAX_ACCOUNT) return (n - STEAM64_BASE).toString();
  return null;
}

export function parseAccountInput(input: unknown): AccountParse {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, reason: 'invalid' };
  const bare = fromDigits(raw);
  if (bare) return { ok: true, accountId: bare };
  const u1 = raw.match(/^\[?U:1:(\d{1,10})\]?$/i);
  if (u1) {
    const id = fromDigits(u1[1]);
    return id ? { ok: true, accountId: id } : { ok: false, reason: 'invalid' };
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'invalid' };
  const host = url.hostname.toLowerCase();
  if (!PROFILE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return { ok: false, reason: 'invalid' };
  if (/^\/id\/[^/]+/i.test(url.pathname) && host.endsWith('steamcommunity.com')) return { ok: false, reason: 'vanity' };
  const m = url.pathname.match(/^\/(?:profiles|players)\/(\d{1,20})(?=\/|$)/i);
  const id = m ? fromDigits(m[1]) : null;
  return id ? { ok: true, accountId: id } : { ok: false, reason: 'invalid' };
}

/** The player's own friend code, remembered in this browser only. */
export const ACCOUNT_STORAGE_KEY = 'dota2ai.coach.account';

export function rememberedAccount(): string | null {
  try {
    const v = window.localStorage.getItem(ACCOUNT_STORAGE_KEY);
    return v && /^\d{1,10}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function rememberAccount(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(ACCOUNT_STORAGE_KEY, id);
    else window.localStorage.removeItem(ACCOUNT_STORAGE_KEY);
  } catch {
    // Private mode / blocked storage: the page still works without it.
  }
}
