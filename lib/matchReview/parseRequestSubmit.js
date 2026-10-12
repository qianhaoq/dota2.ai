/**
 * OpenDota 解析请求（POST /request/{match_id}）的提交决策流：
 * 每场比赛去重（tracker）→ 全局/单客户端预算（budget）→ 提交 → 记账。
 * 网络与状态全部注入（fetchImpl/tracker/budget/日志），无模块级 IO，
 * 便于单测（server.js 只做装配）。
 *
 * 客户端断开触发的中止会被原样重抛且不记为失败：断开的客户端看不
 * 到任何响应，把该比赛标成 failed 只会让后续访客在失败冷却窗口内看
 * 到假的 failed 状态。中止只把 markRequested 写入的 pending 条目降级
 * 为短重试的「已中止」窗口 —— 被中止的 POST 可能从未到达 OpenDota，
 * 不能占着整段成功冷却挡住补交。只有真正的超时/上游失败才记失败。
 */
import { parseStatusPayload } from './matchParse.js';
import { combineAbortSignals } from '../abortSignals.js';

/** 解析提交（POST /request）的上游超时。 */
export const PARSE_REQUEST_TIMEOUT_MS = 8000;

/**
 * 是否 AbortSignal.timeout() 触发的超时中止（fetch 以 TimeoutError
 * DOMException 拒绝 —— name 与客户端断开的 AbortError 不同）。
 * @param {unknown} err
 * @returns {boolean}
 */
export function isTimeoutAbortError(err) {
  return err?.name === 'TimeoutError';
}

/**
 * 是否调用方（客户端断开）触发的中止：调用方 signal 已中止，且错误不是
 * 超时。竞态下（先超时、调用方随后断开）按超时处理 —— 请求确实失败了，
 * 值得记一次失败；调用方 signal 未中止时一律不算客户端中止。
 * @param {unknown} err
 * @param {AbortSignal} [callerSignal]
 * @returns {boolean}
 */
export function isClientAbortError(err, callerSignal) {
  return Boolean(callerSignal?.aborted) && !isTimeoutAbortError(err);
}

/**
 * @param {{
 *   tracker: ReturnType<typeof import('./matchParse.js').createParseRequestTracker>,
 *   budget: ReturnType<typeof import('./matchParse.js').createParseRequestBudget>,
 *   fetchImpl?: (url: string, init?: object) => Promise<{ ok: boolean, status?: number, json: () => Promise<object> }>,
 *   baseUrl?: string,
 *   apiKey?: string,
 *   timeoutMs?: number,
 *   log?: (msg: string) => void,
 *   warn?: (msg: string) => void,
 * }} options
 */
export function createParseRequestSubmitter(options = {}) {
  const { tracker, budget } = options;
  if (!tracker || !budget) {
    throw new TypeError('createParseRequestSubmitter requires tracker and budget');
  }
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const baseUrl = options.baseUrl ?? 'https://api.opendota.com/api';
  const apiKey = options.apiKey ?? '';
  const timeoutMs = options.timeoutMs ?? PARSE_REQUEST_TIMEOUT_MS;
  const log = options.log ?? (() => {});
  const warn = options.warn ?? (() => {});

  /**
   * 为一场未解析的比赛提交 OpenDota 解析请求（去重/预算/记账）。
   * @param {number} matchId
   * @param {string} clientIp 客户端标识（per-client 预算）
   * @param {{ signal?: AbortSignal, lang?: string }} [opts] signal 在客户端断开时中止上游提交
   * @returns {Promise<{ status: string, jobId: number | null, retryAfterSec: number | null, message: string }>}
   *   客户端断开时重抛原始中止错误（调用方按断开处理）。
   */
  return async function submitParseRequest(matchId, clientIp, opts = {}) {
    const { signal, lang } = opts;

    const active = tracker.active(matchId);
    if (active) {
      return parseStatusPayload(active.failed ? 'failed' : 'pending', {
        jobId: active.jobId,
        retryAfterSec: active.retryAfterSec,
        lang,
      });
    }

    // Over budget: do not submit — tell the client to back off instead.
    const overBudget = budget.tryConsume(clientIp);
    if (overBudget) {
      warn(`match=${matchId} throttled scope=${overBudget.scope} retryAfterSec=${overBudget.retryAfterSec}`);
      return parseStatusPayload('throttled', {
        retryAfterSec: overBudget.retryAfterSec,
        lang,
      });
    }

    tracker.markRequested(matchId);
    const url = `${baseUrl}/request/${matchId}${apiKey ? `?api_key=${encodeURIComponent(apiKey)}` : ''}`;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        signal: combineAbortSignals([signal, timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined]),
      });
      if (!res.ok) {
        tracker.markResult(matchId, { failed: true });
        warn(`match=${matchId} status=${res.status} (non-fatal)`);
        return parseStatusPayload('failed', { lang });
      }
      const body = await res.json().catch(() => ({}));
      const jobId = body?.job?.jobId ?? null;
      tracker.markResult(matchId, { jobId });
      log(`match=${matchId} requested jobId=${jobId ?? 'n/a'}`);
      return parseStatusPayload('requested', { jobId, lang });
    } catch (err) {
      if (isClientAbortError(err, signal)) {
        // 客户端已断开：重抛（外层按断开处理），不记失败。但
        // markRequested 已写入 pending 条目 —— 原样留着会让后续请求在
        // 整段成功冷却（5 分钟）里看到假的 pending 而不再补交，而被中止
        // 的 POST 可能从未到达 OpenDota。降级为短重试的「已中止」窗口。
        tracker.markAborted(matchId);
        throw err;
      }
      tracker.markResult(matchId, { failed: true });
      warn(`match=${matchId} error=${err?.name || 'unknown'} (non-fatal)`);
      return parseStatusPayload('failed', { lang });
    }
  };
}
