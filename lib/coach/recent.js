/**
 * "Your recent games": a player's last matches from OpenDota, shaped for the
 * coach's match picker. Lets a player start from their Steam friend code
 * instead of hunting for a match ID.
 *
 * Privacy: account ids are public on OpenDota, but nothing here stores or
 * logs them; the cache only lives in memory for a minute.
 */
import { heroInfo, modeLabel } from './analyze.js';

export const MAX_ACCOUNT_ID = 2 ** 32 - 1;

/** A 32-bit Steam account id ("friend code"), or null. */
export function parseAccountId(raw) {
  const s = String(raw ?? '');
  if (!/^[1-9]\d{0,9}$/.test(s)) return null;
  const n = Number(s);
  return n <= MAX_ACCOUNT_ID ? n : null;
}

/** OpenDota player_slot (0-4, 128-132) -> the coach's seat index (0-9). */
export const seatOf = (playerSlot) => (playerSlot >= 128 ? playerSlot - 128 + 5 : playerSlot);

const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * Rows from OpenDota recentMatches, or from a barer source: the Steam Web API
 * (steamWebApi.mapWebApiHistory: no result, K/D/A, duration or mode) or Steam
 * GC history (steamGc.mapGcHistory: no seat, no K/D/A). Whatever a source
 * does not give stays null (unknown), never 0/0/0.
 */
export function shapeRecent(accountId, rows, source = 'opendota') {
  const matches = (Array.isArray(rows) ? rows : [])
    .filter((r) => Number.isInteger(r?.match_id))
    .map((r) => {
      const known = Number.isInteger(r.player_slot);
      const radiant = known ? r.player_slot < 128 : null;
      const hero = heroInfo(r.hero_id);
      const k = count(r.kills); const d = count(r.deaths); const a = count(r.assists);
      return {
        match_id: r.match_id,
        start_time: r.start_time ?? null,
        duration: r.duration ?? null,
        hero: { id: hero.id, en: hero.en, zh: hero.zh, icon: hero.icon },
        slot: known ? seatOf(r.player_slot) : null,
        radiant,
        won: typeof r.radiant_win === 'boolean' && known ? r.radiant_win === radiant
          : typeof r.player_won === 'boolean' ? r.player_won : null,
        kda: k != null && d != null && a != null ? [k, d, a] : null,
        mode: modeLabel(r.game_mode),
        ranked: r.lobby_type === 7,
      };
    });
  // An empty list usually means the profile hides its match data.
  return {
    account_id: accountId, matches, empty_hint: matches.length ? null : 'private_or_no_matches',
    // 'steam_web_api': the fallback list (no result, K/D/A or duration); the page says so.
    source: source === 'steam_web_api' ? 'steam_web_api' : 'opendota',
  };
}

/**
 * @param {{ fetchRecent: (accountId: number) => Promise<object[] | { rows: object[], source?: string }>, ttlMs?: number, now?: () => number, max?: number }} deps
 */
export function createRecentService({ fetchRecent, ttlMs = 60_000, now = Date.now, max = 500 }) {
  const cache = new Map(); // accountId -> { at, value | promise }
  return {
    async get(accountId) {
      const hit = cache.get(accountId);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      // fetchRecent gives rows, or { rows, source } when it knows where they came from.
      const value = fetchRecent(accountId).then((got) => (Array.isArray(got) ? shapeRecent(accountId, got) : shapeRecent(accountId, got?.rows, got?.source)));
      cache.set(accountId, { at: now(), value });
      if (cache.size > max) cache.delete(cache.keys().next().value);
      try {
        return await value;
      } catch (error) {
        cache.delete(accountId); // never cache a failure
        throw error;
      }
    },
  };
}
