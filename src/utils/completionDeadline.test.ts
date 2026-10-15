import { describe, it, expect } from 'vitest';
import { withCompletionDeadline } from '../../lib/completionDeadline.js';

describe('withCompletionDeadline', () => {
  it('rejects with CompletionDeadlineError when headers arrive but the body never completes', async () => {
    let upstreamAborted = false;
    const stalledBody = (signal: AbortSignal) => {
      signal.addEventListener('abort', () => { upstreamAborted = true; });
      // headers "arrived": resolves nothing, body parse never settles
      return new Promise<never>(() => {});
    };
    await expect(withCompletionDeadline(stalledBody, { ms: 20 })).rejects.toMatchObject({ name: 'CompletionDeadlineError' });
    expect(upstreamAborted).toBe(true);
  });
  it('passes through results and client aborts unchanged', async () => {
    await expect(withCompletionDeadline(async () => 'ok', { ms: 1000 })).resolves.toBe('ok');
    const client = new AbortController();
    const p = withCompletionDeadline((s) => new Promise((_, rej) => s.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); })), { ms: 1000, signal: client.signal });
    client.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
