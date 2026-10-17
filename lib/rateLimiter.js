/**
 * 通用滑动窗口限流器（从 createAnalyticsRateLimiter 抽出，纯逻辑无 IO）：
 * 单客户端 + 全局两个预算挂在同一个滚动窗口上，超限时本次不记账
 * （被拒绝的请求不消耗预算）。时间源可注入，便于单测。
 *
 * 返回 { ok, retryAfterSec }：ok=false 时 retryAfterSec 是最早解除限制的
 * 秒数（向上取整，至少 1s），供 429 响应的 Retry-After 头使用。
 */

/** 默认最多追踪的客户端数（防内存放大；超出先清过期再丢最旧键）。 */
export const SLIDING_WINDOW_MAX_TRACKED_CLIENTS_DEFAULT = 2000;

/**
 * @param {{ limit?: number, globalLimit?: number, windowMs?: number, maxTrackedClients?: number, now?: () => number }} [options]
 *   limit          单客户端窗口内最大次数（默认 1）
 *   globalLimit    全局窗口内最大次数（默认不限）
 *   windowMs       窗口长度（毫秒）
 *   maxTrackedClients 客户端追踪表上限
 *   now            时间源（默认 Date.now）
 */
export function createSlidingWindowLimiter(options = {}) {
  const limit = options.limit ?? 1;
  const globalLimit = options.globalLimit ?? Number.MAX_SAFE_INTEGER;
  const windowMs = options.windowMs ?? 60 * 1000;
  const maxTrackedClients =
    options.maxTrackedClients ?? SLIDING_WINDOW_MAX_TRACKED_CLIENTS_DEFAULT;
  const now = options.now ?? (() => Date.now());

  /** @type {number[]} */
  let globalHits = [];
  /** @type {Map<string, number[]>} */
  const clientHits = new Map();

  const retryAfterSeconds = (oldestHit, atNow) =>
    oldestHit === undefined ? 1 : Math.max(1, Math.ceil((oldestHit + windowMs - atNow) / 1000));

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
     * 尝试为一次请求消耗预算：允许则记账返回 { ok:true, retryAfterSec:0 }；
     * 超限不记账返回 { ok:false, retryAfterSec:<秒> }。
     * @param {string} clientId 客户端标识（已解析的客户端 IP，仅作限流键，绝不落盘）
     * @param {number} [atNow]
     * @returns {{ ok: boolean, retryAfterSec: number }}
     */
    tryConsume(clientId, atNow = now()) {
      globalHits = globalHits.filter((t) => atNow - t < windowMs);
      if (globalHits.length >= globalLimit) {
        pruneClients(atNow);
        return { ok: false, retryAfterSec: retryAfterSeconds(globalHits[0], atNow) };
      }

      const key = String(clientId || 'unknown').slice(0, 64);
      const hits = (clientHits.get(key) || []).filter((t) => atNow - t < windowMs);
      if (hits.length >= limit) {
        clientHits.set(key, hits);
        pruneClients(atNow);
        return { ok: false, retryAfterSec: retryAfterSeconds(hits[0], atNow) };
      }

      globalHits.push(atNow);
      hits.push(atNow);
      clientHits.set(key, hits);
      pruneClients(atNow);
      return { ok: true, retryAfterSec: 0 };
    },
  };
}
