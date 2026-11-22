/**
 * STRATZ as a fallback match source (GraphQL, STRATZ_API_TOKEN), used when
 * OpenDota fails or is in its 429 cooldown.
 *
 * Mapped into the OpenDota match shape the engine reads — only fields whose
 * meaning is unambiguous in STRATZ's schema:
 *   match: id, winner, score (team kills per minute, summed), duration, start time, mode, lobby,
 *     cluster, patch (by date), per-minute net-worth and XP leads;
 *   players: slot, side, hero, account, K/D/A, last hits, denies, GPM, XPM,
 *     net worth, level, damage, healing, final items, lane (from STRATZ's lane
 *     role), item purchase log.
 * Per-minute player timelines, kill/death logs, wards and positions are left
 * out until checked against a real response (scripts/stratz-check.mjs): a
 * wrong reading there would become a wrong "why". The match is therefore
 * marked unparsed (`od_data.has_parsed: false`), never stored as parsed, and
 * carries `data_source: 'stratz'`.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let ITEM_KEYS = null;
function itemKey(id) {
  if (!ITEM_KEYS) {
    ITEM_KEYS = new Map();
    try {
      const items = require('../data/constants/items.json');
      for (const [key, v] of Object.entries(items)) if (Number.isFinite(v?.id)) ITEM_KEYS.set(v.id, key);
    } catch { /* no snapshot: items stay unnamed */ }
  }
  return id ? ITEM_KEYS.get(Number(id)) ?? null : null;
}

export const STRATZ_URL = 'https://api.stratz.com/graphql';

export const MATCH_QUERY = `query ($id: Long!) {
  match(id: $id) {
    id didRadiantWin durationSeconds startDateTime gameMode lobbyType clusterId
    radiantNetworthLeads radiantExperienceLeads radiantKills direKills
    players {
      steamAccountId isRadiant playerSlot heroId kills deaths assists
      numLastHits numDenies goldPerMinute experiencePerMinute networth level
      heroDamage towerDamage heroHealing lane
      item0Id item1Id item2Id item3Id item4Id item5Id backpack0Id backpack1Id backpack2Id neutral0Id
      stats { itemPurchases { time itemId } }
    }
  }
}`;

// STRATZ enum names -> OpenDota ids (OpenDota's own constants).
const GAME_MODE = { ALL_PICK: 1, CAPTAINS_MODE: 2, RANDOM_DRAFT: 3, SINGLE_DRAFT: 4, ALL_RANDOM: 5, CAPTAINS_DRAFT: 16, ABILITY_DRAFT: 18, ALL_PICK_RANKED: 22, TURBO: 23 };
const LOBBY = { UNRANKED: 0, PRACTICE: 1, TOURNAMENT: 2, COOP_VS_BOTS: 4, TEAM_MATCH: 5, SOLO_QUEUE: 6, RANKED: 7, SOLO_MID: 8, BATTLE_CUP: 9 };
// OpenDota patch ids by release date (constants/patch).
const PATCHES = [
  { id: 58, at: Date.parse('2025-05-22T23:36:01Z') },
  { id: 59, at: Date.parse('2025-12-16T00:50:40Z') },
  { id: 60, at: Date.parse('2026-03-24T00:50:59Z') },
  { id: 61, at: Date.parse('2026-11-18T21:28:07Z') },
];
/** OpenDota patch id for a start time (unix seconds), or null when unknown. */
export function patchAt(startSec) {
  if (!Number.isFinite(startSec)) return null;
  const t = startSec * 1000;
  let id = null;
  for (const p of PATCHES) if (t >= p.at) id = p.id;
  return id;
}

/** STRATZ lane role -> OpenDota map lane (1 bottom, 2 mid, 3 top, 4 jungle) for this side. */
function laneOf(lane, radiant) {
  switch (lane) {
    case 'SAFE_LANE': return radiant ? 1 : 3;
    case 'OFF_LANE': return radiant ? 3 : 1;
    case 'MID_LANE': return 2;
    case 'JUNGLE': return 4;
    default: return null;
  }
}
const LANE_ROLE = { SAFE_LANE: 1, MID_LANE: 2, OFF_LANE: 3, JUNGLE: 4 };

