export const TERMINAL_FINISH_REASONS = new Set(['stop', 'length', 'content_filter']);

/**
 * @param {string | null | undefined} finishReason
 */
export function isTerminalStreamFinish(finishReason) {
  return finishReason != null && TERMINAL_FINISH_REASONS.has(finishReason);
}
