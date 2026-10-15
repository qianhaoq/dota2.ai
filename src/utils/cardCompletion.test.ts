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

import { cardAttemptDeadlineMs } from '../../lib/completionDeadline.js';
import { REVIEW_CLIENT_TIMEOUT_MS } from '../services/geminiService';
import fs from 'node:fs';

describe('review timing budget', () => {
  it('worst-case chain (fetch + DS timeout + slow invalid Gemini + Gemini retry) ends before the client timeout', () => {
    const src = fs.readFileSync('server.js', 'utf8');
    const budget = Number(src.match(/REVIEW_REQUEST_BUDGET_MS = (\d+)/)![1]);
    const per = Number(src.match(/REVIEW_CARD_COMPLETION_DEADLINE_MS = (\d+)/)![1]);
    expect(per).toBe(40000);
    // 10s fetch, DS deadline 40s, invalid Gemini 39s, Gemini retry capped by budget
    let t = 10000 + per + 39000;
    t += cardAttemptDeadlineMs({ startedAt: 0, now: t, budgetMs: budget, perAttemptMs: per, minAttemptMs: 5000 });
    expect(t).toBeLessThanOrEqual(budget);
    // even a 120s OpenDota fetch keeps the server under its budget
    const slow = 120000 + cardAttemptDeadlineMs({ startedAt: 0, now: 120000, budgetMs: budget, perAttemptMs: per, minAttemptMs: 5000 });
    expect(slow).toBeLessThanOrEqual(budget);
    expect(budget + 5000).toBeLessThan(REVIEW_CLIENT_TIMEOUT_MS);
    expect(REVIEW_CLIENT_TIMEOUT_MS).toBeLessThan(300000);
  });
  it('does not mark or report a provider skipped for budget exhaustion', async () => {
    const failed = new Set<string>(); const errors: string[] = [];
    await expect(requestCardCompletion({ startedAt: Date.now() - 269999, budgetMs: 270000, perAttemptMs: 40, minAttemptMs: 5, providers: [{ name: 'gemini', create: async () => ({}) }], failed, onProviderError: (i) => errors.push(i.provider) })).rejects.toMatchObject({ name: 'CompletionDeadlineError' });
    expect(errors).toEqual([]); expect(failed.size).toBe(0);
  });
});
