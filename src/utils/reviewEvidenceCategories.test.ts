import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildMatchFact } from '../../lib/matchReview/matchFacts.js';
import {
  buildDeterministicReviewCards,
  buildPrimaryMistakeCategoryPromptTable,
  describeReviewCardsInvalidReason,
  evidenceSupportsCategory,
  isReviewAiCardsComplete,
  parseAiReviewCards,
  resolveEvidence,
} from '../../lib/matchReview/reviewCards.js';
import { rawPrimaryMistakeFields, resolveReviewCardsWithRetry } from '../../lib/matchReview/reviewAiRetry.js';
import { getReviewSystemPrompt } from '../../lib/aiLanguage.js';
import type { ReviewCardsPayload } from '../types/reviewCards';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/match8985182860.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

const HERO_NAMES_CN = {
  54: { nameZh: '噬魂鬼', nameEn: 'Lifestealer' },
  86: { nameZh: '拉比克', nameEn: 'Rubick' },
  42: { nameZh: '冥界亚龙', nameEn: 'Viper' },
  2: { nameZh: '斧王', nameEn: 'Axe' },
  88: { nameZh: '娜迦海妖', nameEn: 'Naga Siren' },
  71: { nameZh: '裂魂人', nameEn: 'Spirit Breaker' },
  18: { nameZh: '斯温', nameEn: 'Sven' },
  9: { nameZh: '米拉娜', nameEn: 'Mirana' },
  123: { nameZh: '森海飞霞', nameEn: 'Hoodwink' },
  90: { nameZh: '光之守卫', nameEn: 'Keeper of the Light' },
};

const fact = buildMatchFact(fixture, { lang: 'zh', heroId: 54, heroNames: HERO_NAMES_CN });

// The fixture catalog exposes: kda, gpm, deaths, cs_at_10, lane_opponents,
// gold_lead_10/20/30/40 and timeline_0..timeline_11.
function buildCatalog(): Array<{ factKey: string }> {
  const det = buildDeterministicReviewCards(fact, 'zh') as ReviewCardsPayload & { _catalog?: Array<{ factKey: string }> };
  return det._catalog || [];
}

// Same grounded key moments + drill as the passing fixtures in
// reviewCards.test.ts / reviewAiRetry.test.ts, so only the primary_mistake
// category/evidence under test decides validation.
const GROUNDED_KEY_MOMENTS = [
  { timestamp: 48, phase: 'lane', headline: '一血', why: '下路交出一血。', evidence: [{ factKey: 'timeline_0' }] },
  { timestamp: 1310, phase: 'mid', headline: '推中二塔', why: '扩大优势。', evidence: [{ factKey: 'timeline_2' }] },
  { timestamp: 2817, phase: 'late', headline: '肉山', why: '夜魇控肉山。', evidence: [{ factKey: 'timeline_5' }] },
];
const DRILL = { duration: '15 分钟', title: '练节奏', steps: ['每局只选一个改进点'] };

function modelJson(category: string, evidence: Array<{ factKey: string }>): string {
  return JSON.stringify({
    primary_mistake: {
      category,
      headline: '中期节奏失控',
      explanation: '经济差持续扩大，关键节点决策失准。',
      evidence,
    },
    key_moments: GROUNDED_KEY_MOMENTS,
    drill: DRILL,
  });
}

function parseModelJson(category: string, evidence: Array<{ factKey: string }>): ReviewCardsPayload {
  return parseAiReviewCards(modelJson(category, evidence), fact, 'zh') as ReviewCardsPayload;
}

