/**
 * 复盘追问的流式补全（QA P2 #4）：按序尝试 provider 链（DeepSeek → Gemini），
 * 每次尝试跑在应用侧 deadline 下（AbortController 信号传入 SDK，超时中止）。
 * 在尚未转发任何正文分片前失败/超时的尝试顺延到下一个 provider；一旦已有
 * 分片发给客户端，流即「已提交」——之后超时只报告 incomplete（重试会向客户
 * 端重复推送已发过的文本）。客户端断开的原样重抛（与卡片链一致）。
 */
import { withCompletionDeadline } from '../completionDeadline.js';
import { isClientAbortError } from './parseRequestSubmit.js';

/**
 * @typedef {{ name: string, create: (signal: AbortSignal) => Promise<any> }} FollowUpProvider
 */

/**
 * @param {{
 *   providers: FollowUpProvider[],
 *   attemptMs: number,
 *   signal?: AbortSignal,
 *   onText: (text: string) => void,
 *   shouldStop?: () => boolean,
 *   onProviderError?: (info: { provider: string, error: string, raw: unknown }) => void,
 * }} opts signal 为客户端断开时中止的共享信号；onText 每个正文分片调用一次。
 * @returns {Promise<{ status: 'done' | 'incomplete' | 'failed' | 'stopped', finishReason: string | null, provider?: string }>}
 *   done=正常结束；incomplete=已转发部分文本后中断（不重试）；failed=所有
 *   provider 都在转发任何文本前失败（调用方应答通用脱敏错误）；stopped=调用
 *   方 shouldStop 为真（客户端已断开/响应已结束）。
 */
export async function streamFollowUpCompletion(opts) {
  for (const p of opts.providers) {
    let forwarded = false;
    try {
      const result = await withCompletionDeadline(async (deadlineSignal) => {
        const stream = await p.create(deadlineSignal);
        let finishReason = null;
        for await (const chunk of stream) {
          if (opts.shouldStop?.()) return { stopped: true, finishReason };
          const choice = chunk.choices?.[0];
          const content = choice?.delta?.content;
          if (content) {
            forwarded = true;
            opts.onText(content);
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
        }
        return { stopped: false, finishReason };
      }, { ms: opts.attemptMs, signal: opts.signal });
      return {
        status: result.stopped ? 'stopped' : 'done',
        finishReason: result.finishReason,
        provider: p.name,
      };
    } catch (err) {
      if (isClientAbortError(err, opts.signal)) throw err;
      const failure = err?.name === 'CompletionDeadlineError'
        ? 'deadline'
        : (err?.status ? `http_${err.status}` : (err?.name || 'error'));
      opts.onProviderError?.({ provider: p.name, error: failure, raw: err });
      if (forwarded) {
        // Text already reached the client: a retry on the next provider would
        // duplicate it. Surface as incomplete; the caller ends the stream.
        return { status: 'incomplete', finishReason: null, provider: p.name };
      }
    }
  }
  return { status: 'failed', finishReason: null };
}
