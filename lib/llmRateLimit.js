/**
 * LLM 路由的限流守卫（纯逻辑，便于单测）：
 * /api/chat、/api/analyze、/api/playbook、POST /api/suggestions、
 * POST /api/review/:matchId 每次真正要调用 LLM 的请求消耗预算（复盘卡片
 * 同样调用 LLM）；GET /api/review/:matchId 事实接口不限流。
 *
 * 用法（在处理器内部、请求校验与所有不调 LLM 的短路之后调用）：
 *   const gate = limit.acquire(req);
 *   if (!gate.ok) {
 *     if (gate.reason === 'cost_guard') { …确定性回退，绝不 429… }
 *     else return limit.respondRateLimited(req, res, gate.retryAfterSec);
 *   }
 * 这样 400/413（校验失败）、缓存命中与确定性回退都不消耗预算，垃圾流量
 * 无法耗尽真实用户依赖的额度（QA P1）。acquire 必须发生在写出任何 SSE
 * 头之前，超限请求拿到的是普通 JSON 429，而不是半路断流。
 *
 * 全局限额不再是 429 触发器：全局预算改为「成本护栏」——只有持续的全局
 * 滥用才会触发，触发时本次跳过 LLM、由调用方走既有的确定性回退，并且
 * 不消耗该客户端的每 IP 额度（没调 LLM 就不计数）。护栏触发按组每 60s
 * 聚合输出一条 WARNING（event: llm_cost_guard_tripped，不含任何机密）。
 */

import { normalizeUiLang } from './aiLanguage.js';
import { rateLimitKey } from './rateLimitKey.js';

/** 拒绝日志 / 护栏告警按组每 60s 至多一条（聚合计数）。 */
export const RATE_LIMIT_LOG_INTERVAL_MS = 60 * 1000;

/**
 * @param {{ limiter: { tryConsume: (clientId: string, atNow?: number) => { ok: boolean, retryAfterSec: number, reason?: 'global' | 'client' } },
 *           resolveClientIp: (req: unknown) => string,
 *           name?: string, keyFn?: (ip: unknown) => string,
 *           now?: () => number, log?: (msg: string) => void, warn?: (msg: string) => void }} options
 *   limiter        createSlidingWindowLimiter 实例（每组路由独享，互不挤占）；
 *                  其 globalLimit 即该组的成本护栏上限
 *   resolveClientIp 服务端的客户端 IP 解析（lib/clientIp.js 的封口）
 *   keyFn          IP → 限流键规范化（默认 lib/rateLimitKey.js：IPv6 按 /64）
 *   name           路由组名，仅用于限流日志
 *   now / log / warn 注入时钟与日志（测试用）；两类日志均按组每 60s 至多
 *   一行（聚合计数），绝不输出客户端 IP
 * @returns {{ acquire: (req: unknown) => { ok: true } | { ok: false, reason: 'rate_limited' | 'cost_guard', retryAfterSec: number },
 *             respondRateLimited: (req: unknown, res: { setHeader: Function, status: Function, json: Function }, retryAfterSec: number) => unknown }}
 */
export function createLlmRateLimit({
  limiter,
  resolveClientIp,
  name = 'llm',
  keyFn = rateLimitKey,
  now = () => Date.now(),
  log = (msg) => console.warn(msg),
  warn = log,
} = {}) {
  // Rejected requests consume no budget, so an abusive client could otherwise
  // make every attempt emit a log line: aggregate into one line per interval.
  let lastRejectionLogAt = -Infinity;
  let suppressedRejections = 0;
  let lastGuardLogAt = -Infinity;
  let suppressedGuardTrips = 0;

  const logRejection = (retryAfterSec) => {
    const at = now();
    if (at - lastRejectionLogAt >= RATE_LIMIT_LOG_INTERVAL_MS) {
      log(`[llm-rate-limit] ${name} limited (retry after ${retryAfterSec}s; ${suppressedRejections + 1} rejection(s) since last log)`);
      lastRejectionLogAt = at;
      suppressedRejections = 0;
    } else {
      suppressedRejections += 1;
    }
  };

  const logGuardTrip = (retryAfterSec) => {
    const at = now();
    if (at - lastGuardLogAt < RATE_LIMIT_LOG_INTERVAL_MS) {
      suppressedGuardTrips += 1;
      return;
    }
    warn(JSON.stringify({
      severity: 'WARNING',
      event: 'llm_cost_guard_tripped',
      group: name,
      retryAfterSec,
      trips: suppressedGuardTrips + 1,
    }));
    lastGuardLogAt = at;
    suppressedGuardTrips = 0;
  };

  return {
    /**
     * 原子地为一条即将调用 LLM 的请求消耗预算（先全局护栏后每 IP；被拒
     * 绝的请求不记账）。只在请求校验通过且确定要走 LLM 之后调用。
     * @param {unknown} req
     */
    acquire(req) {
      const result = limiter.tryConsume(keyFn(resolveClientIp(req)));
      if (result.ok) return { ok: true };
      if (result.reason === 'global') {
        logGuardTrip(result.retryAfterSec);
        return { ok: false, reason: 'cost_guard', retryAfterSec: result.retryAfterSec };
      }
      logRejection(result.retryAfterSec);
      return { ok: false, reason: 'rate_limited', retryAfterSec: result.retryAfterSec };
    },

    /**
     * 每 IP 超限的 429 JSON（error rate_limited + 本地化 message +
     * Retry-After 头）。必须在任何 SSE 头写出之前调用。
     * @param {{ body?: { lang?: unknown }, query?: { lang?: unknown } }} req
     * @param {import('express').Response} res
     * @param {number} retryAfterSec
     */
    respondRateLimited(req, res, retryAfterSec) {
      // 客户端 IP 只作限流键，绝不写进日志或响应。
      const lang = normalizeUiLang(req.body?.lang ?? req.query?.lang);
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: 'rate_limited',
        message: lang === 'zh'
          ? `请求过于频繁，请约 ${retryAfterSec} 秒后再试`
          : `Too many requests, please retry in about ${retryAfterSec}s`,
        retryAfter: retryAfterSec,
      });
    },
  };
}
