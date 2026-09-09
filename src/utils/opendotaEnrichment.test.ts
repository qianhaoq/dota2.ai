import { describe, it, expect } from 'vitest';
import {
  percentileForValue,
  buildBenchmarkComparison,
  compareItemBuild,
  dotabuffHeroGuidesUrl,
  buildMatchupContext,
  buildHeroEnrichmentPayload,
  buildEnrichmentSectionCards,
  attachEnrichmentToMatchFact,
} from '../../lib/matchReview/opendotaEnrichment.js';
import { buildFallbackAiCards } from '../../lib/matchReview/reviewCards.js';
import type { ReviewCardsPayload } from '../types/reviewCards';

describe('opendotaEnrichment', () => {
  it('dotabuffHeroGuidesUrl maps underscores to hyphens', () => {
    expect(dotabuffHeroGuidesUrl('life_stealer')).toBe(
      'https://www.dotabuff.com/heroes/life-stealer/guides',
    );
    expect(dotabuffHeroGuidesUrl('npc_dota_hero_bane')).toBe(
      'https://www.dotabuff.com/heroes/bane/guides',
    );
    expect(dotabuffHeroGuidesUrl(null)).toBeNull();
  });

  it('percentileForValue interpolates between OpenDota rows', () => {
    const rows = [
      { percentile: 0.1, value: 300 },
      { percentile: 0.5, value: 450 },
      { percentile: 0.9, value: 600 },
    ];
    expect(percentileForValue(rows, 300)).toBe(10);
    expect(percentileForValue(rows, 600)).toBe(90);
    expect(percentileForValue(rows, 450)).toBe(50);
    expect(percentileForValue(rows, 375)).toBe(30);
    expect(percentileForValue([], 400)).toBeNull();
  });

  it('buildBenchmarkComparison maps gpm/xpm/lh', () => {
    const benchmarks = {
      result: {
        gold_per_min: [
          { percentile: 0.2, value: 350 },
          { percentile: 0.5, value: 450 },
          { percentile: 0.8, value: 550 },
        ],
        xp_per_min: [
          { percentile: 0.5, value: 500 },
        ],
        last_hits: [
          { percentile: 0.3, value: 100 },
          { percentile: 0.7, value: 200 },
        ],
      },
    };
    const cmp = buildBenchmarkComparison({
      actual: { gpm: 350, xpm: 500, lastHits: 150 },
      benchmarks,
    });
    expect(cmp.gpm?.percentile).toBe(20);
    expect(cmp.xpm?.percentile).toBe(50);
    expect(cmp.lastHits?.percentile).toBe(50);
  });

  it('compareItemBuild flags delayed and off-meta majors', () => {
    const result = compareItemBuild({
      purchaseLog: [
        { time: -80, key: 'tango' },
        { time: 200, key: 'boots' },
        { time: 1800, key: 'blink' },
        { time: 2100, key: 'rapier' },
      ],
      itemPopularity: {
        earlyGame: [{ key: 'boots', name: 'Boots', count: 100 }],
        midGame: [{ key: 'blink', name: 'Blink Dagger', count: 80 }],
        lateGame: [{ key: 'black_king_bar', name: 'Black King Bar', count: 60 }],
      },
      durationSeconds: 2400,
    });
    expect(result.actualCore.some((i: { key: string }) => i.key === 'blink')).toBe(true);
    expect(result.actualCore.every((i: { key: string }) => i.key !== 'tango')).toBe(true);
    expect(result.delayed.some((d: { key: string }) => d.key === 'blink')).toBe(true);
    expect(result.offMeta.some((o: { key: string }) => o.key === 'rapier')).toBe(true);
    expect(result.missingPopular.some((m: { key: string }) => m.key === 'black_king_bar')).toBe(true);
  });

  it('buildMatchupContext filters low sample and sorts hardest first', () => {
    const rows = buildMatchupContext({
      focusHeroId: 3,
      enemyHeroIds: [1, 2, 8],
      matchupsMap: {
        1: { gamesPlayed: 10, wins: 6, winRate: '60.0', advantage: '10.0' },
        2: { gamesPlayed: 100, wins: 40, winRate: '40.0', advantage: '-10.0' },
        8: { gamesPlayed: 80, wins: 48, winRate: '60.0', advantage: '10.0' },
      },
      heroNames: {
        2: { nameZh: '斧王', nameEn: 'Axe' },
        8: { nameZh: '主宰', nameEn: 'Juggernaut' },
      },
      lang: 'zh',
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].heroName).toBe('斧王');
    expect(rows[0].advantage).toBeLessThan(0);
  });

  it('buildHeroEnrichmentPayload + section cards enrich fallback review', () => {
    const matchFact = {
      summary: { matchId: 1, duration: 2400, durationFormatted: '40:00', radiantWin: false },
      focusHeroId: 3,
      focusLens: { displayName: '祸乱之源', kda: '2/10/12', gpm: 280, laneGrounded: true, opponents: [], nearby: [] },
      players: [
        {
          heroId: 3,
          isRadiant: true,
          nameZh: '祸乱之源',
          nameEn: 'Bane',
          displayName: '祸乱之源',
          internalSlug: 'bane',
          kills: 2,
          deaths: 10,
          assists: 12,
          gpm: 280,
          xpm: 320,
          lastHits: 40,
          purchaseLog: [
            { time: 400, key: 'boots' },
            { time: 1600, key: 'aether_lens' },
          ],
          lhTimeline: [0, 5, 10, 40],
        },
        {
          heroId: 8,
          isRadiant: false,
          nameZh: '主宰',
          nameEn: 'Juggernaut',
          displayName: '主宰',
          kills: 12,
          deaths: 2,
          assists: 5,
          gpm: 600,
          xpm: 700,
        },
      ],
      economy: { checkpoints: [] },
      timeline: [],
    };

    const enrichment = buildHeroEnrichmentPayload({
      matchFact,
      benchmarks: {
        result: {
          gold_per_min: [
            { percentile: 0.2, value: 300 },
            { percentile: 0.5, value: 400 },
          ],
          xp_per_min: [{ percentile: 0.2, value: 350 }],
          last_hits: [{ percentile: 0.2, value: 80 }],
        },
      },
      itemPopularity: {
        midGame: [{ key: 'aether_lens', name: 'Aether Lens', count: 90 }],
        lateGame: [{ key: 'aeon_disk', name: 'Aeon Disk', count: 70 }],
      },
      matchupsMap: {
        8: { gamesPlayed: 120, wins: 50, winRate: '41.7', advantage: '-8.3' },
      },
      lang: 'zh',
    });

    expect(enrichment?.guidesUrl).toContain('/heroes/bane/guides');
    expect(enrichment?.benchmarks?.gpm?.percentile).toBeLessThanOrEqual(20);

    const enriched = attachEnrichmentToMatchFact(matchFact, enrichment!);
    const sections = buildEnrichmentSectionCards(enriched, 'zh') as ReviewCardsPayload;
    expect(sections.item_compare?.title).toBe('出装对比');
    expect(sections.farm_benchmarks?.title).toBe('对线/经济对标');
    expect(sections.matchup_context?.title).toBe('克制关系');

    const cards = buildFallbackAiCards(enriched, 'zh', { includeFollowups: false }) as ReviewCardsPayload;
    expect(cards.item_compare).toBeTruthy();
    expect(cards.farm_benchmarks).toBeTruthy();
    expect(cards.primary_mistake?.category).toBe('farm_route');
    expect(cards.drill?.title).not.toBe('下一局只练一件事');
    expect(JSON.stringify(cards)).not.toMatch(/每局只选一个改进点/);
  });
});
