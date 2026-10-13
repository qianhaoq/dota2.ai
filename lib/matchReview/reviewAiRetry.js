/**
 * AI 复盘卡片的补齐重试决策流（无模块级 IO，便于单测）：
 * 首次输出不完整 → 重试一次 → 仍不完整则标记回退，由调用方改写兜底卡片。
 *
 * 客户端断开触发的中止会原样重抛：断开的客户端看不到任何响应，调用方
 * （server.js 外层 catch）应按断开静默退出，而不是继续构造回退卡片并
 * write/end 一个已提前关闭的响应 —— 提前关闭时 res.writableEnded 仍为
 * false，调用方的 writableEnded 守卫拦不住。注意 openai v4 中止时抛的是
 * APIUserAbortError（name 不是 'AbortError'），因此按「共享 signal 已中止」
 * 分类（isClientAbortError），不能只按错误名判断。
 * 只有真正的上游错误才降级为回退（记 non-fatal 日志）。
 */
import { isClientAbortError } from './parseRequestSubmit.js';
import {
  describeReviewCardsInvalidReason,
  isReviewAiCardsComplete,
  parseAiReviewCards,
} from './reviewCards.js';

/**
 * 解析首次 AI 输出，不完整时重试一次；重试仍不完整或遇到非断开错误时
 * 标记回退。
 * @param {{
 *   firstText: string,
 *   matchFact: object,
 *   lang: string,
 *   minKeyMoments: number,
 *   matchId: number,
 *   requestCompletionText: () => Promise<string>,
 *   signal?: AbortSignal,
 *   warn?: (msg: string) => void,
 * }} opts requestCompletionText 为注入的补全调用（返回模型文本）；
 *   signal 为客户端断开时中止的共享 signal。
 * @returns {Promise<{ reviewCards: object, usedFallback: boolean }>}
 *   usedFallback=true 表示首次与重试输出均不完整，调用方应改写兜底卡片。
 *   客户端断开时重抛原始中止错误（调用方按断开处理）。
 */
export async function resolveReviewCardsWithRetry(opts) {
  const warn = opts.warn ?? (() => {});
  const validateOpts = { minKeyMoments: opts.minKeyMoments };
  const reviewCards = parseAiReviewCards(opts.firstText, opts.matchFact, opts.lang);
  if (isReviewAiCardsComplete(reviewCards, validateOpts)) {
    return { reviewCards, usedFallback: false };
  }
  warn(`[review:ai-validation] match=${opts.matchId} attempt=1 result=invalid reason=${describeReviewCardsInvalidReason(reviewCards, validateOpts)}`);
  try {
    const retryText = await opts.requestCompletionText();
    const retryCards = parseAiReviewCards(retryText, opts.matchFact, opts.lang);
    if (isReviewAiCardsComplete(retryCards, validateOpts)) {
      return { reviewCards: retryCards, usedFallback: false };
    }
    warn(`[review:ai-validation] match=${opts.matchId} attempt=2 result=invalid reason=${describeReviewCardsInvalidReason(retryCards, validateOpts)}`);
  } catch (retryErr) {
    if (isClientAbortError(retryErr, opts.signal)) {
      // 客户端已断开：重抛（外层按断开静默退出），不降级写回退。
      throw retryErr;
    }
    warn(`[review:ai-retry] match=${opts.matchId} error=${retryErr?.name || 'unknown'} (non-fatal)`);
  }
  return { reviewCards, usedFallback: true };
}