describe('primary_mistake evidence-backed categories (match 9035042364 regression)', () => {
  // Production log: reason=primary_mistake_not_grounded for a fight_timing
  // mistake evidenced only by economy checkpoints. The evidence rules must
  // keep rejecting that while accepting the same evidence under economy_swing.
  const GOLD_EVIDENCE = [{ factKey: 'gold_lead_20' }, { factKey: 'gold_lead_40' }];

  it('still rejects fight_timing evidenced only by gold_lead checkpoints', () => {
    const cards = parseModelJson('fight_timing', GOLD_EVIDENCE);
    expect(cards.primary_mistake).toBeUndefined();
    expect(isReviewAiCardsComplete(cards)).toBe(false);
    expect(describeReviewCardsInvalidReason(cards)).toBe('primary_mistake_not_grounded');
    expect(evidenceSupportsCategory('fight_timing', GOLD_EVIDENCE)).toBe(false);
  });

  it('accepts the same gold_lead evidence under economy_swing', () => {
    const cards = parseModelJson('economy_swing', GOLD_EVIDENCE);
    expect(cards.primary_mistake?.category).toBe('economy_swing');
    expect(cards.primary_mistake?.categoryLabel).toBe('经济走势');
    expect(cards.primary_mistake?.evidence?.map((e) => e.factKey)).toEqual(['gold_lead_20', 'gold_lead_40']);
    expect(isReviewAiCardsComplete(cards)).toBe(true);
    expect(describeReviewCardsInvalidReason(cards)).toBe('ok');
  });
});

describe('lane_outcome evidence rule', () => {
  it('accepts cs_at_10 / gold_lead_10 / lane_opponents as lane evidence', () => {
    for (const factKey of ['cs_at_10', 'gold_lead_10', 'lane_opponents']) {
      const cards = parseModelJson('lane_outcome', [{ factKey }]);
      expect(cards.primary_mistake?.category).toBe('lane_outcome');
      expect(cards.primary_mistake?.evidence?.[0].factKey).toBe(factKey);
      expect(isReviewAiCardsComplete(cards)).toBe(true);
      expect(describeReviewCardsInvalidReason(cards)).toBe('ok');
      expect(evidenceSupportsCategory('lane_outcome', [{ factKey }])).toBe(true);
    }
  });

  it('rejects gold_lead_20 alone — a mid-game checkpoint is not lane evidence', () => {
    const cards = parseModelJson('lane_outcome', [{ factKey: 'gold_lead_20' }]);
    expect(cards.primary_mistake).toBeUndefined();
    expect(isReviewAiCardsComplete(cards)).toBe(false);
    expect(describeReviewCardsInvalidReason(cards)).toBe('primary_mistake_not_grounded');
    expect(evidenceSupportsCategory('lane_outcome', [{ factKey: 'gold_lead_20' }])).toBe(false);
  });
});

describe('economy_swing evidence rule', () => {
  it('rejects a single gold_lead_* checkpoint', () => {
    expect(evidenceSupportsCategory('economy_swing', [{ factKey: 'gold_lead_20' }])).toBe(false);
    const cards = parseModelJson('economy_swing', [{ factKey: 'gold_lead_20' }]);
    expect(cards.primary_mistake).toBeUndefined();
    expect(isReviewAiCardsComplete(cards)).toBe(false);
    expect(describeReviewCardsInvalidReason(cards)).toBe('primary_mistake_not_grounded');
  });

  it('requires two distinct gold_lead_* checkpoints', () => {
    // The same checkpoint cited twice does not count as a trend.
    expect(evidenceSupportsCategory('economy_swing', [{ factKey: 'gold_lead_20' }, { factKey: 'gold_lead_20' }])).toBe(false);
    const cards = parseModelJson('economy_swing', [{ factKey: 'gold_lead_20' }, { factKey: 'gold_lead_40' }]);
    expect(cards.primary_mistake?.category).toBe('economy_swing');
    expect(isReviewAiCardsComplete(cards)).toBe(true);
    expect(describeReviewCardsInvalidReason(cards)).toBe('ok');
  });
});

describe('death_pattern evidence rule', () => {
  it('accepts deaths or kda plus a timeline/gold anchor', () => {
    const anchored = [
      [{ factKey: 'deaths' }, { factKey: 'timeline_3' }],
      [{ factKey: 'kda' }, { factKey: 'gold_lead_30' }],
    ];
    for (const evidence of anchored) {
      const cards = parseModelJson('death_pattern', evidence);
      expect(cards.primary_mistake?.category).toBe('death_pattern');
      expect(isReviewAiCardsComplete(cards)).toBe(true);
      expect(describeReviewCardsInvalidReason(cards)).toBe('ok');
    }
  });

  it('rejects deaths alone without a time/consequence anchor', () => {
    expect(evidenceSupportsCategory('death_pattern', [{ factKey: 'deaths' }])).toBe(false);
    expect(evidenceSupportsCategory('death_pattern', [{ factKey: 'kda' }])).toBe(false);
    const cards = parseModelJson('death_pattern', [{ factKey: 'deaths' }]);
    expect(cards.primary_mistake).toBeUndefined();
    expect(isReviewAiCardsComplete(cards)).toBe(false);
    expect(describeReviewCardsInvalidReason(cards)).toBe('primary_mistake_not_grounded');
  });
});

