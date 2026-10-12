/**
 * 单场比赛详情缓存（review / match-facts 用）。
 * 关键策略：
 * - 已解析数据按长 TTL 缓存；
 * - 未解析数据只按短 TTL 缓存（UNPARSED_MATCH_CACHE_TTL_MS），
 *   过期后重新拉上游，若上游已解析则替换缓存条目；
 * - 永不让未解析数据覆盖已解析条目（不降级）；
 * - 上游拉取失败时若有旧条目则返回旧数据（stale-if-error）。
 */
import { isMatchParsed, UNPARSED_MATCH_CACHE_TTL_MS } from './matchParse.js';

export const MATCH_DETAIL_CACHE_TTL_MS = 60 * 60 * 1000;
export const MATCH_DETAIL_CACHE_MAX = 50;

/**
 * @param {{ data: object, timestamp: number } | undefined} entry
 * @param {number} [atNow]
 */
export function isMatchDetailEntryFresh(entry, atNow = Date.now()) {
  if (!entry || !entry.data) return false;
  const ttl = isMatchParsed(entry.data) ? MATCH_DETAIL_CACHE_TTL_MS : UNPARSED_MATCH_CACHE_TTL_MS;
  return atNow - entry.timestamp < ttl;
}

/**
 * 未解析的新数据不得覆盖已解析的旧条目。
 * @param {{ data: object, timestamp: number } | undefined} prevEntry
 * @param {object} nextData
 */
export function shouldReplaceMatchDetailEntry(prevEntry, nextData) {
  if (!prevEntry || !prevEntry.data) return true;
  if (isMatchParsed(prevEntry.data) && !isMatchParsed(nextData)) return false;
  return true;
}

/**
 * @param {{ fetchMatch: (matchId: number, options?: object) => Promise<object>, maxEntries?: number, now?: () => number, log?: (msg: string) => void }} options
 */
export function createMatchDetailCache(options = {}) {
  const fetchMatch = options.fetchMatch;
  if (typeof fetchMatch !== 'function') {
    throw new TypeError('createMatchDetailCache requires a fetchMatch function');
  }
  const maxEntries = options.maxEntries ?? MATCH_DETAIL_CACHE_MAX;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});

  /** @type {Map<number, { data: object, timestamp: number }>} */
  const entries = new Map();

  /**
   * 过期条目清理 + 容量淘汰。keepId 对应的条目不按过期删除：
   * 它是本次 get 的 stale 兜底与「未解析不得覆盖已解析」守卫的依据。
   */
  const evict = (atNow, keepId = null) => {
    for (const [id, entry] of entries) {
      if (id === keepId) continue;
      if (!isMatchDetailEntryFresh(entry, atNow)) entries.delete(id);
    }
    while (entries.size > maxEntries) {
      let oldestId = null;
      let oldestTs = Infinity;
      for (const [id, entry] of entries) {
        if (entry.timestamp < oldestTs) {
          oldestTs = entry.timestamp;
          oldestId = id;
        }
      }
      if (oldestId === null) break;
      entries.delete(oldestId);
    }
  };

  return {
    /**
     * @param {number} matchId
     * @param {object} [fetchOptions] 透传给 fetchMatch（如 AbortSignal）
     */
    async get(matchId, fetchOptions = {}) {
      const startedAt = now();
      evict(startedAt, matchId);
      const cached = entries.get(matchId);
      if (isMatchDetailEntryFresh(cached, startedAt)) {
        return cached.data;
      }

      let data;
      try {
        data = await fetchMatch(matchId, fetchOptions);
      } catch (err) {
        // 上游失败时，过期条目仍好于 5xx（只读复盘数据）。
        if (cached && !(fetchOptions.signal?.aborted)) {
          log(`match=${matchId} upstream_error_served_stale`);
          return cached.data;
        }
        throw err;
      }

      if (shouldReplaceMatchDetailEntry(cached, data)) {
        entries.set(matchId, { data, timestamp: now() });
      } else {
        // 上游返回未解析数据但缓存已有解析数据：保留解析条目。
        log(`match=${matchId} kept_parsed_entry_over_unparsed_refresh`);
        return cached.data;
      }
      evict(now(), matchId);
      return data;
    },
  };
}
