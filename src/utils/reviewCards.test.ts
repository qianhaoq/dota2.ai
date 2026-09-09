import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildMatchFact } from '../../lib/matchReview/matchFacts.js';
import {
  buildDeterministicReviewCards,
  buildFallbackAiCards,
  buildKeyMomentsFromTimeline,
  parseAiReviewCards,
  formatTimestamp,
  resolveEvidence,
  localizeKillTarget,
  isReviewAiCardsComplete,
  isValidReviewDrill,
  hasDistinctKeyMoments,
  isGroundedDrillStep,
  areGroundedDrillSteps,
  isGroundedMentorNote,
  isGroundedDrillMetadata,
  defaultMentorNote,
  minRequiredKeyMoments,
  countTimelineFactsInCatalog,
  evidenceSupportsCategory,
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

  it('buildFallbackAiCards includes mistake, drill, and >=3 grounded key moments', () => {
    const cards = buildFallbackAiCards(fact, 'zh') as ReviewCardsPayload;
    expect(cards.primary_mistake?.category).toBeTruthy();
    expect(cards.primary_mistake?.headline).toBeTruthy();
    expect(cards.drill?.steps?.length).toBeGreaterThanOrEqual(2);
    expect(cards.key_moments?.length).toBeGreaterThanOrEqual(3);
    cards.key_moments?.forEach((m) => {
      expect(m.timestamp).toBeGreaterThanOrEqual(0);
      expect(m.timestampLabel).toMatch(/^\d+:\d{2}$/);
      expect(m.evidence.length).toBeGreaterThanOrEqual(1);
      expect(m.headline).toBe(m.evidence[0].value);
    });
    expect(cards.drill?.steps?.join(' ')).not.toMatch(/补刀|10 分前不主动参团|lane last hits/i);
  });

  it('omits follow-up chips on API-key fallback path', () => {
    const cards = buildFallbackAiCards(fact, 'zh', { includeFollowups: false }) as ReviewCardsPayload;
    expect(cards.followups).toEqual([]);
  });

  it('default followups embed first key moment timestamp and headline', () => {
    const cards = buildFallbackAiCards(fact, 'zh') as ReviewCardsPayload;
    const firstMoment = cards.key_moments?.[0];
    expect(firstMoment).toBeTruthy();
    expect(cards.followups?.[0]).toMatch(/^展开 \d+:\d{2} 节点：/);
    expect(cards.followups?.[0]).toContain(firstMoment!.headline);
    expect(cards.followups?.[0]).not.toBe('展开这场团');
    expect(cards.followups?.[1]).not.toMatch(/羊刀/);
    expect(cards.followups?.[1]).toMatch(/经济|GPM|节点：/);
  });

  it('fallback primary mistake stays neutral and does not infer positioning from deaths', () => {
    const cards = buildFallbackAiCards(fact, 'zh') as ReviewCardsPayload;
    expect(cards.primary_mistake?.category).toBe('fight_timing');
    expect(cards.primary_mistake?.headline).not.toMatch(/站位|进场时机/);
    expect(cards.primary_mistake?.headline).not.toMatch(/高死亡|偏高/);
    expect(cards.primary_mistake?.explanation).not.toMatch(/偏高|is high/i);
    expect(cards.primary_mistake?.explanation).toMatch(/死亡 \d+ 次/);
    expect(cards.primary_mistake?.explanation).toMatch(/不做未证实的因果推断/);
    expect(cards.primary_mistake?.evidence?.some((e) => e.factKey.startsWith('timeline_'))).toBe(true);
    const en = buildFallbackAiCards(fact, 'en') as ReviewCardsPayload;
    expect(en.primary_mistake?.headline).not.toMatch(/high deaths/i);
    expect(en.primary_mistake?.explanation).not.toMatch(/is high/i);
    expect(en.primary_mistake?.explanation).toMatch(/\d+ deaths/);
  });

  it('synthesizes contextual default followups when LLM omits followups array', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: '中期开团过早',
        explanation: '在经济落后时强行开团。',
        evidence: [{ factKey: 'timeline_0' }, { factKey: 'kda' }, { factKey: 'gold_lead_20' }],
      },
      key_moments: [
        { timestamp: 48, phase: 'lane', headline: '一血', why: '下路交出一血。', evidence: [{ factKey: 'timeline_0' }] },
        { timestamp: 1310, phase: 'mid', headline: '推中二塔', why: '扩大优势。', evidence: [{ factKey: 'timeline_2' }] },
        { timestamp: 2817, phase: 'late', headline: '肉山', why: '夜魇控肉山。', evidence: [{ factKey: 'timeline_5' }] },
      ],
      drill: { duration: '15 分钟', title: '练节奏', steps: ['每局只选一个改进点'] },
      mentor_note: '拉比克结语',
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    const first = cards.key_moments?.[0];
    expect(first).toBeTruthy();
    expect(cards.followups?.[0]).toBe(`展开 ${first!.timestampLabel} 节点：${first!.headline}`);
  });

  it('replaces item-specific model follow-ups with evidence-bound defaults', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: '中期开团过早',
        explanation: '在经济落后时强行开团。',
        evidence: [{ factKey: 'timeline_0' }, { factKey: 'kda' }, { factKey: 'gold_lead_20' }],
      },
      key_moments: [
        { timestamp: 48, phase: 'lane', headline: '一血', why: '下路交出一血。', evidence: [{ factKey: 'timeline_0' }] },
        { timestamp: 1310, phase: 'mid', headline: '推中二塔', why: '扩大优势。', evidence: [{ factKey: 'timeline_2' }] },
        { timestamp: 2817, phase: 'late', headline: '肉山', why: '夜魇控肉山。', evidence: [{ factKey: 'timeline_5' }] },
      ],
      drill: { duration: '15 分钟', title: '练节奏', steps: ['每局只选一个改进点'] },
      followups: ['展开 0:48 节点：一血', '为什么不该出羊刀', '下一局只练一件事'],
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    const second = cards.key_moments?.[1];
    expect(second).toBeTruthy();
    expect(cards.followups?.[1]).not.toMatch(/羊刀/);
    expect(cards.followups?.[1]).toBe(`展开 ${second!.timestampLabel} 节点：${second!.headline}`);
  });

  it('replaces unsupported item follow-up in any chip slot', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: '中期开团过早',
        explanation: '在经济落后时强行开团。',
        evidence: [{ factKey: 'timeline_0' }, { factKey: 'kda' }, { factKey: 'gold_lead_20' }],
      },
      key_moments: [
        { timestamp: 48, phase: 'lane', headline: '一血', why: '下路交出一血。', evidence: [{ factKey: 'timeline_0' }] },
        { timestamp: 1310, phase: 'mid', headline: '推中二塔', why: '扩大优势。', evidence: [{ factKey: 'timeline_2' }] },
        { timestamp: 2817, phase: 'late', headline: '肉山', why: '夜魇控肉山。', evidence: [{ factKey: 'timeline_5' }] },
      ],
      drill: { duration: '15 分钟', title: '练节奏', steps: ['每局只选一个改进点'] },
      followups: ['展开 0:48 节点：一血', '展开 34:13 节点：推中二塔', 'Why was Butterfly wrong?'],
    });
    const cards = parseAiReviewCards(llmJson, fact, 'en') as ReviewCardsPayload;
    expect(cards.followups?.[2]).toBe('One thing to practice next');
  });

  it('replaces item question appended to first follow-up chip', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: 'Mid fight too early',
        explanation: 'Forced a fight while behind.',
        evidence: [{ factKey: 'timeline_0' }, { factKey: 'kda' }, { factKey: 'gold_lead_20' }],
      },
      key_moments: [
        { timestamp: 48, phase: 'lane', headline: 'First Blood', why: 'Bot lane trade.', evidence: [{ factKey: 'timeline_0' }] },
        { timestamp: 1310, phase: 'mid', headline: 'Mid tier 2', why: 'Extended lead.', evidence: [{ factKey: 'timeline_2' }] },
        { timestamp: 2817, phase: 'late', headline: 'Roshan', why: 'Dire took Roshan.', evidence: [{ factKey: 'timeline_5' }] },
      ],
      drill: { duration: '15 min', title: 'Drill', steps: ['One step'] },
      followups: ['Break down 0:48: First Blood — why was Butterfly wrong?', 'What did gold lead mean?', 'One thing to practice next'],
    });
    const cards = parseAiReviewCards(llmJson, fact, 'en') as ReviewCardsPayload;
    const first = cards.key_moments?.[0];
    expect(first).toBeTruthy();
    expect(cards.followups?.[0]).toBe(`Break down ${first!.timestampLabel}: ${first!.headline}`);
    expect(cards.followups?.[0]).not.toMatch(/butterfly/i);
  });

  it('replaces first chip when it appends an unlisted item such as BKB', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: 'Mid fight too early',
        explanation: 'Forced a fight while behind.',
        evidence: [{ factKey: 'timeline_0' }, { factKey: 'kda' }, { factKey: 'gold_lead_20' }],
      },
      key_moments: [
        { timestamp: 48, phase: 'lane', headline: 'First Blood', why: 'Bot lane trade.', evidence: [{ factKey: 'timeline_0' }] },
        { timestamp: 1310, phase: 'mid', headline: 'Mid tier 2', why: 'Extended lead.', evidence: [{ factKey: 'timeline_2' }] },
        { timestamp: 2817, phase: 'late', headline: 'Roshan', why: 'Dire took Roshan.', evidence: [{ factKey: 'timeline_5' }] },
      ],
      drill: { duration: '15 min', title: 'Drill', steps: ['One step'] },
      followups: ['Break down 0:48: First Blood — why was BKB wrong?', 'What did gold lead mean?', 'One thing to practice next'],
    });
    const cards = parseAiReviewCards(llmJson, fact, 'en') as ReviewCardsPayload;
    const first = cards.key_moments?.[0];
    expect(first).toBeTruthy();
    expect(cards.followups?.[0]).toBe(`Break down ${first!.timestampLabel}: ${first!.headline}`);
    expect(cards.followups?.[0]).not.toMatch(/BKB/i);
  });

  it('parseAiReviewCards merges LLM JSON with deterministic spine', () => {
    const fallback = buildFallbackAiCards(fact, 'zh') as ReviewCardsPayload;
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: '中期开团过早',
        explanation: '在经济落后时强行开团。',
        evidence: [{ factKey: 'timeline_0' }, { factKey: 'kda' }, { factKey: 'gold_lead_20' }],
      },
      key_moments: [
        { timestamp: 48, phase: 'lane', headline: '一血', why: '下路交出一血。', evidence: [{ factKey: 'timeline_0' }] },
        { timestamp: 1310, phase: 'mid', headline: '推中二塔', why: '扩大优势。', evidence: [{ factKey: 'timeline_2' }] },
        { timestamp: 2817, phase: 'late', headline: '肉山', why: '夜魇控肉山。', evidence: [{ factKey: 'timeline_5' }] },
      ],
      drill: {
        duration: fallback.drill?.duration,
        title: fallback.drill?.title,
        steps: ['只练一件事：能不打就不打，信息不足时撤退'],
      },
      followups: ['展开这场团'],
      mentor_note: '拉比克结语',
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.match_summary?.heroName).toBe('噬魂鬼');
    expect(cards.primary_mistake?.headline).toBe('中期开团过早');
    expect(cards.key_moments).toHaveLength(3);
    expect(cards.key_moments?.[0].timestamp).toBe(48);
    expect(cards.key_moments?.every((m) => m.evidence.length >= 1)).toBe(true);
    expect(cards.drill?.title).toBe(fallback.drill?.title);
    const first = cards.key_moments?.[0];
    expect(first).toBeTruthy();
    expect(cards.followups?.[0]).toBe(`展开 ${first!.timestampLabel} 节点：${first!.headline}`);
  });

  it('binds key moment headline and why to catalog timeline fact, ignoring hallucinated model copy', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: '中期开团过早',
        explanation: '在经济落后时强行开团。',
        evidence: [{ factKey: 'timeline_0' }, { factKey: 'kda' }, { factKey: 'gold_lead_20' }],
      },
      key_moments: [
        {
          timestamp: 48,
          phase: 'lane',
          headline: '玩家在此阵亡并买了羊刀',
          why: '错误决策导致崩盘。',
          evidence: [{ factKey: 'timeline_0' }],
        },
        {
          timestamp: 1310,
          phase: 'mid',
          headline: '推中二塔',
          why: '扩大优势。',
          evidence: [{ factKey: 'timeline_2' }],
        },
        {
          timestamp: 2817,
          phase: 'late',
          headline: '肉山',
          why: '夜魇控肉山。',
          evidence: [{ factKey: 'timeline_5' }],
        },
      ],
      drill: { duration: '15 分钟', title: '练节奏', steps: ['每局只选一个改进点'] },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    const first = cards.key_moments?.[0];
    expect(first).toBeTruthy();
    expect(first!.headline).toBe(first!.evidence[0].value);
    expect(first!.headline).not.toMatch(/羊刀|阵亡/);
    expect(first!.why).toBe('该节点改变了地图压力或经济节奏。');
    expect(first!.timestampLabel).toBe(first!.evidence[0].label);
  });

  it('rejects key moments without catalog evidence', () => {
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
        { timestamp: 2817, headline: 'c', why: 'c', evidence: [{ factKey: 'fake_stat' }] },
      ],
      drill: { duration: '15 分钟', title: '练', steps: ['一步'] },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.key_moments?.length ?? 0).toBe(0);
    expect(isReviewAiCardsComplete(cards)).toBe(false);
  });

  it('rejects fight_timing primary mistake without timeline evidence', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: '开团过早',
        explanation: '在经济落后时强行开团。',
        evidence: [{ factKey: 'kda' }, { factKey: 'gold_lead_20' }],
      },
      key_moments: [
        { timestamp: 48, evidence: [{ factKey: 'timeline_0' }], headline: 'a', why: 'a' },
        { timestamp: 1310, evidence: [{ factKey: 'timeline_2' }], headline: 'b', why: 'b' },
        { timestamp: 2817, evidence: [{ factKey: 'timeline_5' }], headline: 'c', why: 'c' },
      ],
      drill: { duration: '15 分钟', title: '练', steps: ['一步'] },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.primary_mistake).toBeUndefined();
    expect(evidenceSupportsCategory('fight_timing', [{ factKey: 'kda' }])).toBe(false);
    expect(evidenceSupportsCategory('fight_timing', [{ factKey: 'timeline_0' }])).toBe(true);
  });

  it('rejects disallowed farm_route category until route evidence exists', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'farm_route',
        headline: '刷钱路线太贪',
        explanation: '应该更早参团而不是继续刷野。',
        evidence: [{ factKey: 'cs_at_10' }, { factKey: 'gpm' }],
      },
      key_moments: [
        { timestamp: 48, evidence: [{ factKey: 'timeline_0' }], headline: 'a', why: 'a' },
        { timestamp: 1310, evidence: [{ factKey: 'timeline_2' }], headline: 'b', why: 'b' },
        { timestamp: 2817, evidence: [{ factKey: 'timeline_5' }], headline: 'c', why: 'c' },
      ],
      drill: { duration: '15 分钟', title: '练', steps: ['一步'] },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.primary_mistake).toBeUndefined();
    expect(evidenceSupportsCategory('farm_route', [{ factKey: 'gpm' }])).toBe(false);
    expect(isReviewAiCardsComplete(cards)).toBe(false);
  });

  it('rejects disallowed itemisation category instead of remapping', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'itemisation',
        headline: '出装问题',
        explanation: '解释',
        evidence: [{ factKey: 'kda' }],
      },
      key_moments: [
        { timestamp: 48, evidence: [{ factKey: 'timeline_0' }], headline: 'a', why: 'a' },
        { timestamp: 1310, evidence: [{ factKey: 'timeline_2' }], headline: 'b', why: 'b' },
        { timestamp: 2817, evidence: [{ factKey: 'timeline_5' }], headline: 'c', why: 'c' },
      ],
      drill: { duration: '15 分钟', title: '练', steps: ['一步'] },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.primary_mistake).toBeUndefined();
    expect(isReviewAiCardsComplete(cards)).toBe(false);
  });

  it('rejects primary mistake with non-string headline or explanation', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: { text: 'bad' },
        explanation: {},
        evidence: [{ factKey: 'kda' }],
      },
      key_moments: [
        { timestamp: 48, evidence: [{ factKey: 'timeline_0' }], headline: 'a', why: 'a' },
        { timestamp: 1310, evidence: [{ factKey: 'timeline_2' }], headline: 'b', why: 'b' },
        { timestamp: 2817, evidence: [{ factKey: 'timeline_5' }], headline: 'c', why: 'c' },
      ],
      drill: { duration: '15 分钟', title: '练', steps: ['一步'] },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.primary_mistake).toBeUndefined();
    expect(isReviewAiCardsComplete(cards)).toBe(false);
  });

  it('rejects drill with non-string title', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: '失误',
        explanation: '解释',
        evidence: [{ factKey: 'kda' }],
      },
      key_moments: [
        { timestamp: 48, evidence: [{ factKey: 'timeline_0' }], headline: 'a', why: 'a' },
        { timestamp: 1310, evidence: [{ factKey: 'timeline_2' }], headline: 'b', why: 'b' },
        { timestamp: 2817, evidence: [{ factKey: 'timeline_5' }], headline: 'c', why: 'c' },
      ],
      drill: { duration: '15 分钟', title: {}, steps: ['一步'] },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.drill).toBeUndefined();
    expect(isReviewAiCardsComplete(cards)).toBe(false);
  });

  it('rejects primary mistake without catalog evidence', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: '失误',
        explanation: '解释',
        evidence: [{ factKey: 'fake_stat' }],
      },
      key_moments: [
        { timestamp: 48, evidence: [{ factKey: 'timeline_0' }], headline: 'a', why: 'a' },
        { timestamp: 1310, evidence: [{ factKey: 'timeline_2' }], headline: 'b', why: 'b' },
        { timestamp: 2817, evidence: [{ factKey: 'timeline_5' }], headline: 'c', why: 'c' },
      ],
      drill: { duration: '15 分钟', title: '练', steps: ['一步'] },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.primary_mistake).toBeUndefined();
    expect(isReviewAiCardsComplete(cards)).toBe(false);
  });

  it('rejects key moments citing only non-timeline catalog facts', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: '失误',
        explanation: '解释',
        evidence: [{ factKey: 'kda' }],
      },
      key_moments: [
        { timestamp: 500, headline: '假', why: '无', evidence: [{ factKey: 'kda' }] },
        { timestamp: 1310, headline: 'b', why: 'b', evidence: [{ factKey: 'gold_lead_20' }] },
        { timestamp: 2817, headline: 'c', why: 'c', evidence: [{ factKey: 'deaths' }] },
      ],
      drill: { duration: '15 分钟', title: '练', steps: ['一步'] },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.key_moments?.length ?? 0).toBe(0);
    expect(isReviewAiCardsComplete(cards)).toBe(false);
  });

  it('fills key moment copy from catalog when model sends empty headline or why', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: '失误',
        explanation: '解释',
        evidence: [{ factKey: 'kda' }],
      },
      key_moments: [
        { timestamp: 48, evidence: [{ factKey: 'timeline_0' }], headline: '', why: '有说明' },
        { timestamp: 1310, evidence: [{ factKey: 'timeline_2' }], headline: '有标题', why: '' },
        { timestamp: 2817, evidence: [{ factKey: 'timeline_5' }], headline: 'c', why: 'c' },
      ],
      drill: { duration: '15 分钟', title: '练', steps: ['一步'] },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.key_moments).toHaveLength(3);
    cards.key_moments?.forEach((m) => {
      expect(m.headline).toBe(m.evidence[0].value);
      expect(m.why).toBe('该节点改变了地图压力或经济节奏。');
    });
  });

  it('rejects duplicate timeline key moments', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: '失误',
        explanation: '解释',
        evidence: [{ factKey: 'kda' }],
      },
      key_moments: [
        { timestamp: 48, evidence: [{ factKey: 'timeline_0' }], headline: 'a', why: 'a' },
        { timestamp: 48, evidence: [{ factKey: 'timeline_0' }], headline: 'a2', why: 'a2' },
        { timestamp: 48, evidence: [{ factKey: 'timeline_0' }], headline: 'a3', why: 'a3' },
      ],
      drill: { duration: '15 分钟', title: '练', steps: ['一步'] },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.key_moments).toHaveLength(1);
    expect(hasDistinctKeyMoments(cards.key_moments ?? [], 3)).toBe(false);
    expect(isReviewAiCardsComplete(cards)).toBe(false);
  });

  it('rejects moments that share one evidence list but bind to the same timeline key', () => {
    const sharedEvidence = [{ factKey: 'timeline_0' }, { factKey: 'timeline_1' }, { factKey: 'timeline_2' }];
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: '失误',
        explanation: '解释',
        evidence: [{ factKey: 'kda' }],
      },
      key_moments: [
        { evidence: sharedEvidence, headline: 'a', why: 'a' },
        { evidence: sharedEvidence, headline: 'b', why: 'b' },
        { evidence: sharedEvidence, headline: 'c', why: 'c' },
      ],
      drill: { duration: '15 分钟', title: '练', steps: ['一步'] },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.key_moments?.every((m) => m.evidence[0].factKey === 'timeline_0')).toBe(true);
    expect(hasDistinctKeyMoments(cards.key_moments ?? [], 3)).toBe(false);
    expect(isReviewAiCardsComplete(cards)).toBe(false);
  });

  it('rejects disallowed vision category', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'vision',
        headline: '视野不足',
        explanation: '没做眼',
        evidence: [{ factKey: 'kda' }],
      },
      key_moments: [
        { timestamp: 48, evidence: [{ factKey: 'timeline_0' }], headline: 'a', why: 'a' },
        { timestamp: 1310, evidence: [{ factKey: 'timeline_2' }], headline: 'b', why: 'b' },
        { timestamp: 2817, evidence: [{ factKey: 'timeline_5' }], headline: 'c', why: 'c' },
      ],
      drill: { duration: '15 分钟', title: '练', steps: ['一步'] },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.primary_mistake).toBeUndefined();
    expect(isReviewAiCardsComplete(cards)).toBe(false);
  });

  it('rejects disallowed positioning category', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'positioning',
        headline: '站位太差',
        explanation: '团战站位失误。',
        evidence: [{ factKey: 'deaths' }],
      },
      key_moments: [
        { evidence: [{ factKey: 'timeline_0' }], headline: 'a', why: 'a' },
        { evidence: [{ factKey: 'timeline_2' }], headline: 'b', why: 'b' },
        { evidence: [{ factKey: 'timeline_5' }], headline: 'c', why: 'c' },
      ],
      drill: { duration: '15 分钟', title: '练', steps: ['一步'] },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.primary_mistake).toBeUndefined();
    expect(isReviewAiCardsComplete(cards)).toBe(false);
  });

  it('rejects malformed drill steps instead of coercing null to a string', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: '失误',
        explanation: '解释',
        evidence: [{ factKey: 'kda' }],
      },
      key_moments: [
        { evidence: [{ factKey: 'timeline_0' }], headline: 'a', why: 'a' },
        { evidence: [{ factKey: 'timeline_2' }], headline: 'b', why: 'b' },
        { evidence: [{ factKey: 'timeline_5' }], headline: 'c', why: 'c' },
      ],
      drill: { duration: '15 分钟', title: '练', steps: [null, {}] },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.drill).toBeUndefined();
    expect(isReviewAiCardsComplete(cards)).toBe(false);
  });

  it('ignores malformed numeric factKey in moment evidence without throwing', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: '失误',
        explanation: '解释',
        evidence: [{ factKey: 'kda' }],
      },
      key_moments: [
        { evidence: [{ factKey: 7 }, { factKey: 'timeline_0' }], headline: 'a', why: 'a' },
        { evidence: [{ factKey: 'timeline_2' }], headline: 'b', why: 'b' },
        { evidence: [{ factKey: 'timeline_5' }], headline: 'c', why: 'c' },
      ],
      drill: { duration: '15 分钟', title: '练', steps: ['一步'] },
    });
    expect(() => parseAiReviewCards(llmJson, fact, 'zh')).not.toThrow();
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.key_moments).toHaveLength(3);
    expect(cards.key_moments?.[0].evidence[0].factKey).toBe('timeline_0');
  });

  it('rejects primary mistake with empty explanation', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: '',
        explanation: '',
        evidence: [{ factKey: 'kda' }],
      },
      key_moments: [
        { timestamp: 48, evidence: [{ factKey: 'timeline_0' }], headline: 'a', why: 'a' },
        { timestamp: 1310, evidence: [{ factKey: 'timeline_2' }], headline: 'b', why: 'b' },
        { timestamp: 2817, evidence: [{ factKey: 'timeline_5' }], headline: 'c', why: 'c' },
      ],
      drill: { duration: '15 分钟', title: '练', steps: ['一步'] },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.primary_mistake).toBeUndefined();
    expect(isReviewAiCardsComplete(cards)).toBe(false);
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

  it('discards unknown factKey even when model supplies label and value', () => {
    const resolved = resolveEvidence(
      [{ factKey: 'radiance_timing', label: '辉耀', value: '12:00' }],
      catalog,
    );
    expect(resolved).toEqual([]);
  });
});