describe('grounding stays strict for category evidence', () => {
  it('drops factKeys not in the catalog before the category rules run', () => {
    const catalog = buildCatalog();
    expect(catalog.map((e) => e.factKey)).not.toContain('gold_lead_99');
    expect(resolveEvidence([{ factKey: 'gold_lead_99' }, { factKey: 'made_up' }], catalog as unknown as Parameters<typeof resolveEvidence>[1])).toEqual([]);

    // Only gold_lead_20 survives → a single checkpoint cannot support economy_swing.
    const cards = parseModelJson('economy_swing', [
      { factKey: 'gold_lead_20' },
      { factKey: 'gold_lead_99' },
      { factKey: 'made_up' },
    ]);
    expect(cards.primary_mistake).toBeUndefined();
    expect(isReviewAiCardsComplete(cards)).toBe(false);
    expect(describeReviewCardsInvalidReason(cards)).toBe('primary_mistake_not_grounded');
  });

  it('cannot satisfy fight_timing or lane_outcome with hallucinated keys', () => {
    const fightCards = parseModelJson('fight_timing', [{ factKey: 'timeline_99' }, { factKey: 'made_up' }]);
    expect(fightCards.primary_mistake).toBeUndefined();
    expect(describeReviewCardsInvalidReason(fightCards)).toBe('primary_mistake_not_grounded');

    const laneCards = parseModelJson('lane_outcome', [{ factKey: 'gold_lead_99' }, { factKey: 'made_up' }]);
    expect(laneCards.primary_mistake).toBeUndefined();
    expect(describeReviewCardsInvalidReason(laneCards)).toBe('primary_mistake_not_grounded');
  });
});

describe('farm_route and unknown categories stay rejected', () => {
  it('rejects farm_route regardless of farm-ish evidence', () => {
    expect(evidenceSupportsCategory('farm_route', [{ factKey: 'gpm' }, { factKey: 'cs_at_10' }])).toBe(false);
    const cards = parseModelJson('farm_route', [{ factKey: 'cs_at_10' }, { factKey: 'gpm' }]);
    expect(cards.primary_mistake).toBeUndefined();
    expect(isReviewAiCardsComplete(cards)).toBe(false);
    expect(describeReviewCardsInvalidReason(cards)).toBe('primary_mistake_not_grounded');
  });

  it('rejects categories outside the evidence-backed set', () => {
    for (const category of ['itemisation', 'vision', 'positioning', 'teamfight']) {
      const cards = parseModelJson(category, [{ factKey: 'kda' }, { factKey: 'timeline_0' }]);
      expect(cards.primary_mistake).toBeUndefined();
      expect(isReviewAiCardsComplete(cards)).toBe(false);
      expect(describeReviewCardsInvalidReason(cards)).toBe('primary_mistake_not_grounded');
      expect(evidenceSupportsCategory(category, [{ factKey: 'timeline_0' }])).toBe(false);
    }
  });
});

