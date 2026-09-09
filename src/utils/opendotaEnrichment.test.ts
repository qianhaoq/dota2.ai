import { describe, it, expect } from 'vitest';
import {
  percentileForValue,
  buildBenchmarkComparison,
  compareItemBuild,
  normalizeItemKey,
  dotabuffHeroGuidesUrl,
  buildMatchupContext,
  baselineWinRateFromMatchups,
  buildHeroEnrichmentPayload,
  buildEnrichmentSectionCards,
  attachEnrichmentToMatchFact,
  buildRecipeComponentKeySet,
  isMajorPurchase,
} from '../../lib/matchReview/opendotaEnrichment.js';
import { buildFallbackAiCards, evidenceSupportsCategory } from '../../lib/matchReview/reviewCards.js';
import type { ReviewCardsPayload } from '../types/reviewCards';

describe('opendotaEnrichment', () => {
  it('normalizeItemKey strips item_ and resolves numeric ids via constants', () => {
    expect(normalizeItemKey('item_blink')).toBe('blink');
    expect(normalizeItemKey('Blink')).toBe('blink');
    expect(normalizeItemKey('1', { blink: { id: 1, dname: 'Blink Dagger' } })).toBe('blink');
    expect(normalizeItemKey(1, { blink: { id: 1 } })).toBe('blink');
  });

  it('dotabuffHeroGuidesUrl maps internal names to canonical Dotabuff slugs', () => {
    expect(dotabuffHeroGuidesUrl('nevermore')).toBe(
      'https://www.dotabuff.com/heroes/shadow-fiend/guides',
    );
    expect(dotabuffHeroGuidesUrl('skeleton_king')).toBe(
      'https://www.dotabuff.com/heroes/wraith-king/guides',
    );
    expect(dotabuffHeroGuidesUrl('furion')).toBe(
      'https://www.dotabuff.com/heroes/natures-prophet/guides',
    );
    expect(dotabuffHeroGuidesUrl('centaur')).toBe(
      'https://www.dotabuff.com/heroes/centaur-warrunner/guides',
    );
    expect(dotabuffHeroGuidesUrl('npc_dota_hero_centaur')).toBe(
      'https://www.dotabuff.com/heroes/centaur-warrunner/guides',
    );
    expect(dotabuffHeroGuidesUrl('life_stealer')).toBe(
      'https://www.dotabuff.com/heroes/lifestealer/guides',
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

  it('buildBenchmarkComparison uses last_hits_per_min (not aggregate last_hits)', () => {
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
        last_hits_per_min: [
          { percentile: 0.3, value: 4 },
          { percentile: 0.7, value: 8 },
        ],
        // Aggregate total must not be used when comparing LH/min.
        last_hits: [
          { percentile: 0.3, value: 100 },
          { percentile: 0.7, value: 200 },
        ],
      },
    };
    const cmp = buildBenchmarkComparison({
      actual: { gpm: 350, xpm: 500, lastHitsPerMin: 6 },
      benchmarks,
    });
    expect(cmp.gpm?.percentile).toBe(20);
    expect(cmp.xpm?.percentile).toBe(50);
    expect(cmp.lastHits?.percentile).toBe(50);
    expect(cmp.lastHits?.unit).toBe('per_min');

    // If last_hits_per_min is missing, omit metric — never fall back to aggregate last_hits.
    const cmpNoPerMin = buildBenchmarkComparison({
      actual: { gpm: 350, lastHitsPerMin: 6 },
      benchmarks: {
        result: {
          gold_per_min: benchmarks.result.gold_per_min,
          last_hits: benchmarks.result.last_hits,
        },
      },
    });
    expect(cmpNoPerMin.lastHits).toBeUndefined();
    expect(cmpNoPerMin.gpm?.percentile).toBe(20);
  });

  it('compareItemBuild normalizes keys and never invents expectedBy / delayed timing', () => {
    const result = compareItemBuild({
      purchaseLog: [
        { time: -80, key: 'item_tango' },
        { time: 200, key: 'boots' },
        { time: 1200, key: 'item_blink' }, // mid stage (10–25m) — matches midGame popularity
        { time: 2100, key: 'rapier' }, // late stage
      ],
      itemPopularity: {
        earlyGame: [{ key: 'boots', name: 'Boots', count: 100 }],
        // Popularity may arrive as numeric id string — must still match blink.
        midGame: [{ key: '1', name: 'Blink Dagger', count: 80 }],
        lateGame: [{ key: 'black_king_bar', name: 'Black King Bar', count: 60 }],
      },
      itemConstants: { blink: { id: 1, dname: 'Blink Dagger' } },
    });
    expect(result.unavailable).toBe(false);
    expect(result.actualCore.some((i: { key: string }) => i.key === 'blink')).toBe(true);
    expect(result.actualCore.every((i: { key: string }) => i.key !== 'tango')).toBe(true);
    expect((result as { delayed?: unknown }).delayed).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/expectedBy/);
    expect(result.offMeta.some((o: { key: string }) => o.key === 'rapier')).toBe(true);
    expect(result.missingPopular.some((m: { key: string }) => m.key === 'black_king_bar')).toBe(true);
    // Blink purchased and present in popular mid after id→key normalize — not missing.
    expect(result.missingPopular.every((m: { key: string }) => m.key !== 'blink')).toBe(true);
  });

  it('compareItemBuild preserves missing purchase history as unavailable', () => {
    const result = compareItemBuild({
      purchaseLog: null as unknown as [],
      itemPopularity: {
        midGame: [{ key: 'blink', name: 'Blink', count: 10 }],
      },
    });
    expect(result.unavailable).toBe(true);
    expect(result.missingPopular).toEqual([]);
  });

  it('compareItemBuild treats null popularity (failed fetch) as unavailable', () => {
    const result = compareItemBuild({
      purchaseLog: [
        { time: 900, key: 'blink' },
        { time: 1500, key: 'black_king_bar' },
      ],
      itemPopularity: null as unknown as {},
    });
    expect(result.unavailable).toBe(true);
    expect(result.offMeta).toEqual([]);
    expect(result.missingPopular).toEqual([]);
  });

  it('compareItemBuild treats startGame-only / empty early-mid-late popularity as unavailable', () => {
    const startOnly = compareItemBuild({
      purchaseLog: [{ time: 900, key: 'blink' }],
      itemPopularity: {
        startGame: [{ key: 'tango', name: 'Tango', count: 50 }],
        earlyGame: [],
        midGame: [],
        lateGame: [],
      },
    });
    expect(startOnly.unavailable).toBe(true);
    expect(startOnly.offMeta).toEqual([]);

    const empty = compareItemBuild({
      purchaseLog: [{ time: 900, key: 'blink' }],
      itemPopularity: { earlyGame: [], midGame: [], lateGame: [] },
    });
    expect(empty.unavailable).toBe(true);
  });

  it('compareItemBuild derives component filtering from recipe constants (relic/talisman)', () => {
    const itemConstants = {
      relic: { id: 54, dname: 'Sacred Relic', qual: 'secret_shop', components: null, created: false },
      talisman_of_evasion: { id: 32, dname: 'Talisman of Evasion', qual: 'secret_shop', components: null, created: false },
      radiance: {
        id: 63,
        dname: 'Radiance',
        components: ['relic', 'talisman_of_evasion'],
        created: true,
        qual: 'epic',
      },
      blink: {
        id: 1,
        dname: 'Blink Dagger',
        qual: 'component',
        // No behavior/abilities — OpenDota /constants/items does not reliably supply them.
        components: null,
        created: false,
        cost: 2250,
      },
      ghost: {
        id: 37,
        dname: 'Ghost Scepter',
        qual: 'component',
        components: null,
        created: false,
        cost: 1500,
      },
      ethereal_blade: {
        id: 176,
        dname: 'Ethereal Blade',
        components: ['ghost', 'crystalys'],
        created: true,
      },
      force_staff: {
        id: 102,
        dname: 'Force Staff',
        components: ['staff_of_wizardry', 'fluffy_hat'],
        created: true,
        cost: 2200,
      },
      hurricane_pike: {
        id: 263,
        components: ['force_staff', 'dragon_lance'],
        created: true,
      },
      overwhelming_blink: {
        id: 600,
        components: ['blink', 'reaver'],
        created: true,
      },
      reaver: { id: 53, qual: 'secret_shop', components: null },
      black_king_bar: {
        id: 116,
        dname: 'Black King Bar',
        qual: 'epic',
        created: true,
        components: ['mithril_hammer', 'ogre_axe'],
        behavior: 'NO_TARGET',
        abilities: { '0': 'bkb' },
      },
      mithril_hammer: { id: 8, qual: 'component', components: null },
      ogre_axe: { id: 21, qual: 'component', components: null },
    };

    expect(buildRecipeComponentKeySet(itemConstants).has('relic')).toBe(true);
    expect(buildRecipeComponentKeySet(itemConstants).has('talisman_of_evasion')).toBe(true);
    expect(isMajorPurchase('relic', itemConstants)).toBe(false);
    expect(isMajorPurchase('talisman_of_evasion', itemConstants)).toBe(false);
    expect(isMajorPurchase('blink', itemConstants)).toBe(true); // standalone allowlist, no behavior/abilities
    expect(isMajorPurchase('ghost', itemConstants)).toBe(true);
    expect(isMajorPurchase('force_staff', itemConstants)).toBe(true); // crafted + upgrade input
    expect(isMajorPurchase('black_king_bar', itemConstants)).toBe(true);
    expect(isMajorPurchase('ogre_axe', itemConstants)).toBe(false);

    const result = compareItemBuild({
      purchaseLog: [
        { time: 900, key: 'relic' },
        { time: 1000, key: 'talisman_of_evasion' },
        { time: 1200, key: 'blink' },
        { time: 1800, key: 'black_king_bar' },
      ],
      itemPopularity: {
        earlyGame: [],
        midGame: [{ key: 'blink', name: 'Blink', count: 80 }],
        lateGame: [{ key: 'black_king_bar', name: 'Black King Bar', count: 60 }],
      },
      itemConstants,
    });
    expect(result.unavailable).toBe(false);
    expect(result.actualCore.every((i: { key: string }) => i.key !== 'relic')).toBe(true);
    expect(result.actualCore.every((i: { key: string }) => i.key !== 'talisman_of_evasion')).toBe(true);
    expect(result.offMeta.every((o: { key: string }) => o.key !== 'relic')).toBe(true);
    expect(result.offMeta.every((o: { key: string }) => o.key !== 'talisman_of_evasion')).toBe(true);
    expect(result.actualCore.some((i: { key: string }) => i.key === 'blink')).toBe(true);
    expect(result.actualCore.some((i: { key: string }) => i.key === 'black_king_bar')).toBe(true);
  });

  it('compareItemBuild keeps upgradeable standalones without behavior/abilities fields', () => {
    const itemConstants = {
      blink: { id: 1, dname: 'Blink Dagger', qual: 'component', components: null, created: false, cost: 2250 },
      overwhelming_blink: { id: 600, components: ['blink', 'reaver'], created: true },
      reaver: { id: 53, qual: 'secret_shop', components: null, created: false },
      relic: { id: 54, qual: 'secret_shop', components: null, created: false },
      radiance: { id: 63, components: ['relic', 'talisman_of_evasion'], created: true },
      talisman_of_evasion: { id: 32, components: null, created: false },
    };
    expect(isMajorPurchase('blink', itemConstants)).toBe(true);
    expect(isMajorPurchase('relic', itemConstants)).toBe(false);

    const result = compareItemBuild({
      purchaseLog: [
        { time: 900, key: 'relic' },
        { time: 1200, key: 'blink' },
      ],
      itemPopularity: {
        earlyGame: [],
        midGame: [{ key: 'blink', name: 'Blink', count: 80 }],
        lateGame: [],
      },
      itemConstants,
    });
    expect(result.actualCore.some((i: { key: string }) => i.key === 'blink')).toBe(true);
    expect(result.actualCore.every((i: { key: string }) => i.key !== 'relic')).toBe(true);
    expect(result.offMeta.every((o: { key: string }) => o.key !== 'blink')).toBe(true);
  });

  it('compareItemBuild requires stage-specific popularity for offMeta (no sparse-bucket union)', () => {
    // Only early bucket populated — mid/late purchases must NOT be judged Uncommon against early.
    const earlyOnly = compareItemBuild({
      purchaseLog: [
        { time: 12 * 60, key: 'aether_lens' }, // mid purchase
        { time: 30 * 60, key: 'rapier' }, // late purchase
      ],
      itemPopularity: {
        earlyGame: [{ key: 'boots', name: 'Boots', count: 100 }],
        midGame: [],
        lateGame: [],
      },
    });
    expect(earlyOnly.unavailable).toBe(false);
    expect(earlyOnly.offMeta).toEqual([]);

    // Mid bucket present: mid off-meta fires; late still suppressed when late empty.
    const midOnly = compareItemBuild({
      purchaseLog: [
        { time: 12 * 60, key: 'aether_lens' },
        { time: 14 * 60, key: 'blink' },
        { time: 30 * 60, key: 'rapier' },
      ],
      itemPopularity: {
        earlyGame: [],
        midGame: [{ key: 'blink', name: 'Blink', count: 80 }],
        lateGame: [],
      },
    });
    expect(midOnly.offMeta.some((o: { key: string }) => o.key === 'aether_lens')).toBe(true);
    expect(midOnly.offMeta.every((o: { key: string }) => o.key !== 'blink')).toBe(true);
    expect(midOnly.offMeta.every((o: { key: string }) => o.key !== 'rapier')).toBe(true);
  });

    it('compareItemBuild counts consumable/component purchases in possession keys', () => {
    // aghanims_shard is filtered from actualCore but must still satisfy popular membership.
    const result = compareItemBuild({
      purchaseLog: [
        { time: 1200, key: 'blink' },
        { time: 1500, key: 'aghanims_shard' },
      ],
      itemPopularity: {
        midGame: [{ key: 'aghanims_shard', name: "Aghanim's Shard", count: 90 }],
        lateGame: [{ key: 'black_king_bar', name: 'Black King Bar', count: 70 }],
      },
    });
    expect(result.unavailable).toBe(false);
    expect(result.actualCore.every((i: { key: string }) => i.key !== 'aghanims_shard')).toBe(true);
    expect(result.missingPopular.every((m: { key: string }) => m.key !== 'aghanims_shard')).toBe(true);
    expect(result.missingPopular.some((m: { key: string }) => m.key === 'black_king_bar')).toBe(true);
  });

  it('compareItemBuild builds popularKeys from full lists before display slice', () => {
    // OpenDota retains top 10 per bucket; display slices to 6. Rank 7–10 must not be Uncommon.
    const midGame = [
      { key: 'blink', name: 'Blink', count: 100 },
      { key: 'force_staff', name: 'Force Staff', count: 90 },
      { key: 'aether_lens', name: 'Aether Lens', count: 80 },
      { key: 'glimmer_cape', name: 'Glimmer Cape', count: 70 },
      { key: 'ghost', name: 'Ghost Scepter', count: 60 },
      { key: 'cyclone', name: 'Eul\'s Scepter', count: 50 },
      { key: 'orchid', name: 'Orchid', count: 40 }, // rank 7
      { key: 'dagon', name: 'Dagon', count: 30 },
      { key: 'veil_of_discord', name: 'Veil', count: 20 },
      { key: 'rod_of_atos', name: 'Atos', count: 10 },
    ];
    const result = compareItemBuild({
      purchaseLog: [
        { time: 900, key: 'blink' },
        { time: 1400, key: 'orchid' }, // popular mid rank 7 — must not be offMeta
      ],
      itemPopularity: {
        earlyGame: [],
        midGame,
        lateGame: [{ key: 'black_king_bar', name: 'Black King Bar', count: 60 }],
      },
    });
    expect(result.unavailable).toBe(false);
    expect(result.popularMid).toHaveLength(6);
    expect(result.popularMid.every((p: { key: string }) => p.key !== 'orchid')).toBe(true);
    expect(result.offMeta.every((o: { key: string }) => o.key !== 'orchid')).toBe(true);
  });

  it('compareItemBuild omits unreached late/mid stages from missingPopular', () => {
    const popularity = {
      earlyGame: [{ key: 'boots', name: 'Boots', count: 100 }],
      midGame: [{ key: 'blink', name: 'Blink', count: 80 }],
      lateGame: [{ key: 'black_king_bar', name: 'Black King Bar', count: 60 }],
    };
    const short = compareItemBuild({
      purchaseLog: [{ time: 600, key: 'boots' }],
      itemPopularity: popularity,
      durationSec: 12 * 60, // mid reached, late not
    });
    expect(short.unavailable).toBe(false);
    expect(short.popularLate.some((p: { key: string }) => p.key === 'black_king_bar')).toBe(true); // reference only
    expect(short.missingPopular.some((m: { key: string }) => m.key === 'blink')).toBe(true);
    expect(short.missingPopular.every((m: { key: string }) => m.key !== 'black_king_bar')).toBe(true);

    const preMid = compareItemBuild({
      purchaseLog: [{ time: 200, key: 'boots' }],
      itemPopularity: popularity,
      durationSec: 8 * 60, // neither mid nor late reached
    });
    expect(preMid.missingPopular).toEqual([]);
    expect(preMid.popularMid.some((p: { key: string }) => p.key === 'blink')).toBe(true);
  });

  it('baselineWinRateFromMatchups aggregates matchup population (not heroStats)', () => {
    const baseline = baselineWinRateFromMatchups({
      1: { gamesPlayed: 100, wins: 55, winRate: '55.0' },
      2: { gamesPlayed: 100, wins: 45, winRate: '45.0' },
    });
    // (55+45)/(100+100) = 50%
    expect(baseline).toBe(50);
    expect(baselineWinRateFromMatchups({})).toBeNull();
    expect(baselineWinRateFromMatchups(null)).toBeNull();
  });

  it('buildMatchupContext computes advantage vs hero baseline (not 50%)', () => {
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
      baselineWinRate: 52,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].heroName).toBe('斧王');
    // 40 - 52 = -12
    expect(rows[0].advantage).toBe(-12);
    expect(rows[0].advantageLabel).toBe('-12.0%');
    // 60 - 52 = +8
    expect(rows[1].advantage).toBe(8);
  });

  it('buildHeroEnrichmentPayload + section cards enrich fallback review without farm_route', () => {
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
          last_hits_per_min: [
            { percentile: 0.2, value: 2 },
            { percentile: 0.5, value: 5 },
          ],
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
      baselineWinRate: 48,
    });

    expect(enrichment?.guidesUrl).toContain('/heroes/bane/guides');
    expect(enrichment?.benchmarks?.gpm?.percentile).toBeLessThanOrEqual(20);
    expect(enrichment?.benchmarks?.lastHits?.unit).toBe('per_min');
    // 40 LH / 40 min = 1 LH/min → low percentile on last_hits_per_min
    expect(enrichment?.benchmarks?.lastHits?.percentile).toBeLessThanOrEqual(20);
    expect(enrichment?.matchups?.[0]?.advantage).toBeCloseTo(41.7 - 48, 5);

    const enriched = attachEnrichmentToMatchFact(matchFact, enrichment!);
    const sections = buildEnrichmentSectionCards(enriched, 'zh') as ReviewCardsPayload;
    expect(sections.item_compare?.title).toBe('出装对比');
    expect(sections.farm_benchmarks?.title).toBe('对线/经济对标');
    expect(sections.matchup_context?.title).toBe('克制关系');

    const cards = buildFallbackAiCards(enriched, 'zh', { includeFollowups: false }) as ReviewCardsPayload;
    expect(cards.item_compare).toBeTruthy();
    expect(cards.farm_benchmarks).toBeTruthy();
    // Aggregate farm must not become farm_route classification.
    expect(cards.primary_mistake?.category).not.toBe('farm_route');
    expect(evidenceSupportsCategory('farm_route', [
      { factKey: 'gpm_percentile' },
      { factKey: 'lh_percentile' },
    ])).toBe(false);
    expect(JSON.stringify(cards)).not.toMatch(/expectedBy/);
  });

  it('marks itemCompare unavailable when itemPopularity fetch failed (null)', () => {
    const matchFact = {
      summary: { matchId: 3, duration: 1800 },
      focusHeroId: 11,
      players: [
        {
          heroId: 11,
          isRadiant: true,
          displayName: '影魔',
          internalSlug: 'nevermore',
          gpm: 500,
          xpm: 550,
          lastHits: 200,
          purchaseLog: [{ time: 1200, key: 'blink' }],
        },
      ],
    };
    const enrichment = buildHeroEnrichmentPayload({
      matchFact,
      benchmarks: null,
      itemPopularity: null,
      matchupsMap: {},
      lang: 'en',
    });
    expect(enrichment?.itemCompare?.unavailable).toBe(true);
    const sections = buildEnrichmentSectionCards(
      attachEnrichmentToMatchFact(matchFact, enrichment!),
      'en',
    ) as ReviewCardsPayload;
    expect(sections.item_compare).toBeUndefined();
  });

  it('skips item compare when purchaseLog is absent (not empty array)', () => {
    const matchFact = {
      summary: { matchId: 2, duration: 1800 },
      focusHeroId: 11,
      players: [
        {
          heroId: 11,
          isRadiant: true,
          displayName: '影魔',
          internalSlug: 'nevermore',
          gpm: 500,
          xpm: 550,
          lastHits: 200,
          // purchaseLog omitted intentionally
        },
      ],
    };
    const enrichment = buildHeroEnrichmentPayload({
      matchFact,
      benchmarks: null,
      itemPopularity: {
        midGame: [{ key: 'blink', name: 'Blink', count: 50 }],
      },
      matchupsMap: {},
      lang: 'en',
    });
    expect(enrichment?.itemCompare).toBeNull();
    expect(enrichment?.guidesUrl).toContain('/heroes/shadow-fiend/guides');
    const sections = buildEnrichmentSectionCards(
      attachEnrichmentToMatchFact(matchFact, enrichment!),
      'en',
    ) as ReviewCardsPayload;
    expect(sections.item_compare).toBeUndefined();
  });
});