/** Map one STRATZ `match` object to the OpenDota shape. Pure. */
export function mapStratzMatch(m, fetchedAt = new Date().toISOString()) {
  if (!m || !Number.isFinite(Number(m.id)) || !Array.isArray(m.players) || m.players.length !== 10) {
    throw Object.assign(new Error('STRATZ match incomplete'), { status: 502, upstream: 'stratz', retryable: true });
  }
  const side = (radiant) => m.players.filter((p) => Boolean(p.isRadiant) === radiant)
    .sort((a, b) => (a.playerSlot ?? 0) - (b.playerSlot ?? 0));
  const ordered = [...side(true).map((p, i) => [p, i]), ...side(false).map((p, i) => [p, 128 + i])];
  if (ordered.length !== 10 || side(true).length !== 5) {
    throw Object.assign(new Error('STRATZ match sides incomplete'), { status: 502, upstream: 'stratz', retryable: true });
  }
  const players = ordered.map(([p, slot]) => {
    const radiant = slot < 128;
    const lane = laneOf(p.lane, radiant);
    const purchases = Array.isArray(p.stats?.itemPurchases) ? p.stats.itemPurchases : null;
    return {
      player_slot: slot,
      isRadiant: radiant,
      team_number: radiant ? 0 : 1,
      account_id: p.steamAccountId ?? null,
      hero_id: p.heroId,
      kills: p.kills ?? 0, deaths: p.deaths ?? 0, assists: p.assists ?? 0,
      last_hits: p.numLastHits ?? null, denies: p.numDenies ?? null,
      gold_per_min: p.goldPerMinute ?? null, xp_per_min: p.experiencePerMinute ?? null,
      net_worth: p.networth ?? null, level: p.level ?? null,
      hero_damage: p.heroDamage ?? null, tower_damage: p.towerDamage ?? null, hero_healing: p.heroHealing ?? null,
      item_0: p.item0Id ?? 0, item_1: p.item1Id ?? 0, item_2: p.item2Id ?? 0,
      item_3: p.item3Id ?? 0, item_4: p.item4Id ?? 0, item_5: p.item5Id ?? 0,
      backpack_0: p.backpack0Id ?? 0, backpack_1: p.backpack1Id ?? 0, backpack_2: p.backpack2Id ?? 0,
      item_neutral: p.neutral0Id ?? 0,
      ...(lane != null ? { lane, lane_role: LANE_ROLE[p.lane] } : {}),
      is_roaming: p.lane === 'ROAMING',
      ...(purchases ? {
        purchase_log: purchases
          .map((x) => ({ time: x.time, key: itemKey(x.itemId) }))
          .filter((x) => Number.isFinite(x.time) && x.key)
          .sort((a, b) => a.time - b.time),
      } : {}),
    };
  });
  const leads = (xs) => (Array.isArray(xs) && xs.every(Number.isFinite) ? xs : undefined);
  // Team score: STRATZ's per-minute team kills summed (they include kills no
  // hero is credited with); the heroes' own kills only when those are missing.
  const kills = (radiant) => {
    const perMinute = radiant ? m.radiantKills : m.direKills;
    if (Array.isArray(perMinute) && perMinute.length && perMinute.every(Number.isFinite)) return perMinute.reduce((a, b) => a + b, 0);
    return players.filter((p) => p.isRadiant === radiant).reduce((s, p) => s + (p.kills ?? 0), 0);
  };
  return {
    match_id: Number(m.id),
    radiant_win: Boolean(m.didRadiantWin),
    radiant_score: kills(true),
    dire_score: kills(false),
    duration: m.durationSeconds ?? null,
    start_time: m.startDateTime ?? null,
    game_mode: GAME_MODE[m.gameMode] ?? null,
    lobby_type: LOBBY[m.lobbyType] ?? null,
    cluster: m.clusterId ?? null,
    patch: patchAt(m.startDateTime),
    // Net worth, not earned gold: kept apart from OpenDota's radiant_gold_adv
    // so no consumer reads one as the other (the engine knows both bases).
    radiant_net_worth_adv: leads(m.radiantNetworthLeads),
    radiant_xp_adv: leads(m.radiantExperienceLeads),
    players,
    // Not an OpenDota parse: never treated or stored as parsed.
    od_data: { has_parsed: false },
    data_source: 'stratz',
    stratz_fetched_at: fetchedAt,
  };
}

/**
 * @param {{ token: string, fetchImpl?: typeof fetch, timeoutMs?: number, log?: (m: string) => void }} options
 */
export function createStratzClient({ token, fetchImpl = (...a) => fetch(...a), timeoutMs = 15000, log = () => {} }) {
  const stats = { calls: 0, ok: 0, errors: 0, lastStatus: null };
  /** @param {number|string} matchId @param {{ signal?: AbortSignal }} [opts] the caller's cancellation, combined with the timeout */
  async function fetchMatch(matchId, { signal } = {}) {
    stats.calls += 1;
    let res;
    try {
      res = await fetchImpl(STRATZ_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'user-agent': 'STRATZ_API' },
        body: JSON.stringify({ query: MATCH_QUERY, variables: { id: Number(matchId) } }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (signal?.aborted) throw err; // the caller left: not a STRATZ failure
      stats.errors += 1;
      log(`match ${matchId}: ${err?.name || 'network error'}`);
      throw Object.assign(new Error('STRATZ fetch failed'), { upstream: 'stratz', retryable: true, cause: err });
    }
    stats.lastStatus = res.status;
    if (!res.ok) {
      stats.errors += 1;
      log(`match ${matchId}: HTTP ${res.status}`);
      throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, upstream: 'stratz', retryable: res.status >= 500 || res.status === 429 });
    }
    const body = await res.json().catch(() => null);
    if (!body?.data?.match) {
      stats.errors += 1;
      const msg = body?.errors?.[0]?.message ?? 'no match';
      log(`match ${matchId}: ${msg}`);
      throw Object.assign(new Error(`STRATZ: ${msg}`), { status: 404, upstream: 'stratz', retryable: false });
    }
    const mapped = mapStratzMatch(body.data.match);
    stats.ok += 1;
    return mapped;
  }
  return { fetchMatch, snapshot: () => ({ configured: true, ...stats }) };
}