describe('buildPrimaryMistakeCategoryPromptTable', () => {
  const cat = (...factKeys: string[]) => factKeys.map((factKey) => ({ factKey }));

  it('lists only categories whose required keys exist in the catalog', () => {
    const full = buildPrimaryMistakeCategoryPromptTable(buildCatalog(), 'zh');
    // Fixture catalog has timeline_*, 4 gold_lead checkpoints, cs_at_10,
    // lane_opponents, deaths and kda → all four categories are available.
    expect(full.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(4);
    for (const category of ['fight_timing', 'lane_outcome', 'economy_swing', 'death_pattern']) {
      expect(full).toContain(category);
    }
    expect(full).not.toContain('farm_route');
  });

  it('localizes rows per lang', () => {
    const zh = buildPrimaryMistakeCategoryPromptTable(cat('timeline_0'), 'zh');
    expect(zh).toContain('- fight_timing（团战时机）: 至少 1 个 timeline_*');
    const en = buildPrimaryMistakeCategoryPromptTable(cat('timeline_0'), 'en');
    expect(en).toContain('- fight_timing（Fight timing）: at least 1 timeline_*');
  });

  it('hides categories whose required evidence is missing', () => {
    // gpm anchors nothing and a single gold_lead_* is not a trend.
    expect(buildPrimaryMistakeCategoryPromptTable(cat('gpm', 'gold_lead_20'), 'zh')).toBe('');
    // deaths/kda without a timeline/gold anchor cannot unlock death_pattern.
    expect(buildPrimaryMistakeCategoryPromptTable(cat('deaths'), 'zh')).toBe('');
    expect(buildPrimaryMistakeCategoryPromptTable(cat('kda'), 'zh')).toBe('');
    // Two checkpoints → only economy_swing.
    const onlyEconomy = buildPrimaryMistakeCategoryPromptTable(cat('gold_lead_20', 'gold_lead_30'), 'zh');
    expect(onlyEconomy).toContain('economy_swing');
    expect(onlyEconomy).not.toContain('fight_timing');
    expect(onlyEconomy).not.toContain('lane_outcome');
    expect(onlyEconomy).not.toContain('death_pattern');
    // A lane fact → only lane_outcome.
    const onlyLane = buildPrimaryMistakeCategoryPromptTable(cat('cs_at_10'), 'en');
    expect(onlyLane).toContain('lane_outcome');
    expect(onlyLane).not.toContain('fight_timing');
    expect(onlyLane).not.toContain('economy_swing');
    expect(onlyLane).not.toContain('death_pattern');
    // deaths + a timeline anchor unlocks death_pattern alongside fight_timing.
    const deathAnchored = buildPrimaryMistakeCategoryPromptTable(cat('deaths', 'timeline_0'), 'zh');
    expect(deathAnchored).toContain('death_pattern');
    expect(deathAnchored).toContain('fight_timing');
    expect(deathAnchored).not.toContain('lane_outcome');
  });

  it('returns empty string for empty or missing catalog', () => {
    expect(buildPrimaryMistakeCategoryPromptTable([], 'zh')).toBe('');
    expect(buildPrimaryMistakeCategoryPromptTable(undefined, 'en')).toBe('');
  });
});

describe('getReviewSystemPrompt category table', () => {
  const tableCatalog = [
    { factKey: 'timeline_0' },
    { factKey: 'gold_lead_10' },
    { factKey: 'gold_lead_20' },
    { factKey: 'deaths' },
  ];

  it('embeds the table when categoryTable is passed', () => {
    const zhTable = buildPrimaryMistakeCategoryPromptTable(tableCatalog, 'zh');
    const zh = getReviewSystemPrompt('zh', { categoryTable: zhTable });
    expect(zh).toContain('【类别→必需证据】');
    expect(zh).toContain(zhTable);

    const enTable = buildPrimaryMistakeCategoryPromptTable(tableCatalog, 'en');
    const en = getReviewSystemPrompt('en', { categoryTable: enTable });
    expect(en).toContain('Category → required evidence:');
    expect(en).toContain('- economy_swing（Economy swing）: at least 2 different gold_lead_*');
  });

  it('omits the section when no table is passed', () => {
    expect(getReviewSystemPrompt('zh', {})).not.toContain('【类别→必需证据】');
    expect(getReviewSystemPrompt('en', {})).not.toContain('Category → required evidence:');
  });
});

describe('resolveReviewCardsWithRetry validation metric', () => {
  const GOLD_EVIDENCE = [{ factKey: 'gold_lead_20' }, { factKey: 'gold_lead_40' }];
  const UNGROUNDED_FIGHT_TIMING = modelJson('fight_timing', GOLD_EVIDENCE);
  const ECONOMY_SWING = modelJson('economy_swing', GOLD_EVIDENCE);

  function createHarness(overrides: Record<string, unknown> = {}) {
    const warn = vi.fn();
    const metric = vi.fn();
    const requestCompletionText = vi.fn(async () => ECONOMY_SWING);
    const opts = {
      firstText: UNGROUNDED_FIGHT_TIMING,
      matchFact: fact,
      lang: 'zh',
      minKeyMoments: 3,
      matchId: 9035042364,
      requestCompletionText,
      warn,
      metric,
      ...overrides,
    };
    return { opts, warn, metric, requestCompletionText };
  }

  it('emits one review_ai_validation JSON line per attempt with raw primary_mistake fields', async () => {
    const h = createHarness();
    const result = await resolveReviewCardsWithRetry(h.opts);
    expect(result.usedFallback).toBe(false);
    expect(h.metric).toHaveBeenCalledTimes(2);

    const lines = h.metric.mock.calls.map((c) => c[0] as string);
    for (const line of lines) {
      expect(line).not.toContain('\n');
      expect(() => JSON.parse(line)).not.toThrow();
    }

    expect(JSON.parse(lines[0])).toMatchObject({
      severity: 'WARNING',
      event: 'review_ai_validation',
      matchId: 9035042364,
      lang: 'zh',
      attempt: 1,
      result: 'invalid',
      reason: 'primary_mistake_not_grounded',
      category: 'fight_timing',
      evidenceKeys: ['gold_lead_20', 'gold_lead_40'],
    });
    expect(JSON.parse(lines[1])).toMatchObject({
      severity: 'INFO',
      event: 'review_ai_validation',
      attempt: 2,
      result: 'valid',
      reason: 'ok',
      category: 'economy_swing',
      evidenceKeys: ['gold_lead_20', 'gold_lead_40'],
    });
  });

  it('records hallucinated evidenceKeys from the raw text even after normalization drops them', async () => {
    const hallucinated = modelJson('economy_swing', [
      { factKey: 'gold_lead_20' },
      { factKey: 'gold_lead_99' },
      { factKey: 'made_up' },
    ]);
    const h = createHarness({
      firstText: hallucinated,
      requestCompletionText: vi.fn(async () => hallucinated),
    });
    const result = await resolveReviewCardsWithRetry(h.opts);
    expect(result.usedFallback).toBe(true);
    expect(h.metric).toHaveBeenCalledTimes(2);
    expect(JSON.parse(h.metric.mock.calls[0][0] as string)).toMatchObject({
      attempt: 1,
      result: 'invalid',
      reason: 'primary_mistake_not_grounded',
      category: 'economy_swing',
      evidenceKeys: ['gold_lead_20', 'gold_lead_99', 'made_up'],
    });
    expect(JSON.parse(h.metric.mock.calls[1][0] as string)).toMatchObject({
      attempt: 2,
      result: 'invalid',
    });
  });

  it('rawPrimaryMistakeFields never throws on garbage', () => {
    const garbage: unknown[] = [
      '',
      null,
      undefined,
      42,
      { no: 'json' },
      'not json at all',
      '{',
      '}}{',
      '{"primary_mistake":',
      '前缀 {"primary_mistake": 坏 JSON} 后缀',
    ];
    for (const input of garbage) {
      expect(() => rawPrimaryMistakeFields(input as string)).not.toThrow();
    }
    expect(rawPrimaryMistakeFields('')).toEqual({ category: null, evidenceKeys: [] });
    expect(rawPrimaryMistakeFields('前缀 {"primary_mistake": 坏 JSON} 后缀')).toEqual({ category: null, evidenceKeys: [] });
    expect(rawPrimaryMistakeFields(JSON.stringify({ primary_mistake: { category: 42, evidence: 'nope' } }))).toEqual({
      category: null,
      evidenceKeys: [],
    });
    expect(rawPrimaryMistakeFields(JSON.stringify({ primary_mistake: { category: 'fight_timing', evidence: [null, 7, { factKey: 'kda' }] } }))).toEqual({
      category: 'fight_timing',
      evidenceKeys: ['kda'],
    });
    // Best-effort extraction still works on prose-wrapped model output.
    const wrapped = `好的，复盘 JSON 如下：${JSON.stringify({
      primary_mistake: { category: 'economy_swing', evidence: GOLD_EVIDENCE },
    })}`;
    expect(rawPrimaryMistakeFields(wrapped)).toEqual({
      category: 'economy_swing',
      evidenceKeys: ['gold_lead_20', 'gold_lead_40'],
    });
  });
});
