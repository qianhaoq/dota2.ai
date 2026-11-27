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
export const PROFILE_CHANGED_EVENT = 'dota2ai:profile';

function notifyProfileChanged(): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event(PROFILE_CHANGED_EVENT));
  }
}

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
    const prev = window.localStorage.getItem(ACCOUNT_STORAGE_KEY);
    // "New" is per account: switching or forgetting starts over.
    if (prev !== id) window.localStorage.removeItem(SEEN_STORAGE_KEY);
    if (id) window.localStorage.setItem(ACCOUNT_STORAGE_KEY, id);
    else window.localStorage.removeItem(ACCOUNT_STORAGE_KEY);
    notifyProfileChanged();
  } catch {
    // Private mode / blocked storage: the page still works without it.
  }
}

/** Matches this browser has opened a review for (newest last, capped). */
export const REVIEWED_STORAGE_KEY = 'dota2ai.coach.reviewed'; // gitleaks:allow (storage key name, not a secret)
/** Start time of the newest game the player has already seen in their list. */
export const SEEN_STORAGE_KEY = 'dota2ai.coach.seenUntil'; // gitleaks:allow (storage key name, not a secret)
const MAX_REVIEWED = 200;

export function reviewedMatches(): Set<string> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(REVIEWED_STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === 'string' && /^\d{1,20}$/.test(x)) : []);
  } catch {
    return new Set();
  }
}

export function markReviewed(matchId: string | number): void {
  try {
    const id = String(matchId);
    const list = [...reviewedMatches()].filter((x) => x !== id);
    list.push(id);
    window.localStorage.setItem(REVIEWED_STORAGE_KEY, JSON.stringify(list.slice(-MAX_REVIEWED)));
    notifyProfileChanged();
  } catch {
    // Storage blocked: nothing to remember.
  }
}

/** The newest start time already seen, or null on a first visit. */
export function seenUntil(): number | null {
  try {
    const n = Number(window.localStorage.getItem(SEEN_STORAGE_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function markSeen(startTime: number | null | undefined): void {
  if (!startTime) return;
  try {
    if (startTime > (seenUntil() ?? 0)) {
      window.localStorage.setItem(SEEN_STORAGE_KEY, String(startTime));
      notifyProfileChanged();
    }
  } catch {
    // ignore
  }
}
