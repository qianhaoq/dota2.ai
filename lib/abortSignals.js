/**
 * 组合多个 AbortSignal（纯工具，无 IO）。
 * 任一源信号中止时以该信号的 reason 中止；reason 会被保留，因此调用方
 * 能区分 AbortSignal.timeout() 的 TimeoutError 与客户端断开的 AbortError。
 */

/**
 * @param {Array<AbortSignal | undefined | null>} signals
 * @returns {AbortSignal | undefined}
 */
export function combineAbortSignals(signals) {
  const list = signals.filter(Boolean);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const controller = new AbortController();
  const onAbort = () => {
    controller.abort(list.find((s) => s.aborted)?.reason);
  };
  for (const signal of list) {
    if (signal.aborted) {
      onAbort();
      break;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}
