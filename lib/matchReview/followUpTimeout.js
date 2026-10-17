/**
 * 追问单次尝试超时的预算钳制：REVIEW_FOLLOW_UP_ATTEMPT_TIMEOUT_MS 可由环境
 * 变量配置，但无论配成多大，抓取阶段 + 全部追问尝试都必须落在请求总预算
 * REVIEW_REQUEST_BUDGET_MS 内（并因此低于客户端固定的 180s 复盘超时）。运行
 * 期还会用请求剩余预算再夹一次（见 followUpCompletion.js 的
 * cardAttemptDeadlineMs）。
 */
import { parsePositiveInt } from '../positiveInt.js';

export const DEFAULT_FOLLOW_UP_ATTEMPT_MS = 40000;

/**
 * Clamp a configured follow-up attempt timeout (env string, number, anything)
 * into [minAttemptMs, floor((requestBudgetMs - fetchBudgetMs) / maxAttempts)].
 * Invalid values (non-numeric, NaN, <= 0) fall back to the 40s default; the
 * default is clamped too, so tightening the budgets tightens it as well.
 * Values are parsed with parsePositiveInt (Number, not parseInt) so scientific
 * notation like '1e9' or '4e4' keeps its magnitude: 1e9 clamps up here to the
 * ceiling instead of silently becoming 1ms.
 * @param {unknown} raw
 * @param {{ fetchBudgetMs: number, requestBudgetMs: number, maxAttempts: number, minAttemptMs?: number }} opts
 * @returns {number}
 */
export function clampFollowUpAttemptMs(raw, { fetchBudgetMs, requestBudgetMs, maxAttempts, minAttemptMs = 0 }) {
  const requested = parsePositiveInt(raw, DEFAULT_FOLLOW_UP_ATTEMPT_MS);
  const ceiling = Math.floor((requestBudgetMs - fetchBudgetMs) / maxAttempts);
  return Math.max(minAttemptMs, Math.min(requested, ceiling));
}
