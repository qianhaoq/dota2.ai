/**
 * Client-disconnect abort for SSE routes（QA P2）：/api/playbook 曾在 upstream
 * 工作开始之后才注册 req.on('close')，断开时 OpenDota/DeepSeek 调用照跑到底。
 * createSseAbort 在任何 upstream 调用之前武装监听，交出一个共享 AbortSignal
 * 给 fetch 与 chat.completions.create({ signal })。
 *
 * res 'close' + writableEnded 是现代 Node 的可靠信号（req 'close' 在新版
 * Node 里请求体结束时也会触发，那不是断开）；req 'aborted' 兜底覆盖请求
 * 中途被粗暴终止的旧语义。两种响应模式（SSE / JSON）都适用。
 */

/**
 * @param {import('node:events').EventEmitter & { writableEnded?: boolean }} res
 * @param {import('node:events').EventEmitter} req
 * @returns {{ signal: AbortSignal, aborted: () => boolean, detach: () => void }}
 */
export function createSseAbort(req, res) {
  const controller = new AbortController();
  const onClientGone = () => {
    // res 'close' also fires after a fully written response — that is a normal
    // completion (writableEnded), not a client disconnect, so nothing to abort.
    if (res.writableEnded) return;
    controller.abort();
  };
  res.on('close', onClientGone);
  req.on('aborted', onClientGone);

  return {
    signal: controller.signal,
    aborted: () => controller.signal.aborted,
    detach: () => {
      res.removeListener('close', onClientGone);
      req.removeListener('aborted', onClientGone);
    },
  };
}
