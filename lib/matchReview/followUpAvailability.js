/**
 * 追问可用性判定：追问与卡片共用同一条 provider 链（DeepSeek → Gemini），
 * 所以只要还有任何一个已配置、且本次请求的卡片阶段没有失败的追问
 * provider，追问就仍然可用。卡片因 DeepSeek 失败而落到 Gemini 时尤其不能
 * 清空 followups —— 客户端（src/utils/reviewSurface.ts 的
 * isReviewAiFollowUpAvailable）把空 followups 视为追问整体不可用。
 */

/**
 * @param {{
 *   deepseekConfigured: boolean,
 *   geminiConfigured: boolean,
 *   failedCardProviders?: Iterable<string> | null,
 * }} opts failedCardProviders 为本次请求内已失败的卡片 provider 名集合。
 * @returns {boolean} true 表示至少有一个已配置且本次未失败的追问 provider。
 */
export function followUpProvidersAvailable({ deepseekConfigured, geminiConfigured, failedCardProviders }) {
  const failed = new Set(failedCardProviders ?? []);
  return (deepseekConfigured && !failed.has('deepseek'))
    || (geminiConfigured && !failed.has('gemini'));
}
