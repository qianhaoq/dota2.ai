/**
 * 未解析录像的可靠性策略（纯逻辑，无网络访问，便于单测）：
 * - isMatchParsed: 判断 OpenDota 比赛对象是否已含解析（replay）数据
 * - createParseRequestTracker: POST /request/{match_id} 的去重/限流
 * - parseStatusPayload: 返回给前端的 parse 状态（zh/en）
 */

/** 未解析数据只允许短缓存：OpenDota 解析完成后需尽快拿到新数据 */
export const UNPARSED_MATCH_CACHE_TTL_MS = 60 * 1000;
/** 同一场比赛的解析请求冷却窗口（避免重复提交 /request） */
export const PARSE_REQUEST_COOLDOWN_MS = 5 * 60 * 1000;
/** 解析请求失败后的短冷却：允许用户重试，但不至于打爆上游 */
export const PARSE_REQUEST_FAILURE_COOLDOWN_MS = 60 * 1000;
/** 建议用户多久后重试查询（OpenDota 解析通常需要几分钟） */
export const PARSE_RETRY_AFTER_SEC = 120;

/**
 * OpenDota 比赛是否已解析。od_data.has_parsed 是权威标记；
 * 旧数据可能没有该字段，则根据只有解析后才会出现的字段判断。
 * @param {object | null | undefined} match
 * @returns {boolean}
 */
export function isMatchParsed(match) {
  if (!match || typeof match !== 'object') return false;
  if (match.od_data?.has_parsed === true) return true;
  if (match.od_data?.has_parsed === false) return false;
  if (match.version != null && match.version !== false) return true;

  const players = Array.isArray(match.players) ? match.players : [];
  const hasParsedPlayerFields = players.some((p) => {
    const lanePosKeys = p?.lane_pos ? Object.keys(p.lane_pos).length : 0;
    return lanePosKeys > 0
      || (Array.isArray(p?.gold_t) && p.gold_t.length > 0)
      || (Array.isArray(p?.kills_log) && p.kills_log.length > 0);
  });
  if (hasParsedPlayerFields) return true;

  return (Array.isArray(match.objectives) && match.objectives.length > 0)
    || (Array.isArray(match.radiant_gold_adv) && match.radiant_gold_adv.length > 0)
    || (Array.isArray(match.radiant_xp_adv) && match.radiant_xp_adv.length > 0);
}

/**
 * 每场比赛的解析请求状态（内存去重 + 限流）。
 * @param {{ cooldownMs?: number, failureCooldownMs?: number, maxTracked?: number, now?: () => number }} [options]
 */
export function createParseRequestTracker(options = {}) {
  const cooldownMs = options.cooldownMs ?? PARSE_REQUEST_COOLDOWN_MS;
  const failureCooldownMs = options.failureCooldownMs ?? PARSE_REQUEST_FAILURE_COOLDOWN_MS;
  const maxTracked = options.maxTracked ?? 500;
  const now = options.now ?? (() => Date.now());

  /** @type {Map<number, { requestedAt: number, jobId: number | null, failed: boolean }>} */
  const entries = new Map();

  const prune = (atNow) => {
    if (entries.size <= maxTracked) return;
    const sorted = [...entries.entries()].sort((a, b) => a[1].requestedAt - b[1].requestedAt);
    for (const [id] of sorted.slice(0, Math.max(0, entries.size - maxTracked))) {
      entries.delete(id);
    }
    void atNow;
  };

  return {
    /**
     * 冷却窗口内的活跃条目（应返回 pending，不重复请求）。
     * @param {number} matchId
     * @param {number} [atNow]
     * @returns {{ jobId: number | null, failed: boolean, retryAfterSec: number } | null}
     */
    active(matchId, atNow = now()) {
      const entry = entries.get(matchId);
      if (!entry) return null;
      const windowMs = entry.failed ? failureCooldownMs : cooldownMs;
      const elapsed = atNow - entry.requestedAt;
      if (elapsed < 0 || elapsed >= windowMs) return null;
      return {
        jobId: entry.jobId ?? null,
        failed: Boolean(entry.failed),
        retryAfterSec: Math.max(1, Math.ceil((windowMs - elapsed) / 1000)),
      };
    },
    markRequested(matchId, atNow = now()) {
      entries.set(matchId, { requestedAt: atNow, jobId: null, failed: false });
      prune(atNow);
    },
    markResult(matchId, result = {}, atNow = now()) {
      const prev = entries.get(matchId);
      entries.set(matchId, {
        requestedAt: prev?.requestedAt ?? atNow,
        jobId: result.jobId ?? prev?.jobId ?? null,
        failed: Boolean(result.failed),
      });
      prune(atNow);
    },
  };
}

/**
 * @param {'requested' | 'pending' | 'parsed' | 'failed'} status
 * @param {string} lang
 * @param {number | null} retryAfterSec
 */
function parseStatusMessage(status, lang, retryAfterSec) {
  const isZh = lang === 'zh';
  const retry = retryAfterSec != null && retryAfterSec > 0;
  if (status === 'parsed') {
    return isZh ? '比赛录像数据已完成解析' : 'Match replay data is fully parsed';
  }
  if (status === 'requested') {
    return retry
      ? (isZh
        ? `已向 OpenDota 提交解析请求，约 ${retryAfterSec} 秒后重试即可获得分路与时间线数据`
        : `Parse requested from OpenDota — retry in ~${retryAfterSec}s to get lanes and timeline`)
      : (isZh ? '已向 OpenDota 提交解析请求，请稍后重试' : 'Parse requested from OpenDota — retry shortly');
  }
  if (status === 'pending') {
    return retry
      ? (isZh
        ? `OpenDota 正在解析本场比赛，约 ${retryAfterSec} 秒后重试即可`
        : `OpenDota is still parsing this match — retry in ~${retryAfterSec}s`)
      : (isZh ? 'OpenDota 正在解析本场比赛，请稍后重试' : 'OpenDota is still parsing this match — retry shortly');
  }
  return isZh
    ? '解析请求提交失败（基础数据仍可查看），请稍后重试'
    : 'Parse request failed (basic data is still shown) — retry later';
}

/**
 * @param {'requested' | 'pending' | 'parsed' | 'failed'} status
 * @param {{ jobId?: number | null, retryAfterSec?: number | null, lang?: string }} [options]
 */
export function parseStatusPayload(status, options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const retryAfterSec = status === 'parsed' || status === 'failed'
    ? null
    : (options.retryAfterSec ?? PARSE_RETRY_AFTER_SEC);
  return {
    status,
    jobId: options.jobId ?? null,
    retryAfterSec,
    message: parseStatusMessage(status, lang, retryAfterSec),
  };
}
