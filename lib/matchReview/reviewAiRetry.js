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
  extractJsonFromLlmOutput,
  isReviewAiCardsComplete,
  parseAiReviewCards,
} from './reviewCards.js';

/**
 * Best-effort: the model's raw primary_mistake category + cited factKeys
 * (before normalization drops an ungrounded mistake). Never throws.
 * @param {string} text
 */
export function rawPrimaryMistakeFields(text) {
  try {
    // Same recovery parser as validation, so malformed-but-recovered outputs
    // still log their category/evidence dimensions.
    const pm = extractJsonFromLlmOutput(String(text || ''))?.primary_mistake;
    return {
      category: typeof pm?.category === 'string' ? pm.category.slice(0, 40) : null,
      evidenceKeys: Array.isArray(pm?.evidence)
        ? pm.evidence.map((e) => (typeof e?.factKey === 'string' ? e.factKey.slice(0, 40) : null)).filter(Boolean).slice(0, 12)
        : [],
    };
  } catch {
    return { category: null, evidenceKeys: [] };
  }
}

/**
 * One JSON line per validation attempt (valid AND invalid) so Cloud Logging
 * log-based metrics can count the denominator and group by reason/category:
 * jsonPayload.event="review_ai_validation".
 * @param {(line: string) => void} sink
 * @param {object} fields
 */
function emitValidationMetric(sink, fields) {
  sink(JSON.stringify({ severity: fields.result === 'valid' ? 'INFO' : 'WARNING', event: 'review_ai_validation', ...fields }));
}

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
 *   metric?: (jsonLine: string) => void,
 * }} opts requestCompletionText 为注入的补全调用（返回模型文本）；
 *   signal 为客户端断开时中止的共享 signal。
 * @returns {Promise<{ reviewCards: object, usedFallback: boolean }>}
 *   usedFallback=true 表示首次与重试输出均不完整，调用方应改写兜底卡片。
 *   客户端断开时重抛原始中止错误（调用方按断开处理）。
 */
export async function resolveReviewCardsWithRetry(opts) {
  const warn = opts.warn ?? (() => {});
  const metric = opts.metric ?? (() => {});
  const validateOpts = { minKeyMoments: opts.minKeyMoments };
  const record = (attempt, text, cards) => {
    const valid = isReviewAiCardsComplete(cards, validateOpts);
    // Unparseable output used to surface as primary_mistake_not_grounded
    // (first check to fail); report it as its own reason.
    const reason = valid
      ? 'ok'
      : (extractJsonFromLlmOutput(text) == null ? 'json_unparseable' : describeReviewCardsInvalidReason(cards, validateOpts));
    emitValidationMetric(metric, {
      matchId: opts.matchId,
      lang: opts.lang,
      attempt,
      result: valid ? 'valid' : 'invalid',
      reason,
      ...rawPrimaryMistakeFields(text),
    });
    return { valid, reason };
  };
  const reviewCards = parseAiReviewCards(opts.firstText, opts.matchFact, opts.lang);
  const first = record(1, opts.firstText, reviewCards);
  if (first.valid) {
    return { reviewCards, usedFallback: false };
  }
  warn(`[review:ai-validation] match=${opts.matchId} attempt=1 result=invalid reason=${first.reason}`);
  try {
    const retryText = await opts.requestCompletionText();
    const retryCards = parseAiReviewCards(retryText, opts.matchFact, opts.lang);
    const second = record(2, retryText, retryCards);
    if (second.valid) {
      return { reviewCards: retryCards, usedFallback: false };
    }
    warn(`[review:ai-validation] match=${opts.matchId} attempt=2 result=invalid reason=${second.reason}`);
  } catch (retryErr) {
    if (isClientAbortError(retryErr, opts.signal)) {
      // 客户端已断开：重抛（外层按断开静默退出），不降级写回退。
      throw retryErr;
    }
    warn(`[review:ai-retry] match=${opts.matchId} error=${retryErr?.name || 'unknown'} (non-fatal)`);
  }
  return { reviewCards, usedFallback: true };
}
