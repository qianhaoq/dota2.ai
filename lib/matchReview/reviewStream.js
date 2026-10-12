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
 * @param {'unconfigured' | 'provider' | 'invalid' | 'no_evidence' | 'no_timeline'} reason
 */
export function reviewAiUnavailableNotice(lang, reason = 'provider') {
  if (lang === 'zh') {
    if (reason === 'unconfigured') {
      return 'AI 洞察生成不可用（未配置 API Key），以下为基于比赛数据的默认复盘卡片。';
    }
    if (reason === 'invalid') {
      return 'AI 返回的复盘内容未通过校验，以下为基于比赛数据的默认复盘卡片。';
    }
    if (reason === 'no_evidence') {
      return '录像尚未解析（缺少时间线证据），以下为基于基础比赛数据的默认复盘卡片。';
    }
    if (reason === 'no_timeline') {
      return '该比赛缺少时间线证据，以下为基于基础比赛数据的默认复盘卡片。';
    }
    return 'AI 洞察生成失败，以下为基于比赛数据的默认复盘卡片。';
  }
  if (reason === 'unconfigured') {
    return 'AI insight unavailable (API key not configured); showing deterministic review cards from match data.';
  }
  if (reason === 'invalid') {
    return 'AI review response failed validation; showing deterministic review cards from match data.';
  }
  if (reason === 'no_evidence') {
    return 'Replay not parsed yet (no timeline evidence); showing deterministic review cards from basic match data.';
  }
  if (reason === 'no_timeline') {
    return 'No timeline evidence available for this match; showing deterministic review cards from basic match data.';
  }
  return 'AI insight generation failed; showing deterministic review cards from match data.';
}
