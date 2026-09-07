import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildMatchFact } from '../../lib/matchReview/matchFacts.js';
import {
  buildDeterministicReviewCards,
  buildFallbackAiCards,
  parseAiReviewCards,
  formatTimestamp,
} from '../../lib/matchReview/reviewCards.js';
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

describe('reviewCards gold match 8985182860', () => {
  const fact = buildMatchFact(fixture, { lang: 'zh', heroId: 54, heroNames: HERO_NAMES_CN });

  it('keeps grounded lanes for Lifestealer bot lane', () => {
    expect(fact.grounded).toBe(true);
    expect(fact.focusLens?.laneGrounded).toBe(true);
    expect(fact.focusLens?.displayName).toBe('噬魂鬼');
    const botLane = fact.lanes.find((l) => l.laneLabel === 'bot');
    expect(botLane?.radiantHeroIds).toContain(54);
  });

  it('buildDeterministicReviewCards emits match_summary and 3 phases', () => {
    const cards = buildDeterministicReviewCards(fact, 'zh');
    expect(cards.match_summary?.heroName).toBe('噬魂鬼');
    expect(cards.match_summary?.result).toBe('loss');
    expect(cards.phases).toHaveLength(3);
    expect(cards.phases?.map((p) => p.phase)).toEqual(['lane', 'mid', 'late']);
  });

  it('buildFallbackAiCards includes mistake, drill, and >=3 key moments', () => {
    const cards = buildFallbackAiCards(fact, 'zh') as ReviewCardsPayload;
    expect(cards.primary_mistake?.category).toBeTruthy();
    expect(cards.primary_mistake?.headline).toBeTruthy();
    expect(cards.drill?.steps?.length).toBeGreaterThanOrEqual(2);
    expect(cards.key_moments?.length).toBeGreaterThanOrEqual(3);
    cards.key_moments?.forEach((m) => {
      expect(m.timestamp).toBeGreaterThanOrEqual(0);
      expect(m.timestampLabel).toMatch(/^\d+:\d{2}$/);
    });
  });

  it('parseAiReviewCards merges LLM JSON with deterministic spine', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: '中期开团过早',
        explanation: '在经济落后时强行开团。',
        evidence: [{ factKey: 'kda' }, { factKey: 'gold_lead_20' }],
      },
      key_moments: [
        { timestamp: 48, phase: 'lane', headline: '一血', why: '下路交出一血。', evidence: [{ factKey: 'timeline_0' }] },
        { timestamp: 1310, phase: 'mid', headline: '推中二塔', why: '扩大优势。', evidence: [] },
        { timestamp: 2817, phase: 'late', headline: '肉山', why: '夜魇控肉山。', evidence: [] },
      ],
      drill: { duration: '15 分钟', title: '练节奏', steps: ['10 分前不参团'] },
      followups: ['展开这场团'],
      mentor_note: '拉比克结语',
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.match_summary?.heroName).toBe('噬魂鬼');
    expect(cards.primary_mistake?.headline).toBe('中期开团过早');
    expect(cards.key_moments).toHaveLength(3);
    expect(cards.drill?.title).toBe('练节奏');
  });
});

describe('formatTimestamp', () => {
  it('formats seconds as m:ss', () => {
    expect(formatTimestamp(48)).toBe('0:48');
    expect(formatTimestamp(1310)).toBe('21:50');
  });
});
