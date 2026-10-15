import { describe, it, expect } from 'vitest';
import { requestCardCompletion } from '../../lib/matchReview/cardCompletion.js';
import { resolveReviewCardsWithRetry } from '../../lib/matchReview/reviewAiRetry.js';

const ok = (text: string) => ({ choices: [{ message: { content: text } }] });
const hang = (signal: AbortSignal) => new Promise((_, rej) => signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
const base = { startedAt: Date.now(), budgetMs: 270000, perAttemptMs: 40, minAttemptMs: 5 };

describe('requestCardCompletion', () => {
  it('falls back to gemini when deepseek times out and skips deepseek afterwards', async () => {
    const failed = new Set<string>();
    const errors: string[] = [];
    let dsCalls = 0;
    const providers = [
      { name: 'deepseek', create: (s: AbortSignal) => { dsCalls++; return hang(s); } },
      { name: 'gemini', create: async () => ok('{"a":1}') },
    ];
    const r1 = await requestCardCompletion({ ...base, providers, failed, onProviderError: (i) => errors.push(`${i.provider}:${i.error}`) });
    expect(r1).toEqual({ text: '{"a":1}', provider: 'gemini' });
    expect(errors).toEqual(['deepseek:deadline']);
    const r2 = await requestCardCompletion({ ...base, providers, failed });
    expect(r2.provider).toBe('gemini');
    expect(dsCalls).toBe(1);
  });
  it('falls back on provider HTTP errors and throws when all fail', async () => {
    const err = Object.assign(new Error('boom'), { status: 503 });
    const errors: string[] = [];
    const providers = [
      { name: 'deepseek', create: async () => { throw err; } },
      { name: 'gemini', create: async () => { throw err; } },
    ];
    await expect(requestCardCompletion({ ...base, providers, failed: new Set(), onProviderError: (i) => errors.push(`${i.provider}:${i.error}`) })).rejects.toBe(err);
    expect(errors).toEqual(['deepseek:http_503', 'gemini:http_503']);
  });
  it('rethrows client disconnects without trying the next provider', async () => {
    const client = new AbortController();
    let geminiCalled = false;
    const providers = [
      { name: 'deepseek', create: (s: AbortSignal) => { setTimeout(() => client.abort(), 5); return hang(s); } },
      { name: 'gemini', create: async () => { geminiCalled = true; return ok('x'); } },
    ];
    await expect(requestCardCompletion({ ...base, perAttemptMs: 1000, providers, failed: new Set(), signal: client.signal })).rejects.toBeTruthy();
    expect(geminiCalled).toBe(false);
  });
  it('does not call providers once the request budget is exhausted', async () => {
    let called = false;
    const providers = [{ name: 'deepseek', create: async () => { called = true; return ok('x'); } }];
    await expect(requestCardCompletion({ ...base, startedAt: Date.now() - 269999, providers, failed: new Set() })).rejects.toMatchObject({ name: 'CompletionDeadlineError' });
    expect(called).toBe(false);
  });
});

describe('review_ai_validation provider field', () => {
  it('logs the provider for both attempts', async () => {
    const lines: string[] = [];
    await resolveReviewCardsWithRetry({
      firstText: 'not json', firstProvider: 'deepseek',
      matchFact: { summary: {}, players: [] } as never, lang: 'en', minKeyMoments: 1, matchId: 1,
      requestCompletionText: async () => ({ text: 'still not json', provider: 'gemini' }),
      metric: (l) => lines.push(l),
    });
    expect(lines.map((l) => JSON.parse(l).provider)).toEqual(['deepseek', 'gemini']);
    expect(JSON.parse(lines[0]).reason).toBe('json_unparseable');
  });
});
