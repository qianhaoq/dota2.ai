/**
 * 埋点事件校验（纯逻辑，无网络访问，便于单测）：
 * - validateAnalyticsEvent: POST /api/events 的 { event, props, anonId } 白名单
 *   校验与 PII 清洗
 * - createAnalyticsRateLimiter: 与 /api/feedback 同款的滑动窗口限流
 *
 * 隐私约束：不落 IP、不落自由文本。props 只保留标量，字符串必须是短标识
 * （preset/custom 一类的标记值），不满足的直接丢弃。
 */

/** 允许上报的事件名白名单。 */
export const ANALYTICS_EVENTS = [
  'review_viewed',
  'followup_clicked',
  'fakedoor_clicked',
  'return_visit',
];

/** props 最多保留的键数。 */
export const ANALYTICS_MAX_PROPS = 8;
/** props 字符串值 / anonId 的最大长度（按码点计）。 */
export const ANALYTICS_MAX_STRING = 64;
/** props 数值的绝对值上限（超出按无效丢弃，防 Infinity/1e308 之类噪声）。 */
export const ANALYTICS_MAX_NUMBER = 1e9;

/** 标记类字符串：字母/数字/下划点冒连字符，无空格、无自由文本。 */
const IDENTIFIER_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

const EVENT_SET = new Set(ANALYTICS_EVENTS);

/**
 * 清洗 props：只保留标量值；字符串须是短标识（preset/custom 等标记），
 * 数字须是有限且量级合理；其余（对象/数组/null/自由文本）一律丢弃。
 * @param {unknown} raw
 * @returns {Record<string, string | number | boolean>}
 */
export function sanitizeAnalyticsProps(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= ANALYTICS_MAX_PROPS) break;
    if (typeof value === 'boolean') {
      out[key.slice(0, ANALYTICS_MAX_STRING)] = value;
    } else if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= ANALYTICS_MAX_NUMBER) {
      out[key.slice(0, ANALYTICS_MAX_STRING)] = value;
    } else if (typeof value === 'string' && IDENTIFIER_RE.test(value)) {
      out[key.slice(0, ANALYTICS_MAX_STRING)] = value;
    }
    // 其余类型/自由文本：视为 PII，丢弃。
  }
  return out;
}

/**
 * anonId 只接受短标识；不合规（含 PII 或过长）时归零为 null，事件照收。
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeAnalyticsAnonId(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!IDENTIFIER_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * 校验一条埋点事件。
 * @param {unknown} raw 请求体
 * @returns {{ ok: true, event: string, props: Record<string, string | number | boolean>, anonId: string | null } | { ok: false, error: 'invalid_body' | 'invalid_event' }}
 */
export function validateAnalyticsEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'invalid_body' };
  }
  const event = typeof raw.event === 'string' ? raw.event.trim() : '';
  if (!EVENT_SET.has(event)) {
    return { ok: false, error: 'invalid_event' };
  }
  return {
    ok: true,
    event,
    props: sanitizeAnalyticsProps(raw.props),
    anonId: normalizeAnalyticsAnonId(raw.anonId),
  };
}

/** 默认限流：单客户端每小时 120 条，全局每小时 5000 条。 */
export const ANALYTICS_RATE_LIMIT_PER_CLIENT = 120;
export const ANALYTICS_RATE_LIMIT_GLOBAL = 5000;
export const ANALYTICS_RATE_WINDOW_MS = 60 * 60 * 1000;
export const ANALYTICS_RATE_MAX_TRACKED_CLIENTS = 2000;

/**
 * 滑动窗口限流（与 /api/feedback、解析提交预算同一模式）：先全局后单客户端，
 * 超限时本次不记账。
 * @param {{ limit?: number, globalLimit?: number, windowMs?: number, maxTrackedClients?: number, now?: () => number }} [options]
 */
export function createAnalyticsRateLimiter(options = {}) {
  const limit = options.limit ?? ANALYTICS_RATE_LIMIT_PER_CLIENT;
  const globalLimit = options.globalLimit ?? ANALYTICS_RATE_LIMIT_GLOBAL;
  const windowMs = options.windowMs ?? ANALYTICS_RATE_WINDOW_MS;
  const maxTrackedClients = options.maxTrackedClients ?? ANALYTICS_RATE_MAX_TRACKED_CLIENTS;
  const now = options.now ?? (() => Date.now());

  /** @type {number[]} */
  let globalHits = [];
  /** @type {Map<string, number[]>} */
  const clientHits = new Map();

  const pruneClients = (atNow) => {
    for (const [ip, hits] of clientHits) {
      const kept = hits.filter((t) => atNow - t < windowMs);
      if (kept.length === 0) clientHits.delete(ip);
      else clientHits.set(ip, kept);
    }
    while (clientHits.size > maxTrackedClients) {
      const oldest = clientHits.keys().next().value;
      if (oldest === undefined) break;
      clientHits.delete(oldest);
    }
  };

  return {
    /**
     * 尝试为一次事件消耗预算：允许则记账并返回 true，超限不记账返回 false。
     * @param {string} clientId 客户端标识（已解析的客户端 IP，仅用于限流，绝不落盘）
     * @param {number} [atNow]
     * @returns {boolean}
     */
    tryConsume(clientId, atNow = now()) {
      globalHits = globalHits.filter((t) => atNow - t < windowMs);
      if (globalHits.length >= globalLimit) {
        pruneClients(atNow);
        return false;
      }

      const key = String(clientId || 'unknown').slice(0, 64);
      const hits = (clientHits.get(key) || []).filter((t) => atNow - t < windowMs);
      if (hits.length >= limit) {
        clientHits.set(key, hits);
        pruneClients(atNow);
        return false;
      }

      globalHits.push(atNow);
      hits.push(atNow);
      clientHits.set(key, hits);
      pruneClients(atNow);
      return true;
    },
  };
}
