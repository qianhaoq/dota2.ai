/**
 * Steam Game Coordinator source: the self-hosted retriever
 * (services/steam-retriever, see docs/STEAM_GC_OPENDOTA_ALTERNATIVE_PLAN.md)
 * returns Valve's own CMsgDOTAMatch / player match history as JSON. This
 * module maps that into the OpenDota shape the coach engine reads.
 *
 * What GC data is: the final scoreboard (heroes, K/D/A, last hits, GPM/XPM,
 * net worth, damage, final items) plus cluster + replay_salt (the replay
 * address). What it is not: a parse. No timelines, no purchase log, no
 * benchmarks. So a GC copy is marked unparsed (`od_data.has_parsed: false`),
 * never stored as parsed, and carries `data_source: 'steam_gc'`. Missing
 * fields stay missing: never 0 for "unknown".
 *
 * Wire format tolerance: protobufjs can emit snake_case (keepCase) or
 * camelCase, uint64 as string or number, enums as names or numbers. All are
 * accepted. Pure apart from createSteamGcClient (network).
 */
import { patchAt } from './stratz.js';

const ANONYMOUS = 4294967295; // Valve's account id for a hidden profile
const RADIANT_WIN = new Set([2, 'k_EMatchOutcome_RadVictory']);
const DIRE_WIN = new Set([3, 'k_EMatchOutcome_DireVictory']);
const TEAM = { 0: 0, 1: 1, DOTA_GC_TEAM_GOOD_GUYS: 0, DOTA_GC_TEAM_BAD_GUYS: 1 };

const camel = (k) => k.replace(/_([a-z0-9])/gi, (_, c) => c.toUpperCase());
/** Field by its proto name, in either case convention. */
function g(o, key) {
  if (!o || typeof o !== 'object') return undefined;
  if (o[key] !== undefined) return o[key];
  const c = camel(key);
  if (o[c] !== undefined) return o[c];
  const lower = key.toLowerCase();
  return o[lower] !== undefined ? o[lower] : o[camel(lower)];
}
/** A non-negative safe integer (numbers or decimal strings), else null. */
function int(v) {
  if (typeof v === 'string' && /^\d{1,16}$/.test(v)) v = Number(v);
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}
/** GC item slots default to -1 (proto `[default = -1]`): empty is 0, as in OpenDota. */
const item = (v) => { const n = int(v); return n ?? 0; };

/**
 * Permanent buff ids (dotaconstants permanent_buffs): a consumed Aghanim's
 * Scepter, Aghanim's Shard and Moon Shard are buffs, not inventory items.
 */
const BUFF = { moon_shard: 1, ultimate_scepter: 2, aghanims_shard: 12 };

/**
 * The player's permanent buffs as OpenDota gives them, plus the three flags
 * OpenDota derives. Only when the GC sent the list: without it the flags stay
 * absent (unknown), never 0.
 */
function buffsOf(p) {
  const list = g(p, 'permanent_buffs');
  if (!Array.isArray(list)) return {};
  const buffs = list.map((b) => ({
    permanent_buff: int(g(b, 'permanent_buff')),
    stack_count: int(g(b, 'stack_count')) ?? 0,
    grant_time: int(g(b, 'grant_time')) ?? 0,
  })).filter((b) => b.permanent_buff != null);
  const has = (id) => Number(buffs.some((b) => b.permanent_buff === id));
  return {
    permanent_buffs: buffs,
    aghanims_scepter: has(BUFF.ultimate_scepter),
    aghanims_shard: has(BUFF.aghanims_shard),
    moonshard: has(BUFF.moon_shard),
  };
}

function gcError(message, extra) {
  return Object.assign(new Error(message), { upstream: 'steam_gc', ...extra });
}

/** OpenDota player_slot for one GC player: player_slot when given, else team + team_slot. */
function slotOf(p) {
  const direct = int(g(p, 'player_slot'));
  if (direct != null) return direct;
  const team = TEAM[g(p, 'team_number')];
  const ts = int(g(p, 'team_slot'));
  if (team == null || ts == null || ts > 4) return null;
  return team === 0 ? ts : 128 + ts;
}

/**
 * Map one CMsgDOTAMatch object to the OpenDota match shape. Pure.
 * Throws (status 502, not retryable) on anything it would have to guess:
 * missing id, not 10 players on 5/5 distinct slots, unknown winner.
 */
