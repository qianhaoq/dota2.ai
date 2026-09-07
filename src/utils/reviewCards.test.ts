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
  resolveEvidence,
  localizeKillTarget,
  isReviewAiCardsComplete,
  isValidReviewDrill,
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

  it('buildDeterministicReviewCards emits match_summary with heroId and 3 phases', () => {
    const cards = buildDeterministicReviewCards(fact, 'zh');
    expect(cards.match_summary?.heroName).toBe('噬魂鬼');
    expect(cards.match_summary?.heroId).toBe(54);
    expect(cards.match_summary?.result).toBe('loss');
    expect(cards.phases).toHaveLength(3);
    expect(cards.phases?.map((p) => p.phase)).toEqual(['lane', 'mid', 'late']);
  });

  it('keeps pre-10:00 kills out of mid-phase evidence', () => {
    const cards = buildDeterministicReviewCards(fact, 'zh') as ReviewCardsPayload;
    const mid = cards.phases?.find((p) => p.phase === 'mid');
    expect(mid).toBeTruthy();
    const labels = mid?.evidence.map((e) => e.label) || [];
    expect(labels).not.toContain('6:24');
    expect(labels.some((l) => l === '13:19' || l === '16:46')).toBe(true);
  });

  it('localizes mid-phase kill targets in Chinese', () => {
    const cards = buildDeterministicReviewCards(fact, 'zh') as ReviewCardsPayload;
    const mid = cards.phases?.find((p) => p.phase === 'mid');
    const values = mid?.evidence.map((e) => e.value).join(' ') || '';
    expect(values).not.toContain('spirit_breaker');
    expect(values).toMatch(/裂魂人|斧王|斯温/);
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
    expect(cards.key_moments?.[0].timestamp).toBe(48);
    expect(cards.drill?.title).toBe('练节奏');
  });

  it('rejects key moment when timeline evidence is missing from catalog', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: '失误',
        explanation: '解释',
        evidence: [{ factKey: 'kda' }],
      },
      key_moments: [
        { timestamp: 9999, headline: '假', why: '无', evidence: [{ factKey: 'timeline_99' }] },
        { timestamp: 1310, headline: 'b', why: 'b', evidence: [] },
        { timestamp: 2817, headline: 'c', why: 'c', evidence: [] },
      ],
      drill: { duration: '15 分钟', title: '练', steps: ['一步'] },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.key_moments?.some((m) => m.headline === '假')).toBe(false);
  });
});

describe('resolveEvidence', () => {
  const catalog = [
    { factKey: 'kda', label: 'KDA', value: '7/9/19' },
  ];

  it('uses catalog label/value for recognized factKey even when model hallucinates', () => {
    const resolved = resolveEvidence(
      [{ factKey: 'kda', label: '假标签', value: '20/0/10' }],
      catalog,
    );
    expect(resolved).toEqual([{ factKey: 'kda', label: 'KDA', value: '7/9/19' }]);
  });
});

describe('economy orientation', () => {
  it('negates gold lead for Dire focus hero', () => {
    const fact = buildMatchFact(fixture, { lang: 'zh', heroId: 18, heroNames: HERO_NAMES_CN });
    const cards = buildDeterministicReviewCards(fact, 'zh') as ReviewCardsPayload;
    const gold10 = cards.phases?.flatMap((p) => p.evidence).find((e) => e.factKey === 'gold_lead_10');
    const rawLead = fact.economy.checkpoints.find((c) => c.minute === 10)?.radiantGoldLead;
    expect(rawLead).toBeDefined();
    expect(gold10?.label).toContain('我方');
    expect(gold10?.value).toBe(`${-(rawLead!)}`);
  });
});

describe('short match late phase', () => {
  it('does not claim late-game decided outcome when match ends before 25 min', () => {
    const shortFixture = { ...fixture, duration: 20 * 60 };
    const fact = buildMatchFact(shortFixture, { lang: 'zh', heroId: 54, heroNames: HERO_NAMES_CN });
    const cards = buildDeterministicReviewCards(fact, 'zh') as ReviewCardsPayload;
    const late = cards.phases?.find((p) => p.phase === 'late');
    expect(late?.insight).toContain('未进入典型后期');
    expect(late?.insight).not.toContain('后期决策决定胜负');
  });
});

describe('isReviewAiCardsComplete', () => {
  it('requires a nonempty drill', () => {
    expect(isReviewAiCardsComplete({
      primary_mistake: { category: 'fight_timing' },
      key_moments: [{}, {}, {}],
      drill: { title: '', steps: [] },
    })).toBe(false);
    expect(isValidReviewDrill({ title: '练', steps: ['一步'] })).toBe(true);
    expect(isReviewAiCardsComplete({
      primary_mistake: { category: 'fight_timing' },
      key_moments: [{}, {}, {}],
      drill: { title: '练', steps: ['一步'] },
    })).toBe(true);
  });
});

describe('localizeKillTarget', () => {
  const fact = buildMatchFact(fixture, { lang: 'zh', heroNames: HERO_NAMES_CN });

  it('maps spirit_breaker slug to 裂魂人 in zh', () => {
    expect(localizeKillTarget('spirit_breaker', fact, 'zh')).toBe('裂魂人');
  });
});

describe('formatTimestamp', () => {
  it('formats seconds as m:ss', () => {
    expect(formatTimestamp(48)).toBe('0:48');
    expect(formatTimestamp(1310)).toBe('21:50');
  });
});
