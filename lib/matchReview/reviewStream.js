export const TERMINAL_FINISH_REASONS = new Set(['stop', 'length', 'content_filter']);

/**
 * @param {string | null | undefined} finishReason
 */
export function isTerminalStreamFinish(finishReason) {
  return finishReason != null && TERMINAL_FINISH_REASONS.has(finishReason);
}

/**
 * Non-destructive notice when initial review falls back to deterministic cards.
 * @param {string} lang
 * @param {'unconfigured' | 'provider'} reason
 */
export function reviewAiUnavailableNotice(lang, reason = 'provider') {
  if (lang === 'zh') {
    if (reason === 'unconfigured') {
      return 'AI 洞察生成不可用（未配置 API Key），以下为基于比赛数据的默认复盘卡片。';
    }
    return 'AI 洞察生成失败，以下为基于比赛数据的默认复盘卡片。';
  }
  if (reason === 'unconfigured') {
    return 'AI insight unavailable (API key not configured); showing deterministic review cards from match data.';
  }
  return 'AI insight generation failed; showing deterministic review cards from match data.';
}
