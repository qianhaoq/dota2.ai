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

describe('prompt JSON example is itself valid for this catalog', () => {
  it('uses one concrete satisfiable category with its required evidence', async () => {
    const { getReviewSystemPrompt } = await import('../../lib/aiLanguage.js');
    const rc = await import('../../lib/matchReview/reviewCards.js');
    const c = (...k: string[]) => k.map((factKey) => ({ factKey, label: factKey, value: '1' }));
    const econ = rc.buildPrimaryMistakeExample(c('gold_lead_20', 'gold_lead_30', 'kda'));
    expect(econ).toEqual({ category: 'economy_swing', evidenceKeys: ['gold_lead_20', 'gold_lead_30'] });
    expect(rc.evidenceSupportsCategory(econ!.category, econ!.evidenceKeys.map((factKey: string) => ({ factKey })))).toBe(true);
    const lane = rc.buildPrimaryMistakeExample(c('cs_at_10', 'lane_opponents'));
    expect(lane).toEqual({ category: 'lane_outcome', evidenceKeys: ['cs_at_10'] });
    expect(rc.buildPrimaryMistakeExample(c('timeline_0', 'gold_lead_10'))?.category).toBe('fight_timing');
    expect(rc.buildPrimaryMistakeExample([])).toBeNull();
    const en = getReviewSystemPrompt('en', { mistakeExample: econ });
    expect(en).toContain('"category": "economy_swing"');
    expect(en).toContain('{"factKey": "gold_lead_20"}, {"factKey": "gold_lead_30"}');
    expect(en).not.toContain(' | ');
    const zh = getReviewSystemPrompt('zh', { mistakeExample: lane });
    expect(zh).toContain('"category": "lane_outcome"');
    expect(getReviewSystemPrompt('zh', {})).toContain('"category": "fight_timing"');
  });

  it('prefers the later corrected copy when recovered objects tie', () => {
    const a = '{"primary_mistake":{"category":"fight_timing","headline":"old"},"key_moments":[]}';
    const b = '{"primary_mistake":{"category":"fight_timing","headline":"new"},"key_moments":[]}';
    expect(extractJsonFromLlmOutput(`${a}\nNote: corrected:\n${b}`)?.primary_mistake?.headline).toBe('new');
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

describe('saved 9035042364 outputs through the production parse + validate path', () => {
  it('recovered outputs validate, except the disallowed death_pattern one', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { buildMatchFact } = await import('../../lib/matchReview/matchFacts.js');
    const rc = await import('../../lib/matchReview/reviewCards.js');
    const match = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/match9035042364.parsed.json'), 'utf8'));
    for (const s of samples) {
      const heroId = /heroId=41/.test(s.source) ? 41 : undefined;
      const fact = buildMatchFact(match, { lang: 'zh', heroId });
      const { _catalog } = rc.buildDeterministicReviewCards(fact, 'zh');
      const cards = rc.parseAiReviewCards(s.text, fact, 'zh');
      const reason = rc.describeReviewCardsInvalidReason(cards, { minKeyMoments: rc.minRequiredKeyMoments(_catalog) });
      const category = rc.extractJsonFromLlmOutput(s.text)?.primary_mistake?.category;
      expect(reason).toBe(category === 'death_pattern' ? 'primary_mistake_not_grounded' : 'ok');
    }
  });
});

describe('full-width structural punctuation', () => {
  it('repairs `]，"key"` outside strings and keeps full-width text inside strings', () => {
    const text = '{"primary_mistake":{"headline":"甲，乙：丙"},"followups":["a"]，"mentor_note"："x"}';
    const j = extractJsonFromLlmOutput(text);
    expect(j?.primary_mistake?.headline).toBe('甲，乙：丙');
    expect(j?.mentor_note).toBe('x');
  });
});
