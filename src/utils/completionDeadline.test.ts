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

import { cardAttemptDeadlineMs } from '../../lib/completionDeadline.js';
describe('cardAttemptDeadlineMs', () => {
  const base = { startedAt: 0, budgetMs: 270000, perAttemptMs: 90000, minAttemptMs: 5000 };
  it('caps by per-attempt and by remaining request budget', () => {
    expect(cardAttemptDeadlineMs({ ...base, now: 10000 })).toBe(90000);
    // slow OpenDota (135s) + invalid first attempt at 89s -> retry gets only 46s
    expect(cardAttemptDeadlineMs({ ...base, now: 224000 })).toBe(46000);
  });
  it('skips the attempt when the budget is exhausted', async () => {
    expect(cardAttemptDeadlineMs({ ...base, now: 268000 })).toBe(0);
    await expect(withCompletionDeadline(async () => 'x', { ms: 0 })).rejects.toMatchObject({ name: 'CompletionDeadlineError' });
  });
});
