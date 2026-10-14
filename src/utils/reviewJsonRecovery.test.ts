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

  it('returns null for prose / empty / unrecoverable output (plain arrays pass through unchanged)', () => {
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

  it('logs category/evidence for malformed-but-recovered outputs', async () => {
    const { rawPrimaryMistakeFields } = await import('../../lib/matchReview/reviewAiRetry.js');
    for (const s of samples) {
      const f = rawPrimaryMistakeFields(s.text);
      expect(typeof f.category).toBe('string');
      expect(f.evidenceKeys.length).toBeGreaterThan(0);
    }
  });
});

describe('prompt schema lists only satisfiable categories', () => {
  it('uses categoryNames in the JSON example and defaults to fight_timing', async () => {
    const { getReviewSystemPrompt } = await import('../../lib/aiLanguage.js');
    const only = getReviewSystemPrompt('en', { categoryTable: '- fight_timing: x', categoryNames: ['fight_timing'] });
    expect(only).toContain('"category": "fight_timing"');
    expect(only).not.toContain('economy_swing');
    const zh = getReviewSystemPrompt('zh', { categoryNames: ['fight_timing', 'economy_swing'] });
    expect(zh).toContain('"category": "fight_timing | economy_swing"');
    expect(getReviewSystemPrompt('zh', {})).toContain('"category": "fight_timing"');
  });
});

describe('AI gate follows category satisfiability', () => {
  it('calls the model for parsed matches without timeline when economy evidence exists', async () => {
    const { canReviewAiCardsValidate } = await import('../../lib/matchReview/reviewCards.js');
    const c = (...k: string[]) => k.map((factKey) => ({ factKey, label: factKey, value: '1' }));
    expect(canReviewAiCardsValidate(c('gold_lead_10', 'gold_lead_20'))).toBe(true);
    expect(canReviewAiCardsValidate(c('cs_at_10'))).toBe(true);
    expect(canReviewAiCardsValidate(c('kda', 'deaths', 'gpm', 'lane_opponents'))).toBe(false);
    expect(canReviewAiCardsValidate([])).toBe(false);
  });
});