describe('buildKeyMomentsFromTimeline', () => {
  const fact = buildMatchFact(fixture, { lang: 'zh', heroId: 54, heroNames: HERO_NAMES_CN });

  it('pairs each moment headline with evidence from the same catalog timeline entry', () => {
    const { _catalog, ...cards } = buildDeterministicReviewCards(fact, 'zh') as ReviewCardsPayload & { _catalog?: unknown[] };
    const catalog = (_catalog || []) as Array<{ factKey: string; label: string; value: string; timestamp?: number }>;
    const moments = buildKeyMomentsFromTimeline(catalog, 'zh', 4);
    expect(moments.length).toBeGreaterThanOrEqual(3);
    moments.forEach((m) => {
      expect(m.evidence).toHaveLength(1);
      expect(m.headline).toBe(m.evidence[0].value);
      expect(m.timestampLabel).toBe(m.evidence[0].label);
      const catalogEntry = catalog.find((e) => e.factKey === m.evidence[0].factKey);
      expect(catalogEntry?.value).toBe(m.headline);
    });
  });

  it('uses catalog timeline factKeys so fallback moments match evidence catalog', () => {
    const cards = buildFallbackAiCards(fact, 'zh') as ReviewCardsPayload;
    const det = buildDeterministicReviewCards(fact, 'zh') as ReviewCardsPayload & { _catalog?: Array<{ factKey: string; value: string }> };
    const timelineKeys = (det._catalog || [])
      .filter((e) => e.factKey.startsWith('timeline_'))
      .slice(0, 4)
      .map((e) => e.factKey);
    cards.key_moments?.forEach((m, i) => {
      expect(m.evidence[0].factKey).toBe(timelineKeys[i]);
    });
  });

  it('omits fallback primary_mistake when catalog has no timeline events', () => {
    const factNoTimeline = buildMatchFact({ ...fixture, objectives: [] }, { lang: 'zh', heroId: 54, heroNames: HERO_NAMES_CN });
    const cards = buildFallbackAiCards(factNoTimeline, 'zh') as ReviewCardsPayload;
    expect(cards.primary_mistake).toBeUndefined();
    expect(cards.key_moments?.length ?? 0).toBe(0);
    expect(cards.followups?.[0]).not.toMatch(/关键团战|展开这场团|key fight/i);
    expect(cards.followups?.[0]).toMatch(/经济|GPM|KDA/);
  });

  it('replaces ungrounded model drill steps with deterministic fallback drill', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: '中期开团过早',
        explanation: '在经济落后时强行开团。',
        evidence: [{ factKey: 'timeline_0' }, { factKey: 'kda' }, { factKey: 'gold_lead_20' }],
      },
      key_moments: [
        { timestamp: 48, phase: 'lane', headline: '一血', why: '下路交出一血。', evidence: [{ factKey: 'timeline_0' }] },
        { timestamp: 1310, phase: 'mid', headline: '推中二塔', why: '扩大优势。', evidence: [{ factKey: 'timeline_2' }] },
        { timestamp: 2817, phase: 'late', headline: '肉山', why: '夜魇控肉山。', evidence: [{ factKey: 'timeline_5' }] },
      ],
      drill: { duration: '15 分钟', title: '练节奏', steps: ['10 分前不参团', '出羊刀再开团'] },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    const fallback = buildFallbackAiCards(fact, 'zh') as ReviewCardsPayload;
    expect(cards.drill?.title).toBe(fallback.drill?.title);
    expect(cards.drill?.steps).toEqual(fallback.drill?.steps);
    expect(cards.drill?.steps?.join(' ')).not.toMatch(/羊刀|10 分前不参团|出羊刀/);
  });

  it('rejects item-specific drill steps in English', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: 'Mid fight too early',
        explanation: 'Forced a fight while behind.',
        evidence: [{ factKey: 'timeline_0' }, { factKey: 'kda' }, { factKey: 'gold_lead_20' }],
      },
      key_moments: [
        { timestamp: 48, phase: 'lane', headline: 'First Blood', why: 'Bot lane trade.', evidence: [{ factKey: 'timeline_0' }] },
        { timestamp: 1310, phase: 'mid', headline: 'Mid tier 2', why: 'Extended lead.', evidence: [{ factKey: 'timeline_2' }] },
        { timestamp: 2817, phase: 'late', headline: 'Roshan', why: 'Dire took Roshan.', evidence: [{ factKey: 'timeline_5' }] },
      ],
      drill: { duration: '15 min', title: 'Item drill', steps: ['Buy Sheepstick before fights', 'Farm lane last hits'] },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'en') as ReviewCardsPayload;
    expect(cards.drill?.title).not.toBe('Item drill');
    expect(cards.drill?.steps?.join(' ')).not.toMatch(/sheepstick|last hit/i);
  });

  it('keeps model drill steps only when they match safe fallback templates', () => {
    const fallback = buildFallbackAiCards(fact, 'zh') as ReviewCardsPayload;
    const safeStep = fallback.drill?.steps?.[0];
    expect(safeStep).toBeTruthy();
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: '中期开团过早',
        explanation: '在经济落后时强行开团。',
        evidence: [{ factKey: 'timeline_0' }, { factKey: 'kda' }, { factKey: 'gold_lead_20' }],
      },
      key_moments: [
        { timestamp: 48, phase: 'lane', headline: '一血', why: '下路交出一血。', evidence: [{ factKey: 'timeline_0' }] },
        { timestamp: 1310, phase: 'mid', headline: '推中二塔', why: '扩大优势。', evidence: [{ factKey: 'timeline_2' }] },
        { timestamp: 2817, phase: 'late', headline: '肉山', why: '夜魇控肉山。', evidence: [{ factKey: 'timeline_5' }] },
      ],
      drill: {
        duration: fallback.drill?.duration,
        title: fallback.drill?.title,
        steps: [safeStep!],
      },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.drill?.title).toBe(fallback.drill?.title);
    expect(cards.drill?.steps).toEqual([safeStep]);
  });

  it('rejects drill steps that only match broad coaching keywords', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: 'Mid fight too early',
        explanation: 'Forced a fight while behind.',
        evidence: [{ factKey: 'timeline_0' }, { factKey: 'kda' }, { factKey: 'gold_lead_20' }],
      },
      key_moments: [
        { timestamp: 48, phase: 'lane', headline: 'First Blood', why: 'Bot lane trade.', evidence: [{ factKey: 'timeline_0' }] },
        { timestamp: 1310, phase: 'mid', headline: 'Mid tier 2', why: 'Extended lead.', evidence: [{ factKey: 'timeline_2' }] },
        { timestamp: 2817, phase: 'late', headline: 'Roshan', why: 'Dire took Roshan.', evidence: [{ factKey: 'timeline_5' }] },
      ],
      drill: {
        duration: '15 min',
        title: 'Vision drill',
        steps: ['Rush Moon Shard every game to improve vision'],
      },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'en') as ReviewCardsPayload;
    expect(cards.drill?.title).not.toBe('Vision drill');
    expect(cards.drill?.steps?.join(' ')).not.toMatch(/moon shard|rush every game/i);
  });

  it('rejects unrecognized ability/item drill prescriptions via positive grounding', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: 'Mid fight too early',
        explanation: 'Forced a fight while behind.',
        evidence: [{ factKey: 'timeline_0' }, { factKey: 'kda' }, { factKey: 'gold_lead_20' }],
      },
      key_moments: [
        { timestamp: 48, phase: 'lane', headline: 'First Blood', why: 'Bot lane trade.', evidence: [{ factKey: 'timeline_0' }] },
        { timestamp: 1310, phase: 'mid', headline: 'Mid tier 2', why: 'Extended lead.', evidence: [{ factKey: 'timeline_2' }] },
        { timestamp: 2817, phase: 'late', headline: 'Roshan', why: 'Dire took Roshan.', evidence: [{ factKey: 'timeline_5' }] },
      ],
      drill: {
        duration: '15 min',
        title: 'Ability drill',
        steps: ['Cast Chronosphere as soon as it is ready', 'Purchase Divine Rapier next fight'],
      },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'en') as ReviewCardsPayload;
    const fallback = buildFallbackAiCards(fact, 'en') as ReviewCardsPayload;
    expect(cards.drill?.title).toBe(fallback.drill?.title);
    expect(cards.drill?.steps?.join(' ')).not.toMatch(/chronosphere|rapier/i);
  });

  it('omits economy follow-ups when catalog has no economy facts', () => {
    const bareFixture = { ...fixture, objectives: [], radiant_gold_adv: [], players: [] };
    const factBare = buildMatchFact(bareFixture, { lang: 'zh' });
    const cards = buildFallbackAiCards(factBare, 'zh') as ReviewCardsPayload;
    expect(cards.followups?.length).toBe(1);
    expect(cards.followups?.[0]).toBe('下一局只练一件事');
    expect(cards.followups?.join(' ')).not.toMatch(/经济|GPM|gold|checkpoint/i);
  });

  it('rejects wrong-language mentor notes and uses localized default', () => {
    const basePayload = {
      primary_mistake: {
        category: 'fight_timing',
        headline: '中期开团过早',
        explanation: '在经济落后时强行开团。',
        evidence: [{ factKey: 'timeline_0' }, { factKey: 'kda' }, { factKey: 'gold_lead_20' }],
      },
      key_moments: [
        { timestamp: 48, phase: 'lane', headline: '一血', why: '下路交出一血。', evidence: [{ factKey: 'timeline_0' }] },
        { timestamp: 1310, phase: 'mid', headline: '推中二塔', why: '扩大优势。', evidence: [{ factKey: 'timeline_2' }] },
        { timestamp: 2817, phase: 'late', headline: '肉山', why: '夜魇控肉山。', evidence: [{ factKey: 'timeline_5' }] },
      ],
      drill: { duration: '15 分钟', title: '练节奏', steps: ['只练一件事：能不打就不打，信息不足时撤退'] },
    };
    const zhCards = parseAiReviewCards(JSON.stringify({ ...basePayload, mentor_note: 'Rubick sign-off' }), fact, 'zh') as ReviewCardsPayload;
    expect(zhCards.mentor_note).toBe(defaultMentorNote('zh'));
    expect(isGroundedMentorNote('Rubick sign-off', 'zh')).toBe(false);
    expect(isGroundedMentorNote('拉比克结语', 'zh')).toBe(true);

    const enFact = buildMatchFact(fixture, { lang: 'en', heroId: 54, heroNames: HERO_NAMES_CN });
    const enPayload = {
      primary_mistake: {
        category: 'fight_timing',
        headline: 'Mid fight too early',
        explanation: 'Forced a fight while behind.',
        evidence: [{ factKey: 'timeline_0' }, { factKey: 'kda' }, { factKey: 'gold_lead_20' }],
      },
      key_moments: [
        { timestamp: 48, phase: 'lane', headline: 'First Blood', why: 'Bot lane trade.', evidence: [{ factKey: 'timeline_0' }] },
        { timestamp: 1310, phase: 'mid', headline: 'Mid tier 2', why: 'Extended lead.', evidence: [{ factKey: 'timeline_2' }] },
        { timestamp: 2817, phase: 'late', headline: 'Roshan', why: 'Dire took Roshan.', evidence: [{ factKey: 'timeline_5' }] },
      ],
      drill: { duration: '15 min', title: 'Drill', steps: ['One focus: disengage when information is incomplete'] },
      mentor_note: '拉比克结语',
    };
    const enCards = parseAiReviewCards(JSON.stringify(enPayload), enFact, 'en') as ReviewCardsPayload;
    expect(enCards.mentor_note).toBe(defaultMentorNote('en'));
    expect(isGroundedMentorNote('拉比克结语', 'en')).toBe(false);
    expect(isGroundedMentorNote('Rubick sign-off', 'en')).toBe(true);
  });

  it('replaces ungrounded drill title and duration while keeping safe steps', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: 'Mid fight too early',
        explanation: 'Forced a fight while behind.',
        evidence: [{ factKey: 'timeline_0' }, { factKey: 'kda' }, { factKey: 'gold_lead_20' }],
      },
      key_moments: [
        { timestamp: 48, phase: 'lane', headline: 'First Blood', why: 'Bot lane trade.', evidence: [{ factKey: 'timeline_0' }] },
        { timestamp: 1310, phase: 'mid', headline: 'Mid tier 2', why: 'Extended lead.', evidence: [{ factKey: 'timeline_2' }] },
        { timestamp: 2817, phase: 'late', headline: 'Roshan', why: 'Dire took Roshan.', evidence: [{ factKey: 'timeline_5' }] },
      ],
      drill: {
        duration: 'Rush Divine Rapier every game',
        title: 'Rush Divine Rapier every game',
        steps: ['One focus: disengage when information is incomplete'],
      },
    });
    const enFact = buildMatchFact(fixture, { lang: 'en', heroId: 54, heroNames: HERO_NAMES_CN });
    const cards = parseAiReviewCards(llmJson, enFact, 'en') as ReviewCardsPayload;
    const fallback = buildFallbackAiCards(enFact, 'en') as ReviewCardsPayload;
    expect(isGroundedDrillMetadata('Rush Divine Rapier every game', 'en', 'title')).toBe(false);
    expect(isGroundedDrillMetadata('40% magic-resistance drill', 'en', 'title')).toBe(false);
    expect(isGroundedDrillMetadata('until 10 wins', 'en', 'duration')).toBe(false);
    expect(cards.drill?.title).toBe(fallback.drill?.title);
    expect(cards.drill?.duration).toBe(fallback.drill?.duration);
    expect(cards.drill?.steps).toEqual(['One focus: disengage when information is incomplete']);
    expect(cards.drill?.title).not.toMatch(/rapier/i);
  });

  it('replaces invented balance claims and open-ended drill durations', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: 'Mid fight too early',
        explanation: 'Forced a fight while behind.',
        evidence: [{ factKey: 'timeline_0' }, { factKey: 'kda' }, { factKey: 'gold_lead_20' }],
      },
      key_moments: [
        { timestamp: 48, phase: 'lane', headline: 'First Blood', why: 'Bot lane trade.', evidence: [{ factKey: 'timeline_0' }] },
        { timestamp: 1310, phase: 'mid', headline: 'Mid tier 2', why: 'Extended lead.', evidence: [{ factKey: 'timeline_2' }] },
        { timestamp: 2817, phase: 'late', headline: 'Roshan', why: 'Dire took Roshan.', evidence: [{ factKey: 'timeline_5' }] },
      ],
      drill: {
        duration: 'until 10 wins',
        title: '40% magic-resistance drill',
        steps: ['One focus: disengage when information is incomplete'],
      },
    });
    const enFact = buildMatchFact(fixture, { lang: 'en', heroId: 54, heroNames: HERO_NAMES_CN });
    const cards = parseAiReviewCards(llmJson, enFact, 'en') as ReviewCardsPayload;
    const fallback = buildFallbackAiCards(enFact, 'en') as ReviewCardsPayload;
    expect(cards.drill?.title).toBe(fallback.drill?.title);
    expect(cards.drill?.duration).toBe(fallback.drill?.duration);
    expect(cards.drill?.steps).toEqual(['One focus: disengage when information is incomplete']);
    expect(cards.drill?.title).not.toMatch(/magic-resistance|40%/i);
    expect(cards.drill?.duration).not.toMatch(/until 10 wins/i);
  });

  it('accepts allowlisted fallback drill title and duration', () => {
    const enFact = buildMatchFact(fixture, { lang: 'en', heroId: 54, heroNames: HERO_NAMES_CN });
    const zhFact = buildMatchFact(fixture, { lang: 'zh', heroId: 54, heroNames: HERO_NAMES_CN });
    const enFallback = buildFallbackAiCards(enFact, 'en') as ReviewCardsPayload;
    const zhFallback = buildFallbackAiCards(zhFact, 'zh') as ReviewCardsPayload;
    expect(enFallback.drill?.title).toBeTruthy();
    expect(enFallback.drill?.duration).toBeTruthy();
    expect(zhFallback.drill?.title).toBeTruthy();
    expect(zhFallback.drill?.duration).toBeTruthy();
    expect(isGroundedDrillMetadata(enFallback.drill!.title, 'en', 'title')).toBe(true);
    expect(isGroundedDrillMetadata(enFallback.drill!.duration, 'en', 'duration')).toBe(true);
    expect(isGroundedDrillMetadata(zhFallback.drill!.title, 'zh', 'title')).toBe(true);
    expect(isGroundedDrillMetadata(zhFallback.drill!.duration, 'zh', 'duration')).toBe(true);
  });

  it('replaces mentor notes with invented balance claims', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: '中期开团过早',
        explanation: '在经济落后时强行开团。',
        evidence: [{ factKey: 'timeline_0' }, { factKey: 'kda' }, { factKey: 'gold_lead_20' }],
      },
      key_moments: [
        { timestamp: 48, phase: 'lane', headline: '一血', why: '下路交出一血。', evidence: [{ factKey: 'timeline_0' }] },
        { timestamp: 1310, phase: 'mid', headline: '推中二塔', why: '扩大优势。', evidence: [{ factKey: 'timeline_2' }] },
        { timestamp: 2817, phase: 'late', headline: '肉山', why: '夜魇控肉山。', evidence: [{ factKey: 'timeline_5' }] },
      ],
      drill: { duration: '15 分钟', title: '练节奏', steps: ['每局只选一个改进点：进场、撤退或技能目标'] },
      mentor_note: '本版本拉比克偷智力有 35% spell amplification，应该多出羊刀。',
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.mentor_note).toBe(defaultMentorNote('zh'));
    expect(cards.mentor_note).not.toMatch(/35%|羊刀|amplification/i);
  });

  it('replaces mentor notes with invented ability mechanics', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: 'Mid fight too early',
        explanation: 'Forced a fight while behind.',
        evidence: [{ factKey: 'timeline_0' }, { factKey: 'kda' }, { factKey: 'gold_lead_20' }],
      },
      key_moments: [
        { timestamp: 48, phase: 'lane', headline: 'First Blood', why: 'Bot lane trade.', evidence: [{ factKey: 'timeline_0' }] },
        { timestamp: 1310, phase: 'mid', headline: 'Mid tier 2', why: 'Extended lead.', evidence: [{ factKey: 'timeline_2' }] },
        { timestamp: 2817, phase: 'late', headline: 'Roshan', why: 'Dire took Roshan.', evidence: [{ factKey: 'timeline_5' }] },
      ],
      drill: { duration: '15 min', title: 'Drill', steps: ['One focus: disengage when information is incomplete'] },
      mentor_note: 'Rubick gains 10 intelligence whenever he casts Telekinesis.',
    });
    const cards = parseAiReviewCards(llmJson, fact, 'en') as ReviewCardsPayload;
    expect(cards.mentor_note).toBe(defaultMentorNote('en'));
    expect(cards.mentor_note).not.toMatch(/intelligence|telekinesis/i);
  });

  it('deduplicates duplicate timeline key moments from model output', () => {
    const llmJson = JSON.stringify({
      primary_mistake: {
        category: 'fight_timing',
        headline: '失误',
        explanation: '解释',
        evidence: [{ factKey: 'timeline_0' }, { factKey: 'kda' }],
      },
      key_moments: [
        { timestamp: 48, evidence: [{ factKey: 'timeline_0' }], headline: 'a', why: 'a' },
        { timestamp: 48, evidence: [{ factKey: 'timeline_0' }], headline: 'b', why: 'b' },
        { timestamp: 48, evidence: [{ factKey: 'timeline_0' }], headline: 'c', why: 'c' },
      ],
      drill: { duration: '15 分钟', title: '练', steps: ['只练一件事：能不打就不打，信息不足时撤退'] },
    });
    const cards = parseAiReviewCards(llmJson, fact, 'zh') as ReviewCardsPayload;
    expect(cards.key_moments).toHaveLength(1);
    expect(hasDistinctKeyMoments(cards.key_moments ?? [], 1)).toBe(true);
  });
});