export function mapGcMatch(raw, fetchedAt = new Date().toISOString()) {
  const matchId = int(g(raw, 'match_id'));
  const list = g(raw, 'players');
  if (!matchId || !Array.isArray(list) || list.length !== 10) {
    throw gcError('Steam GC match incomplete', { status: 502, retryable: false });
  }
  const players = list.map((p) => {
    const slot = slotOf(p);
    const radiant = slot != null && slot < 128;
    const acct = int(g(p, 'account_id'));
    return {
      player_slot: slot,
      isRadiant: radiant,
      team_number: radiant ? 0 : 1,
      account_id: acct && acct !== ANONYMOUS ? acct : null,
      hero_id: int(g(p, 'hero_id')),
      kills: int(g(p, 'kills')), deaths: int(g(p, 'deaths')), assists: int(g(p, 'assists')),
      last_hits: int(g(p, 'last_hits')), denies: int(g(p, 'denies')),
      gold_per_min: int(g(p, 'gold_per_min')), xp_per_min: int(g(p, 'XP_per_min') ?? g(p, 'xp_per_min')),
      net_worth: int(g(p, 'net_worth')), level: int(g(p, 'level')),
      hero_damage: int(g(p, 'hero_damage')), tower_damage: int(g(p, 'tower_damage')), hero_healing: int(g(p, 'hero_healing')),
      item_0: item(g(p, 'item_0')), item_1: item(g(p, 'item_1')), item_2: item(g(p, 'item_2')),
      item_3: item(g(p, 'item_3')), item_4: item(g(p, 'item_4')), item_5: item(g(p, 'item_5')),
      backpack_0: item(g(p, 'item_6')), backpack_1: item(g(p, 'item_7')), backpack_2: item(g(p, 'item_8')),
      item_neutral: item(g(p, 'item_neutral') ?? g(p, 'item_9')),
      leaver_status: int(g(p, 'leaver_status')),
      ...buffsOf(p),
    };
  }).sort((a, b) => (a.player_slot ?? 999) - (b.player_slot ?? 999));
  const slots = players.map((p) => p.player_slot);
  const expected = [0, 1, 2, 3, 4, 128, 129, 130, 131, 132];
  if (slots.some((s, i) => s !== expected[i])) {
    throw gcError('Steam GC match slots incomplete', { status: 502, retryable: false });
  }
  if (players.some((p) => !p.hero_id || p.kills == null || p.deaths == null || p.assists == null)) {
    throw gcError('Steam GC match scoreboard incomplete', { status: 502, retryable: false });
  }

  const outcome = g(raw, 'match_outcome');
  const legacy = g(raw, 'good_guys_win');
  let radiantWin;
  if (RADIANT_WIN.has(outcome)) radiantWin = true;
  else if (DIRE_WIN.has(outcome)) radiantWin = false;
  else if (typeof legacy === 'boolean' && outcome == null) radiantWin = legacy;
  // Not finished, no winner, or a code we do not know: never guess who won.
  else throw gcError(`Steam GC match outcome unknown (${String(outcome)})`, { status: 502, retryable: false });

  const teamKills = (radiant) => players.filter((p) => p.isRadiant === radiant).reduce((s, p) => s + p.kills, 0);
  const startTime = int(g(raw, 'startTime') ?? g(raw, 'start_time'));
  const cluster = int(g(raw, 'cluster'));
  const salt = int(g(raw, 'replay_salt'));
  return {
    match_id: matchId,
    radiant_win: radiantWin,
    radiant_score: int(g(raw, 'radiant_team_score')) ?? teamKills(true),
    dire_score: int(g(raw, 'dire_team_score')) ?? teamKills(false),
    duration: int(g(raw, 'duration')),
    start_time: startTime,
    game_mode: int(g(raw, 'game_mode')),
    lobby_type: int(g(raw, 'lobby_type')),
    cluster,
    replay_salt: salt,
    replay_url: buildValveReplayUrl({ match_id: matchId, cluster, replay_salt: salt }),
    patch: patchAt(startTime),
    players,
    // A scoreboard, not a parse: never treated or stored as parsed.
    od_data: { has_parsed: false },
    data_source: 'steam_gc',
    gc_fetched_at: fetchedAt,
  };
}

/** Valve's replay address, or null unless all three parts are positive integers. */
export function buildValveReplayUrl({ match_id, cluster, replay_salt } = {}) {
  const id = int(match_id); const c = int(cluster); const s = int(replay_salt);
  if (!id || !c || !s) return null;
  return `http://replay${c}.valve.net/570/${id}_${s}.dem.bz2`;
}

