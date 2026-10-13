/**
 * 复盘接口的响应封装：同一业务流程可输出 SSE（Accept: text/event-stream）
 * 或单个 JSON 结果（其他 Accept），不再对非 SSE 请求返回裸 406。
 */

/**
 * 客户端是否要求 SSE 流式响应。
 * @param {string | undefined} acceptHeader
 */
export function wantsReviewStream(acceptHeader) {
  return String(acceptHeader || '').includes('text/event-stream');
}

/**
 * @param {import('express').Response} res
 * @param {object} payload
 */
export function sendReviewSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * @param {import('express').Response} res
 * @param {object} [payload]
 */
export function endReviewSse(res, payload) {
  if (payload) sendReviewSse(res, payload);
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * 统一响应器：SSE 模式逐事件写入；JSON 模式累积为单个结果
 * （`text` 分片按顺序拼接，其余键后写覆盖先写）。
 * @param {import('express').Response} res
 * @param {boolean} wantsStream
 */
export function createReviewResponder(res, wantsStream) {
  /** @type {Record<string, unknown>} */
  const jsonResult = {};
  return {
    begin() {
      if (!wantsStream || res.headersSent) return;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
    },
    send(payload) {
      if (!payload) return;
      if (wantsStream) {
        sendReviewSse(res, payload);
        return;
      }
      for (const [key, value] of Object.entries(payload)) {
        if (value === undefined) continue;
        jsonResult[key] = key === 'text' && typeof value === 'string'
          ? (jsonResult[key] || '') + value
          : value;
      }
    },
    end(payload) {
      if (payload) this.send(payload);
      if (wantsStream) {
        endReviewSse(res);
        return;
      }
      if (res.writableEnded) return;
      res.status(jsonResult.error ? 502 : 200).json(jsonResult);
    },
  };
}
