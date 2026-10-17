/**
 * LLM 路由的按 IP 限流中间件工厂（纯逻辑，便于单测）：
 * /api/chat、/api/analyze、/api/playbook、POST /api/suggestions、
 * POST /api/review/:matchId 每次命中都消耗预算（复盘卡片同样调用 LLM），
 * GET /api/review/:matchId 事实接口不限流。
 *
 * 超限一律回 JSON 429 + Retry-After 头。中间件挂在处理器之前，此时还没写
 * 任何 SSE 头，所以 SSE 请求也拿到的是普通 JSON 429，而不是半路断流。
 */

import { normalizeUiLang } from './aiLanguage.js';

/** Rejections are logged at most once per this interval per route group (count aggregated). */
export const RATE_LIMIT_LOG_INTERVAL_MS = 60 * 1000;

/**
 * @param {{ limiter: { tryConsume: (clientId: string, atNow?: number) => { ok: boolean, retryAfterSec: number } },
 *           resolveClientIp: (req: unknown) => string,
 *           name?: string, now?: () => number, log?: (msg: string) => void }} options
 *   limiter        createSlidingWindowLimiter 实例（每组路由独享，互不挤占）
 *   resolveClientIp 服务端的客户端 IP 解析（lib/clientIp.js 的封口）
 *   name           路由组名，仅用于限流日志
 *   now / log      注入时钟与日志（测试用）；拒绝日志按组每 60s 最多一行（聚合计数）
 */
export function createLlmRateLimitMiddleware({ limiter, resolveClientIp, name = 'llm', now = () => Date.now(), log = (msg) => console.warn(msg) } = {}) {
  // Rejected requests consume no budget, so an abusive client could otherwise
  // make every attempt emit a log line: aggregate into one line per interval.
  let lastLogAt = -Infinity;
  let suppressed = 0;
  return function llmRateLimit(req, res, next) {
    const { ok, retryAfterSec } = limiter.tryConsume(resolveClientIp(req));
    if (ok) return next();
    // 客户端 IP 只作限流键，绝不写进日志。
    const at = now();
    if (at - lastLogAt >= RATE_LIMIT_LOG_INTERVAL_MS) {
      log(`[llm-rate-limit] ${name} limited (retry after ${retryAfterSec}s; ${suppressed + 1} rejection(s) since last log)`);
      lastLogAt = at;
      suppressed = 0;
    } else {
      suppressed += 1;
    }
    const lang = normalizeUiLang(req.body?.lang ?? req.query?.lang);
    res.setHeader('Retry-After', String(retryAfterSec));
    return res.status(429).json({
      error: 'rate_limited',
      message: lang === 'zh'
        ? `请求过于频繁，请约 ${retryAfterSec} 秒后再试`
        : `Too many requests, please retry in about ${retryAfterSec}s`,
      retryAfter: retryAfterSec,
    });
  };
}
