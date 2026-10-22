import { requestCardCompletion } from './cardCompletion.js';
/** Opt-in adapter. Caller supplies the server's resolved DEEPSEEK_MODEL and client. */
export function createPhrasingCompletion({ client, model, extraBody = {}, timeoutMs = 8000 }) {
  return async (input, { signal } = {}) => {
    let usage;
    const result = await requestCardCompletion({
      providers: [{ name: 'deepseek', create: async attemptSignal => {
        const response = await client.chat.completions.create({ ...extraBody, model, stream: false,
          messages: [{ role: 'system', content: input.instruction }, { role: 'user', content: JSON.stringify(input) }],
        }, { signal: attemptSignal, maxRetries: 0 });
        usage = response.usage;
        return response;
      } }],
      failed: new Set(), startedAt: Date.now(), budgetMs: timeoutMs,
      perAttemptMs: timeoutMs, minAttemptMs: 1, signal,
    });
    return { ...result, usage };
  };
}
