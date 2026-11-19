/**
 * Finds and caches the professional games behind the case studies.
 *
 * One OpenDota Explorer query per (hero set, key enemy) returns recent pro
 * games where one of the heroes faced the key enemy; up to `maxFetch` of them
 * are fetched and profiled. Pro games never change, so profiles (a few KB) are
 * cached for a long time and shared by every viewer; the raw match is dropped
 * straight after profiling. All IO is injected.
 */
import { buildCaseStudies, candidateProfile, keyEnemyOf, similarHeroes } from './cases.js';

const DAY = 24 * 60 * 60 * 1000;

/** SQL built from integers only — never from request text. */
export function caseCandidatesSql({ heroIds, enemyId, excludeMatchId, days = 180, limit = 40 }) {
  const ints = [...heroIds, enemyId, excludeMatchId, days, limit];
  if (!ints.every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error('caseCandidatesSql: integers only');
  const [first] = heroIds;
  return [
    'SELECT pm.match_id, pm.hero_id, pm.player_slot, m.start_time',
    'FROM matches m',
    `JOIN player_matches pm ON pm.match_id = m.match_id AND pm.hero_id IN (${heroIds.join(',')})`,
    `JOIN player_matches e ON e.match_id = m.match_id AND e.hero_id = ${enemyId} AND (e.player_slot < 128) <> (pm.player_slot < 128)`,
    `WHERE m.start_time > extract(epoch from now() - interval '${days} days') AND m.match_id <> ${excludeMatchId}`,
    `ORDER BY (pm.hero_id = ${first}) DESC, m.start_time DESC`,
    `LIMIT ${limit}`,
  ].join(' ');
}

function lru(max) {
  const map = new Map();
  return {
    get(k) {
      if (!map.has(k)) return undefined;
      const v = map.get(k); map.delete(k); map.set(k, v); return v;
    },
    set(k, v) {
      map.delete(k); map.set(k, v);
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get size() { return map.size; },
  };
}

/**
 * Same hero first; similar heroes fill the pool only when the same hero has
 * fewer than `minSame` games.
 */
export function chooseCandidates(rows, heroId, { maxFetch = 12, minSame = 6 } = {}) {
  const seen = new Set();
  const uniq = rows.filter((r) => (seen.has(r.match_id) ? false : (seen.add(r.match_id), true)));
  const same = uniq.filter((r) => r.hero_id === heroId);
  const other = uniq.filter((r) => r.hero_id !== heroId);
  const take = same.slice(0, maxFetch);
  if (take.length < minSame) take.push(...other.slice(0, maxFetch - take.length));
  return take;
}

/**
 * @param {{
 *   explorer: (sql: string) => Promise<{ rows: object[] }>,
 *   fetchMatch: (id: number) => Promise<object>,
 *   now?: () => number,
 *   maxFetch?: number,
 *   concurrency?: number,
 *   resultTtlMs?: number,
 *   log?: (msg: string) => void,
 * }} deps
 */
export function createCaseService(deps) {
  const { explorer, fetchMatch } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const maxFetch = deps.maxFetch ?? 12;
  const concurrency = deps.concurrency ?? 3;
  const resultTtlMs = deps.resultTtlMs ?? DAY / 2;
  const profiles = lru(3000); // `${matchId}:${player_slot}` -> profile | null
  const pools = lru(300); // `${heroId}:${enemyId}:${excludeId}` -> { at, value }
  const results = lru(300); // `${matchId}:${slot}:${pos}` -> { at, value }
  const inflight = new Map();

  async function profile(row) {
    const key = `${row.match_id}:${row.player_slot}`;
    const hit = profiles.get(key);
    if (hit !== undefined) return hit;
    const m = await fetchMatch(row.match_id);
    const slot = Array.isArray(m?.players) ? m.players.findIndex((p) => p.player_slot === row.player_slot) : -1;
    const p = slot < 0 ? null : candidateProfile(m, slot);
    profiles.set(key, p);
    return p;
  }

  async function pool(heroId, enemyId, excludeId) {
    const key = `${heroId}:${enemyId}:${excludeId}`;
    const hit = pools.get(key);
    if (hit && now() - hit.at < resultTtlMs) return hit.value;
    const heroIds = [heroId, ...similarHeroes(heroId)];
    const { rows = [] } = await explorer(caseCandidatesSql({ heroIds, enemyId, excludeMatchId: excludeId }));
    const picked = chooseCandidates(rows, heroId, { maxFetch });
    const out = [];
    let failed = 0;
    const queue = [...picked];
    const worker = async () => {
      while (queue.length) {
        const row = queue.shift();
        try {
          const p = await profile(row);
          if (p) out.push(p);
        } catch (e) {
          failed += 1;
          log(`case match ${row.match_id} failed: ${e?.message ?? e}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    // A pool where every fetch failed is an upstream outage, not "no cases".
    if (picked.length && !out.length && failed) throw new Error('case matches unavailable');
    pools.set(key, { at: now(), value: out });
    return out;
  }

  /**
   * Case studies for one player of an already-built, parsed report.
   * @param {{ report: any, slot: number, match: any, cacheKey?: string }} o
   * @returns {Promise<any>}
   */
  async function get({ report, slot, match, cacheKey }) {
    const key = cacheKey ?? `${report.match.id}:${slot}:${report.reviews[slot].role.pos ?? ''}`;
    const hit = results.get(key);
    if (hit && now() - hit.at < resultTtlMs) return hit.value;
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      const enemy = keyEnemyOf(report, slot);
      const heroId = report.players[slot].hero.id;
      const candidates = enemy == null ? [] : await pool(heroId, enemy, report.match.id);
      const value = buildCaseStudies({ report, slot, match, candidates });
      results.set(key, { at: now(), value });
      return value;
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  /**
   * Cached result only — never starts a fetch (for the follow-up context).
   * @param {{ report: any, slot: number, cacheKey?: string }} o
   * @returns {any}
   */
  function peek({ report, slot, cacheKey }) {
    const key = cacheKey ?? `${report.match.id}:${slot}:${report.reviews[slot].role.pos ?? ''}`;
    const hit = results.get(key);
    return hit && now() - hit.at < resultTtlMs ? hit.value : null;
  }

  return { get, peek };
}
