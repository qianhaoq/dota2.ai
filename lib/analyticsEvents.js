/**
 * 埋点事件校验（纯逻辑，无网络访问，便于单测）：
 * - validateAnalyticsEvent: POST /api/events 的 { event, props, anonId } 白名单
 *   校验与 PII 清洗
 * - createAnalyticsRateLimiter: 滑动窗口限流（实现抽到 lib/rateLimiter.js
 *   共用；这里保持既有的布尔 tryConsume 接口不变）
 *
 * 隐私约束：不落 IP、不落自由文本。props 只保留标量，字符串值与键名都
 * 必须是短标识（preset/custom 一类的标记值），不满足的直接丢弃。
 */

import { createSlidingWindowLimiter } from './rateLimiter.js';

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

export const ANON_ID_FORMAT_RE = /^anon_(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-z]{6,12}\.[0-9a-z]{4,10})$/;

/**
 * 每个事件允许的 props 键名及取值白名单（函数返回 true 表示合法）。
 * 不在白名单内的键 / 值一律丢弃，杜绝自由文本或 PII 进入日志。
 */
const MATCH_ID_RE = /^\d{1,20}$/;
export const ANALYTICS_PROP_ALLOWLIST = {
  review_viewed: { matchId: (v) => typeof v === 'string' && MATCH_ID_RE.test(v) },
  followup_clicked: { kind: (v) => v === 'preset' || v === 'custom' },
  fakedoor_clicked: { kind: (v) => v === 'steam_autoreview' },
  return_visit: {},
};

/**
 * 清洗 props：只保留标量值；字符串值与键名都须是短标识（preset/custom 等
 * 标记），数字须是有限且量级合理；其余（对象/数组/null/自由文本/自由文本
 * 键名）一律丢弃。
 * @param {unknown} raw
 * @returns {Record<string, string | number | boolean>}
 */
export function sanitizeAnalyticsProps(raw, event = "") {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const allow = ANALYTICS_PROP_ALLOWLIST[event];
  if (!allow) return {};
  const out = {};
  for (const [key, check] of Object.entries(allow)) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const value = raw[key];
    if (check(value)) out[key] = value;
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
  // 只接受客户端生成格式（anon_ + UUID，或 anon_ + base36 时间戳.随机串回退），
  // 电话 / IP / 邮箱等任意标识符形态的输入一律归零。
  if (!ANON_ID_FORMAT_RE.test(trimmed)) return null;
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
    props: sanitizeAnalyticsProps(raw.props, event),
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
 * 超限时本次不记账。算法在 lib/rateLimiter.js；这里只钉住 /api/events 的
 * 默认预算，并保持布尔返回值的既有接口。
 * @param {{ limit?: number, globalLimit?: number, windowMs?: number, maxTrackedClients?: number, now?: () => number }} [options]
 */
export function createAnalyticsRateLimiter(options = {}) {
  const limiter = createSlidingWindowLimiter({
    limit: options.limit ?? ANALYTICS_RATE_LIMIT_PER_CLIENT,
    globalLimit: options.globalLimit ?? ANALYTICS_RATE_LIMIT_GLOBAL,
    windowMs: options.windowMs ?? ANALYTICS_RATE_WINDOW_MS,
    maxTrackedClients: options.maxTrackedClients ?? ANALYTICS_RATE_MAX_TRACKED_CLIENTS,
    now: options.now,
  });

  return {
    /**
     * 尝试为一次事件消耗预算：允许则记账并返回 true，超限不记账返回 false。
     * @param {string} clientId 客户端标识（已解析的客户端 IP，仅用于限流，绝不落盘）
     * @param {number} [atNow]
     * @returns {boolean}
     */
    tryConsume(clientId, atNow) {
      return limiter.tryConsume(clientId, atNow).ok;
    },
  };
}