/**
 * Map a CMsgDOTAGetPlayerMatchHistoryResponse to OpenDota recentMatches-like
 * rows for shapeRecent(). GC history has no K/D/A and no player slot: those
 * stay absent (shown as unknown), never 0/0/0. `winner` is from the player's
 * side.
 */
export function mapGcHistory(resp) {
  const list = g(resp, 'matches');
  if (!Array.isArray(list)) return [];
  return list.map((m) => ({
    match_id: int(g(m, 'match_id')),
    start_time: int(g(m, 'start_time')),
    duration: int(g(m, 'duration')),
    hero_id: int(g(m, 'hero_id')),
    game_mode: int(g(m, 'game_mode')),
    lobby_type: int(g(m, 'lobby_type')),
    player_won: typeof g(m, 'winner') === 'boolean' ? g(m, 'winner') : null,
  })).filter((r) => r.match_id);
}

/**
 * Client for the retriever. Bearer auth (the secret is never logged).
 * Errors keep the retriever's status: 404 no such match (ends the source
 * chain), 451 Valve blocks it (not retryable here, other sources may have
 * it), 429 daily quota (retryable, Retry-After), 5xx / network retryable.
 * @param {{ baseUrl: string, secret: string, fetchImpl?: typeof fetch, timeoutMs?: number, log?: (m: string) => void }} o
 */
export function createSteamGcClient({ baseUrl, secret, fetchImpl = (...a) => fetch(...a), timeoutMs = 8000, log = () => {} }) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new Error('STEAM_RETRIEVER_URL is not a URL'); }
  if (!/^https?:$/.test(base.protocol)) throw new Error('STEAM_RETRIEVER_URL must be http(s)');
  if (!secret || typeof secret !== 'string') throw new Error('STEAM_RETRIEVER_SECRET is required');
  const root = base.href.replace(/\/+$/, '');
  const stats = { calls: 0, ok: 0, errors: 0, status: {}, lastStatus: null };

  async function call(pathname, signal) {
    stats.calls += 1;
    let res;
    try {
      res = await fetchImpl(`${root}${pathname}`, {
        headers: { authorization: `Bearer ${secret}`, accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (signal?.aborted) throw err; // the caller left: not a retriever failure
      stats.errors += 1;
      log(`${pathname.split('?')[0].replace(/\d+/g, ':id')}: ${err?.name || 'network error'}`);
      throw gcError(err?.name === 'TimeoutError' ? 'Steam GC timeout' : 'Steam GC fetch failed', { status: 503, retryable: true, cause: err });
    }
    stats.lastStatus = res.status;
    stats.status[res.status] = (stats.status[res.status] ?? 0) + 1;
    if (!res.ok) {
      stats.errors += 1;
      const ra = Number(res.headers?.get?.('retry-after'));
      log(`${pathname.split('?')[0].replace(/\d+/g, ':id')}: HTTP ${res.status}`);
      throw gcError(`Steam GC HTTP ${res.status}`, {
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
        ...(Number.isFinite(ra) && ra > 0 ? { retryAfterSec: Math.ceil(ra) } : {}),
      });
    }
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      stats.errors += 1;
      throw gcError('Steam GC response unreadable', { status: 502, retryable: true });
    }
    return body;
  }

  return {
    /** @param {number|string} matchId @param {{ signal?: AbortSignal }} [o] */
    async fetchMatch(matchId, { signal } = {}) {
      const id = int(matchId);
      if (!id) throw gcError('invalid match id', { status: 400, retryable: false });
      const body = await call(`/match/${id}`, signal);
      const mapped = mapGcMatch(body.match ?? body);
      if (mapped.match_id !== id) throw gcError('Steam GC answered another match', { status: 502, retryable: false });
      stats.ok += 1;
      return mapped;
    },
    /** Rows for shapeRecent(). @param {number} accountId @param {{ signal?: AbortSignal, limit?: number }} [o] */
    async fetchRecent(accountId, { signal, limit = 20 } = {}) {
      const id = int(accountId);
      if (!id) throw gcError('invalid account id', { status: 400, retryable: false });
      const n = Math.min(Math.max(int(limit) ?? 20, 1), 50);
      const rows = mapGcHistory(await call(`/history/${id}?limit=${n}`, signal));
      stats.ok += 1;
      return rows;
    },
    snapshot: () => ({ configured: true, ...stats, status: { ...stats.status } }),
  };
}
