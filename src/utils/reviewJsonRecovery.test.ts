import { describe, it, expect } from 'vitest';
import { extractJsonFromLlmOutput } from '../../lib/matchReview/reviewCards.js';
import { resolveReviewCardsWithRetry } from '../../lib/matchReview/reviewAiRetry.js';
import samples from '../fixtures/malformedReviewJson9035042364.json';

// Real model outputs for match 9035042364 that the previous parser rejected
// (they surfaced as primary_mistake_not_grounded): stray closing brace after
// followups, mis-nested drill/followups, or a corrected copy after a note.
describe('extractJsonFromLlmOutput recovers malformed review JSON (9035042364)', () => {
  it.each(samples.map((s, i) => [i, s] as const))('sample %i parses into review fields', (_i, sample) => {
    const raw = extractJsonFromLlmOutput(sample.text);
    expect(raw).toBeTruthy();
    expect(Array.isArray(raw)).toBe(false);
    expect(raw.primary_mistake).toBeTruthy();
    expect(Array.isArray(raw.key_moments)).toBe(true);
    expect(raw.key_moments.length).toBeGreaterThanOrEqual(3);
  });

  it('still returns null for prose / arrays / empty output', () => {
    expect(extractJsonFromLlmOutput('')).toBeNull();
    expect(extractJsonFromLlmOutput('sorry, I cannot help')).toBeNull();
    expect(extractJsonFromLlmOutput('[1, 2, 3]')).toEqual([1, 2, 3]);
    expect(extractJsonFromLlmOutput('note: [1, 2, {oops')).toBeNull();
  });

  it('prefers the balanced object that carries review fields', () => {
    const text = '{"a":1} then {"primary_mistake":{"category":"fight_timing"},"key_moments":[]}} trailing';
    expect(extractJsonFromLlmOutput(text)).toEqual({ primary_mistake: { category: 'fight_timing' }, key_moments: [] });
  });

  it('handles braces and escaped quotes inside strings', () => {
    const text = 'x {"primary_mistake":{"headline":"a } b \\" {c"},"key_moments":[]}} junk';
    expect(extractJsonFromLlmOutput(text)?.primary_mistake?.headline).toBe('a } b " {c');
  });
});

describe('validation metric reason for unparseable output', () => {
  it('reports json_unparseable instead of primary_mistake_not_grounded', async () => {
    const lines: string[] = [];
    await resolveReviewCardsWithRetry({
      firstText: 'not json at all',
      matchFact: { summary: { matchId: 1, duration: 1800, radiantWin: true }, players: [], timeline: [], economy: { checkpoints: [] } },
      lang: 'en',
      minKeyMoments: 3,
      matchId: 1,
      requestCompletionText: async () => 'still not json',
      metric: (l: string) => lines.push(l),
    });
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.map((p) => p.reason)).toEqual(['json_unparseable', 'json_unparseable']);
    expect(parsed.every((p) => p.event === 'review_ai_validation' && p.result === 'invalid')).toBe(true);
  });
});