describe('unfocused match review', () => {
  it('uses neutral outcome and economy labels when heroId is omitted', () => {
    const fact = buildMatchFact(fixture, { lang: 'zh', heroNames: HERO_NAMES_CN });
    const cards = buildDeterministicReviewCards(fact, 'zh') as ReviewCardsPayload;
    expect(cards.match_summary?.result).toBe('neutral');
    expect(cards.match_summary?.resultLabel).toMatch(/夜魇|Dire/i);
    expect(cards.match_summary?.heroName).toBe('全场复盘');
    expect(cards.match_summary?.kda).toBeUndefined();
    expect(cards.match_summary?.gpm).toBeUndefined();
    const gold10 = cards.phases?.flatMap((p) => p.evidence).find((e) => e.factKey === 'gold_lead_10');
    expect(gold10?.label).not.toContain('我方');
    expect(gold10?.label).toMatch(/经济|Gold lead/);
    const mid = cards.phases?.find((p) => p.phase === 'mid');
    expect(mid?.insight).toMatch(/经济差|gold lead/i);
    expect(mid?.insight).not.toMatch(/我方经济|your-team gold/i);
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

  it('uses neutral late-phase wording for long matches', () => {
    const fact = buildMatchFact(fixture, { lang: 'zh', heroId: 54, heroNames: HERO_NAMES_CN });
    const cards = buildDeterministicReviewCards(fact, 'zh') as ReviewCardsPayload;
    const late = cards.phases?.find((p) => p.phase === 'late');
    expect(late?.insight).toContain('后期');
    expect(late?.insight).not.toContain('后期决策决定胜负');
    expect(late?.insight).not.toMatch(/decided the outcome/i);
    expect(late?.insight).not.toMatch(/阵亡|death/i);
    const deathEvidence = late?.evidence.find((e) => e.factKey === 'deaths');
    expect(deathEvidence).toBeUndefined();
  });

  it('does not claim late economy evidence when 30-minute checkpoint is missing', () => {
    const lateShortFixture = {
      ...fixture,
      duration: 27 * 60,
      radiant_gold_adv: (fixture.radiant_gold_adv || []).slice(0, 25),
    };
    const fact = buildMatchFact(lateShortFixture, { lang: 'zh', heroId: 54, heroNames: HERO_NAMES_CN });
    const cards = buildDeterministicReviewCards(fact, 'zh') as ReviewCardsPayload;
    const late = cards.phases?.find((p) => p.phase === 'late');
    expect(late?.insight).toContain('无 30 分钟经济检查点数据');
    expect(late?.insight).not.toContain('以下为后期经济数据');
    expect(late?.evidence).toEqual([]);

    const factEn = buildMatchFact(lateShortFixture, { lang: 'en', heroId: 54, heroNames: HERO_NAMES_CN });
    const cardsEn = buildDeterministicReviewCards(factEn, 'en') as ReviewCardsPayload;
    const lateEn = cardsEn.phases?.find((p) => p.phase === 'late');
    expect(lateEn?.insight).toMatch(/no 30-minute economy checkpoint/i);
    expect(lateEn?.insight).not.toMatch(/see economy evidence below/i);
    expect(lateEn?.evidence).toEqual([]);
  });

  it('does not prescribe mid-game tempo when match ends before 10 min', () => {
    const shortFixture = { ...fixture, duration: 8 * 60 };
    const fact = buildMatchFact(shortFixture, { lang: 'zh', heroId: 54, heroNames: HERO_NAMES_CN });
    const cards = buildDeterministicReviewCards(fact, 'zh') as ReviewCardsPayload;
    const mid = cards.phases?.find((p) => p.phase === 'mid');
    expect(mid?.insight).toContain('未进入典型中期');
    expect(mid?.insight).not.toMatch(/中期关注抱团|mid game.*tempo/i);
    expect(mid?.evidence).toEqual([]);
  });
});

describe('isReviewAiCardsComplete', () => {
  const groundedMoment = (factKey: string, ts: number, label: string) => ({
    timestamp: ts,
    headline: `标题 ${factKey}`,
    why: `说明 ${factKey}`,
    evidence: [{ factKey, label, value: label }],
  });
  const groundedMistake = {
    category: 'fight_timing',
    headline: '团战节奏偏慢',
    explanation: '中期开团过早导致失利。',
    evidence: [
      { factKey: 'timeline_0', label: '0:48', value: '一血' },
      { factKey: 'kda', label: 'KDA', value: '7/9/19' },
    ],
  };

  it('requires a nonempty drill, grounded moments, and primary-mistake evidence', () => {
    const m0 = groundedMoment('timeline_0', 48, '0:48');
    const m1 = groundedMoment('timeline_1', 800, '13:20');
    const m2 = groundedMoment('timeline_2', 1310, '21:50');
    expect(isReviewAiCardsComplete({
      primary_mistake: groundedMistake,
      key_moments: [m0, m1, m2],
      drill: { title: '', steps: [] },
    })).toBe(false);
    expect(isValidReviewDrill({ duration: '15 分钟', title: '练', steps: ['只练一件事：能不打就不打，信息不足时撤退'] })).toBe(true);
    expect(isReviewAiCardsComplete({
      primary_mistake: groundedMistake,
      key_moments: [m0, m1, {}],
      drill: { duration: '15 分钟', title: '练', steps: ['只练一件事：能不打就不打，信息不足时撤退'] },
    })).toBe(false);
    expect(isReviewAiCardsComplete({
      primary_mistake: { category: 'fight_timing' },
      key_moments: [m0, m1, m2],
      drill: { duration: '15 分钟', title: '练', steps: ['只练一件事：能不打就不打，信息不足时撤退'] },
    })).toBe(false);
    expect(isReviewAiCardsComplete({
      primary_mistake: groundedMistake,
      key_moments: [m0, m1, m2],
      drill: { duration: '15 分钟', title: '练', steps: ['只练一件事：能不打就不打，信息不足时撤退'] },
    })).toBe(true);
  });

  it('rejects duplicate timeline keys even when minKeyMoments is 1', () => {
    const m0 = groundedMoment('timeline_0', 48, '0:48');
    const dup = groundedMoment('timeline_0', 48, '0:48');
    const payload = {
      primary_mistake: groundedMistake,
      key_moments: [m0, dup, dup],
      drill: { duration: '15 分钟', title: '练', steps: ['只练一件事：能不打就不打，信息不足时撤退'] },
    };
    expect(hasDistinctKeyMoments(payload.key_moments, 1)).toBe(false);
    expect(isReviewAiCardsComplete(payload, { minKeyMoments: 1 })).toBe(false);
  });

  it('scales required key-moment count to available timeline facts', () => {
    const m0 = groundedMoment('timeline_0', 48, '0:48');
    const m1 = groundedMoment('timeline_1', 800, '13:20');
    const payload = {
      primary_mistake: groundedMistake,
      key_moments: [m0, m1],
      drill: { duration: '15 分钟', title: '练', steps: ['只练一件事：能不打就不打，信息不足时撤退'] },
    };
    expect(minRequiredKeyMoments(2)).toBe(2);
    expect(minRequiredKeyMoments(5)).toBe(3);
    expect(minRequiredKeyMoments(0)).toBe(0);
    expect(isReviewAiCardsComplete(payload)).toBe(false);
    expect(isReviewAiCardsComplete(payload, { minKeyMoments: 2 })).toBe(true);
    expect(isReviewAiCardsComplete(payload, { minKeyMoments: 0 })).toBe(true);
  });

  it('counts timeline facts in catalog for sparse matches', () => {
    const fact = buildMatchFact(fixture, { lang: 'zh', heroId: 54, heroNames: HERO_NAMES_CN });
    const det = buildDeterministicReviewCards(fact, 'zh') as ReviewCardsPayload & { _catalog?: Array<{ factKey: string }> };
    const timelineCount = countTimelineFactsInCatalog(det._catalog || []);
    expect(timelineCount).toBeGreaterThanOrEqual(3);
    expect(minRequiredKeyMoments(det._catalog || [])).toBe(3);
  });
});

describe('localizeKillTarget', () => {
  const fact = buildMatchFact(fixture, { lang: 'zh', heroNames: HERO_NAMES_CN });

  it('maps spirit_breaker slug to 裂魂人 in zh', () => {
    expect(localizeKillTarget('spirit_breaker', fact, 'zh')).toBe('裂魂人');
  });

  it('maps nevermore internal slug via player internalSlug', () => {
    const rosterFact = {
      players: [{
        heroId: 11,
        nameEn: 'Shadow Fiend',
        nameZh: '影魔',
        displayName: '影魔',
        internalSlug: 'nevermore',
      }],
    };
    expect(localizeKillTarget('nevermore', rosterFact, 'zh')).toBe('影魔');
    expect(localizeKillTarget('npc_dota_hero_nevermore', rosterFact, 'en')).toBe('Shadow Fiend');
  });
});

describe('formatTimestamp', () => {
  it('formats seconds as m:ss', () => {
    expect(formatTimestamp(48)).toBe('0:48');
    expect(formatTimestamp(1310)).toBe('21:50');
  });

  it('formats pre-horn negative seconds with a single leading sign', () => {
    expect(formatTimestamp(-5)).toBe('-0:05');
    expect(formatTimestamp(-65)).toBe('-1:05');
  });
});

describe('cs at 10 exact bucket', () => {
  it('omits cs_at_10 when replay lacks the exact 600-second bucket', () => {
    const fact = buildMatchFact(fixture, { lang: 'zh', heroId: 54, heroNames: HERO_NAMES_CN });
    const player = fact.players.find((p: { heroId: number }) => p.heroId === 54);
    if (player) {
      player.timeBuckets = [540, 660];
      player.lhTimeline = [40, 80];
    }
    const cards = buildDeterministicReviewCards(fact, 'zh') as ReviewCardsPayload & {
      _catalog?: Array<{ factKey: string }>;
    };
    const csEntry = cards._catalog?.find((e) => e.factKey === 'cs_at_10');
    expect(csEntry).toBeUndefined();
  });
});
