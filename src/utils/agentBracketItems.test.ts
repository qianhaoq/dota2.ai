import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { BRACKET_ITEMS_MIN_BUYS, BRACKET_ITEMS_MIN_GAMES, bracketItemsFor } from '../../lib/coach/bracketItems.js';
import { patchData, patchForGame } from '../../lib/agent/patchData.js';
import { proItemChoices } from '../../lib/agent/knowledgeTools.js';
import { buildCheck } from '../../lib/agent/situationTools.js';
import { goalFromReview } from '../../lib/agent/goal.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { deepReviewSystem, verifyReview } from '../../lib/agent/deepReview.js';
import {
  BRACKETS,
  POSITIONS,
  WEEK,
  aggregateBracketItems,
  buildDenominatorQuery,
  buildItemBatchQuery,
  calibrateWarmup,
  detectTimeUnit,
  extractWeekDenominators,
  filterRowsForCache,
  medianMinuteFromBins,
  parseIntrospection,
  selectCompletedWeeks,
} from '../../scripts/coach-bracket-items.mjs';

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const match = JSON.parse(readFileSync(new URL('../fixtures/agent/match9100904020.scoreboard.json', import.meta.url), 'utf8'));

const BEASTMASTER = 38;

function makeSnapshot(overrides: any = {}) {
  return {
    source: 'STRATZ (https://stratz.com) heroStats.itemFullPurchase and heroStats.stats',
    attribution: { en: 'Data: STRATZ', url: 'https://stratz.com' },
    window: 'finished between 10:00 and 24:59',
    patch: '7.42',
    weeks: { from: '2026-11-19', to: '2026-11-25', count: 1 },
    fetched: '2026-11-27',
    heroes: {
      la: {
        [String(BEASTMASTER)]: {
          3: {
            games: 600,
            wins: 324,
            items: [
              ['helm_of_the_overlord', 390, 218, 17],
              ['blink', 312, 174, 15],
              ['black_king_bar', 210, 122, 22],
              ['caduceus', 90, 52, 20],
            ],
          },
          4: {
            games: 180,
            wins: 99,
            items: [
              ['aghanims_shard', 108, 63, 18],
              ['pipe', 84, 48, 21],
              ['glimmer_cape', 62, 35, 19],
              ['caduceus', 40, 23, 22],
              ['bracer', 150, 80, 11], // non-big item: filtered out
              ['lotus_orb', 12, 7, 23], // below BRACKET_ITEMS_MIN_BUYS (25): filtered out
            ],
          },
          5: {
            games: 20, // below BRACKET_ITEMS_MIN_GAMES (50)
            wins: 10,
            items: [['glimmer_cape', 14, 8, 19]],
          },
          core: {
            games: 680,
            wins: 365,
            items: [
              ['helm_of_the_overlord', 410, 229, 17],
              ['blink', 340, 188, 15],
              ['black_king_bar', 240, 138, 22],
            ],
          },
          support: {
            games: 200,
            wins: 109,
            items: [
              ['aghanims_shard', 116, 67, 18],
              ['pipe', 88, 50, 21],
              ['glimmer_cape', 76, 43, 19],
              ['caduceus', 42, 24, 22],
            ],
          },
        },
      },
    },
    ...overrides,
  };
}

describe('bracketItemsFor: public mid-game items by bracket and role (Unknown is not false)', () => {
  const snap = makeSnapshot();
  const pd742 = patchData('7.42');

  it('uses exact Pos 1–5 when known with enough games, filtering small-buy and non-big items', () => {
    const pos4 = bracketItemsFor(BEASTMASTER, { bracket: 'la', pos: 4, kind: 'support', hasMatch: true }, pd742, snap);
    expect(pos4.gaps).toEqual([]);
    expect(pos4.result).toMatchObject({
      bracket: 'la',
      role_group: 'position_4',
      position: 4,
      public_games: 180,
      win_rate: 0.55,
      patch: '7.42',
      source: 'STRATZ',
    });
    expect(pos4.result!.items).toEqual([
      { item: 'aghanims_shard', purchases: 108, share_of_public_games: 0.6, win_rate: 0.58, median_minute: 18 },
      { item: 'pipe', purchases: 84, share_of_public_games: 0.47, win_rate: 0.57, median_minute: 21 },
      { item: 'glimmer_cape', purchases: 62, share_of_public_games: 0.34, win_rate: 0.56, median_minute: 19 },
      { item: 'caduceus', purchases: 40, share_of_public_games: 0.22, win_rate: 0.57, median_minute: 22 },
    ]);
  });

  it('falls back to pooled core/support with a stated position gap when exact pos has < 50 games or is unknown', () => {
    // Pos 5 has only 20 games (< 50): falls back to support (Pos 4–5 = 200 games), never mixing in core Pos 1–3!
    const pos5 = bracketItemsFor(BEASTMASTER, { bracket: 'la', pos: 5, kind: 'support', hasMatch: true }, pd742, snap);
    expect(pos5.result).toMatchObject({ bracket: 'la', role_group: 'support', public_games: 200 });
    expect(pos5.result).not.toHaveProperty('position');
    expect(pos5.gaps).toEqual([{ topic: 'rank_bracket_items_position', reason: 'too_few_public_games_in_position_5_using_support' }]);

    // Unparsed match: pos is null, kind is 'core' -> uses pooled core (680 games) and explains why.
    const coreOnly = bracketItemsFor(BEASTMASTER, { bracket: 'la', pos: null, kind: 'core', hasMatch: true }, pd742, snap);
    expect(coreOnly.result).toMatchObject({ bracket: 'la', role_group: 'core', public_games: 680 });
    expect(coreOnly.gaps).toEqual([{ topic: 'rank_bracket_items_position', reason: 'exact_position_unknown_using_core' }]);
  });

  it('returns null + gaps (never [] or mixed core+support) when match, bracket, role, release, snapshot or sample is missing', () => {
    expect(bracketItemsFor(BEASTMASTER, { hasMatch: false }, pd742, snap)).toEqual({
      result: null,
      gaps: [{ topic: 'rank_bracket_items', reason: 'no_match_data_for_this_game' }],
    });
    expect(bracketItemsFor(BEASTMASTER, { bracket: null, pos: 3, kind: 'core', hasMatch: true }, pd742, snap)).toEqual({
      result: null,
      gaps: [{ topic: 'rank_bracket_items', reason: 'bracket_unknown_for_this_game' }],
    });
    expect(bracketItemsFor(BEASTMASTER, { bracket: 'la', pos: null, kind: null, hasMatch: true }, pd742, snap)).toEqual({
      result: null,
      gaps: [{ topic: 'rank_bracket_items', reason: 'role_unknown_for_this_game' }],
    });
    expect(bracketItemsFor(BEASTMASTER, { bracket: 'la', pos: 3, kind: 'core', hasMatch: true }, pd742, { patch: null, heroes: {} })).toEqual({
      result: null,
      gaps: [{ topic: 'rank_bracket_items', reason: 'public_bracket_item_snapshot_not_built_yet' }],
    });
    expect(bracketItemsFor(BEASTMASTER, { bracket: 'di', pos: 3, kind: 'core', hasMatch: true }, pd742, snap)).toEqual({
      result: null,
      gaps: [{ topic: 'rank_bracket_items', reason: 'too_few_public_games_in_this_bracket_and_role' }],
    });
    expect(bracketItemsFor(BEASTMASTER, { bracket: 'la', pos: 3, kind: 'core', hasMatch: true }, pd742, {
      ...snap,
      heroes: { la: { [String(BEASTMASTER)]: { 3: { games: BRACKET_ITEMS_MIN_GAMES, wins: 25, items: [['blink', BRACKET_ITEMS_MIN_BUYS - 1, 12, 15]] } } } },
    })).toEqual({
      result: null,
      gaps: [{ topic: 'rank_bracket_items', reason: 'too_few_mid_game_item_purchases_in_this_bracket_and_role' }],
    });
  });

  it('filters out items that did not exist in an older patch, flags cross-patch data, and refuses unplaced games', () => {
    // 7.41f did not have 7.42's Caduceus: filtered out by pd.has(k), and cross-patch gap recorded.
    const on741f = bracketItemsFor(BEASTMASTER, { bracket: 'la', pos: 4, kind: 'support', hasMatch: true }, patchData('7.41f'), snap);
    expect(on741f.result!.from_another_patch).toBe(true);
    expect(on741f.result!.items.map((x: any) => x.item)).not.toContain('caduceus');
    expect(on741f.result!.items.map((x: any) => x.item)).toContain('pipe');
    expect(on741f.gaps).toEqual([{ topic: 'rank_bracket_items_patch', reason: 'measured_in_7.42_for_a_7.41f_game' }]);

    // Unplaced 7.39 game (patch 58): refuses to guess which items existed then.
    const oldUnplaced = patchForGame(trace.match_id, { patch: 58, start_time: 1750000000 });
    const refused = bracketItemsFor(BEASTMASTER, { bracket: 'la', pos: 4, kind: 'support', hasMatch: true }, oldUnplaced, snap);
    expect(refused.result).toBeNull();
    expect(refused.gaps[0].reason).toContain('release_of_this_game_not_known');
  });
});

describe('pro_item_choices, build_check, goalFromReview & prompt de-rigidification (#423)', () => {
  const snap = makeSnapshot();
  const rankedMatch = {
    ...match,
    players: match.players.map((p: any) => ({ ...p, rank_tier: 55 })), // Legend–Ancient (la)
  };

  it('removes the rigid "Never advise another item ahead of it" ban and checks purpose-equivalent held items', () => {
    const system = deepReviewSystem('en');
    expect(system).not.toContain('Never advise another item ahead of it');
    expect(system).toContain('player_already_held_for_this_purpose');
    expect(system).toContain('public_items_in_this_bracket');
    expect(system).toContain('most_built_in_this_bracket');
    expect(system).toContain('most_built_by_pros_on_this_hero');
  });

  it('surfaces purpose-equivalent held items and bracket × role items in build_check & pro_item_choices, and verifies cited claims', () => {
    const build: any = buildCheck(trace, { hero: 'beastmaster' }, { lang: 'zh', match: rankedMatch, bracketData: snap });
    const pro: any = proItemChoices(trace, { hero: 'beastmaster' }, { lang: 'zh', match: rankedMatch, bracketData: snap });

    // Beastmaster in 9100904020 built Aghanim's Scepter (16:48), Pipe (29:08), Assault Cuirass (38:58).
    expect(build.player_already_held_for_this_purpose).toEqual({
      attack_damage_or_armor: [{ item: 'assault', name: '强袭胸甲', first_held: '38:58', matched_purposes: ['answer_to_attack_damage', 'armor'] }],
      spell_damage_or_magic_resistance: [{ item: 'pipe', name: '洞察烟斗', first_held: '29:08', matched_purposes: ['answer_to_spell_damage', 'magic_resistance'] }],
      disables_or_silences: [],
      initiation_or_gap_closer: [],
    });

    // Scoreboard match has no lane_role, so inferRoles assigns Beastmaster as 'support' (pos: null) -> pooled support (200 games).
    expect(build.most_built_in_this_bracket).toMatchObject({
      bracket: 'la',
      bracket_name: '传奇–万古',
      role: 'support',
      role_name: '辅助（4–5 号位）',
      public_games: 200,
      source: 'STRATZ',
    });
    expect(build.most_built_in_this_bracket.items.map((x: any) => x.item)).toEqual(['aghanims_shard', 'pipe', 'glimmer_cape']);
    expect(build.most_built_in_this_bracket.items[1]).toMatchObject({ item: 'pipe', player_first_held: '29:08', player_had_it_by_24_59: false });

    expect(pro.public_items_in_this_bracket).toMatchObject({
      bracket: 'la',
      bracket_name: '传奇–万古',
      role: 'support',
      public_games: 200,
      hero_win_rate: 0.55,
      source: 'STRATZ',
    });
    expect(pro.public_items_in_this_bracket.items[0]).toMatchObject({
      item: 'aghanims_shard',
      name: '阿哈利姆魔晶',
      player_first_held: null,
      share_of_public_games: 0.58,
      win_rate: 0.58,
      median_minute: 18,
    });
    expect(pro.public_items_in_this_bracket.items[0]).not.toHaveProperty('purchases');

    // verifyReview accepts sentences quoting public bracket game counts, shares, win rates and median minutes.
    const review = {
      verdict: '这局你出了洞察烟斗与强袭胸甲。',
      mainline: [],
      blind_spots: [],
      findings: [{
        title: '辅助位补微光披风自保',
        claim: '传奇–万古分段辅助兽王 200 场路人局里 38% 在 24:59 前做出微光披风，胜率 57%。',
        fix: 'f',
        evidence: [{
          refs: ['pro_items:beastmaster'],
          fact: '传奇–万古路人局 200 场辅助兽王里微光披风登场率 38%（中位 19 分钟），胜率 57%。',
        }],
        rule: { when: 'w', do: 'd', this_game: 'x' },
      }],
    };
    expect(verifyReview(review, [pro, build]).problems).toEqual([]);

    // goalFromReview allows an unheld bracket item (glimmer_cape / aghanims_shard) even when pro core builds omit it.
    const g = goalFromReview({ kind: 'hold_item', items: ['glimmer_cape'], finding: 1 }, { trace, hero: 'beastmaster', findings: 1, match: rankedMatch, bracketData: snap });
    expect(g).toMatchObject({ finding: 1, spec: { kind: 'hold_item', items: ['glimmer_cape'] } });
  });
});

describe('scripts/coach-bracket-items.mjs: introspection, week window & invariant checks', () => {
  const mockIntrospection = (useGroupByPos = true) => ({
    heroStats: {
      fields: [
        {
          name: 'itemFullPurchase',
          args: [
            { name: 'heroId', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'Short' } } },
            { name: 'week', type: { kind: 'SCALAR', name: 'Long' } },
            { name: 'bracketBasicIds', type: { kind: 'LIST', ofType: { kind: 'ENUM', name: 'RankBracketBasicEnum' } } },
            { name: 'positionIds', type: { kind: 'LIST', ofType: { kind: 'ENUM', name: 'MatchPlayerPositionType' } } },
            { name: 'minTime', type: { kind: 'SCALAR', name: 'Int' } },
            { name: 'maxTime', type: { kind: 'SCALAR', name: 'Int' } },
            { name: 'matchLimit', type: { kind: 'SCALAR', name: 'Int' } },
          ],
          type: {
            kind: 'LIST',
            ofType: {
              kind: 'OBJECT',
              name: 'HeroItemFullPurchaseType',
              fields: [{ name: 'itemId' }, { name: 'time' }, { name: 'week' }, { name: 'instance' }, { name: 'matchCount' }, { name: 'winCount' }],
            },
          },
        },
        {
          name: 'stats',
          args: [
            { name: 'week', type: { kind: 'SCALAR', name: 'Long' } },
            { name: 'bracketBasicIds', type: { kind: 'LIST', ofType: { kind: 'ENUM', name: 'RankBracketBasicEnum' } } },
            { name: 'positionIds', type: { kind: 'LIST', ofType: { kind: 'ENUM', name: 'MatchPlayerPositionType' } } },
            ...(useGroupByPos ? [{ name: 'groupByPosition', type: { kind: 'SCALAR', name: 'Boolean' } }] : []),
            { name: 'matchLimit', type: { kind: 'SCALAR', name: 'Int' } },
          ],
          type: {
            kind: 'LIST',
            ofType: {
              kind: 'OBJECT',
              name: 'HeroStatsType',
              fields: [{ name: 'heroId' }, { name: 'week' }, ...(useGroupByPos ? [{ name: 'position' }] : []), { name: 'matchCount' }, { name: 'winCount' }],
            },
          },
        },
      ],
    },
    posType: { enumValues: Object.values(POSITIONS).map((name) => ({ name })) },
    bracketType: { enumValues: Object.values(BRACKETS).map((name) => ({ name })) },
  });

  it('parses introspection, builds queries, selects single-patch completed weeks and detects time units', () => {
    const spec = parseIntrospection(mockIntrospection(true));
    expect(spec.item).toMatchObject({ heroArg: 'heroId', bracketArg: 'bracketBasicIds', hasMinTime: true, hasMaxTime: true, hasMatchLimit: true });
    expect(spec.denom).toMatchObject({ field: 'stats', groupByPosition: true });

    const denomQ = buildDenominatorQuery(spec, 1764201600, 1763596800);
    expect(denomQ.usesWeekVar).toBe(true);
    expect(denomQ.query).toContain('groupByPosition: true');

    const batchQ = buildItemBatchQuery(spec, [1, 38], { timeWindow: { minTime: 10, maxTime: 24 } });
    expect(batchQ).toContain('i_la_3_38: itemFullPurchase(heroId: 38, week: $w, bracketBasicIds: [LEGEND_ANCIENT], positionIds: [POSITION_3], minTime: 10, maxTime: 24, matchLimit: 0)');
    // Ungrouped C# `week: 0` on itemFullPurchase is never selected (nor misread as a wrong week echo).
    expect(batchQ).not.toMatch(/\{\s*itemId[^}]*\bweek\b/);

    // calibrateWarmup handles 1-based `instance: 1` and cumulative per-minute series.
    const itemMap = new Map([[145, 'bfury']]);
    const oneBased = calibrateWarmup([
      { itemId: 145, time: 14, instance: 1, matchCount: 30, winCount: 18 },
      { itemId: 145, time: 18, instance: 1, matchCount: 25, winCount: 14 },
      { itemId: 145, time: 22, instance: 2, matchCount: 2, winCount: 1 },
    ], 100, itemMap);
    expect(oneBased).toMatchObject({ firstInstance: 1, cumulative: false });
    const cumCal = calibrateWarmup(
      [10, 12, 14, 16, 18, 20].map((t, i) => ({ itemId: 145, time: t, instance: 0, matchCount: 20 + i * 10, winCount: 10 + i * 5 })),
      80,
      itemMap,
    );
    expect(cumCal).toMatchObject({ firstInstance: 0, cumulative: true });

    // Week split across 7.41 -> 7.42 is skipped; completed weeks inside 7.42 are kept.
    const w0 = Math.floor(Date.parse('2026-11-19T00:00:00Z') / 1000 / WEEK) * WEEK;
    const patches = [
      { name: '7.41', date: new Date((w0 - 3 * WEEK) * 1000).toISOString() },
      { name: '7.42', date: new Date((w0 - 2 * 86400) * 1000).toISOString() }, // landed Tuesday before w0 Thursday
    ];
    const sel = selectCompletedWeeks(patches, w0 + WEEK + 3600, 2);
    expect(sel).toEqual({ patch: '7.42', weeks: [w0] });

    expect(detectTimeUnit([{ time: 8 }, { time: 16 }, { time: 42 }]).unit).toBe('minutes');
    expect(detectTimeUnit([{ time: 480 }, { time: 960 }, { time: 1800 }]).unit).toBe('seconds');
    expect(medianMinuteFromBins(new Map([[12, 10], [16, 25], [21, 15]]), 50)).toBe(16);
  });

  it('aggregates exact medians across 1–5 + core + support, and rejects bad week echoes or skewed denominators', () => {
    const spec = parseIntrospection(mockIntrospection(false));
    const w = 2916 * WEEK;
    const known = new Set([1, 2]);
    // Bad week echo from STRATZ (unfinished current week 2917 instead of 2916) must throw.
    expect(() => extractWeekDenominators({ s_hg_1: [{ heroId: 1, week: 2917, matchCount: 100, winCount: 50 }] }, spec, w, known)).toThrow(/STRATZ answered for week 2917/);

    // Valid denominators across all 4 brackets summing to 50% win rate.
    const heroStats: any = {};
    for (const bKey of Object.keys(BRACKETS)) {
      for (const pKey of Object.keys(POSITIONS)) {
        heroStats[`s_${bKey}_${pKey}`] = [
          { heroId: 1, week: 2916, matchCount: 100, winCount: 52 },
          { heroId: 2, week: 2916, matchCount: 100, winCount: 48 },
        ];
      }
    }
    const wd = new Map([[w, extractWeekDenominators(heroStats, spec, w, known)]]);
    const itemKeyById = new Map([[1, 'blink'], [116, 'black_king_bar']]);
    const timeWindow = detectTimeUnit([{ time: 14 }, { time: 22 }]);

    const readHeroWeekItems = (h: number) => {
      const cell: any = {};
      for (const bKey of Object.keys(BRACKETS)) {
        for (const pKey of Object.keys(POSITIONS)) {
          cell[`${bKey}_${pKey}`] = h === 1 ? [
            { itemId: 1, time: 14, week: 0, instance: 0, matchCount: 30, winCount: 18 }, // week: 0 C# default tolerated
            { itemId: 1, time: 18, week: 0, instance: 0, matchCount: 30, winCount: 15 },
            { itemId: 1, time: 20, week: 0, instance: 1, matchCount: 10, winCount: 6 }, // second copy: ignored
          ] : [];
        }
      }
      return cell;
    };

    const agg = aggregateBracketItems({ weekDenominators: wd, readHeroWeekItems, heroes: [1, 2], weeks: [w], itemKeyById, timeWindow });
    expect(agg.heroes.la['1']['1']).toEqual({ games: 100, wins: 52, items: [['blink', 60, 33, 14]] });
    expect(agg.heroes.la['1'].core).toEqual({ games: 300, wins: 156, items: [['blink', 180, 99, 14]] });
    expect(agg.heroes.la['1'].support).toEqual({ games: 200, wins: 104, items: [['blink', 120, 66, 14]] });

    // Skewed win share (e.g. 80% wins) must fail closed before writing.
    const skewedStats = { ...heroStats, s_hg_1: [{ heroId: 1, week: 2916, matchCount: 1000, winCount: 900 }] };
    const badWd = new Map([[w, extractWeekDenominators(skewedStats, spec, w, known)]]);
    expect(() => aggregateBracketItems({ weekDenominators: badWd, readHeroWeekItems, heroes: [1, 2], weeks: [w], itemKeyById, timeWindow })).toThrow(/not ~50%/);

    // Cumulative mode: preserves latest pre-10:00 sample (e.g. minute 8 when minute 9 is absent) and rejects missing baselines.
    const rawCum = [
      { itemId: 1, time: 5, instance: 0, matchCount: 10, winCount: 5 },
      { itemId: 1, time: 8, instance: 0, matchCount: 30, winCount: 15 },
      { itemId: 1, time: 10, instance: 0, matchCount: 40, winCount: 20 },
      { itemId: 1, time: 24, instance: 0, matchCount: 70, winCount: 38 },
      { itemId: 1, time: 30, instance: 0, matchCount: 85, winCount: 45 },
    ];
    const cachedCum = filterRowsForCache(rawCum, { cumulative: true, firstInstance: 0, itemKeyById, timeWindow });
    expect(cachedCum.map((r: any) => r.time)).toEqual([8, 10, 24]);
    const readCum = (h: number) => Object.fromEntries(
      Object.keys(BRACKETS).flatMap((bKey) => Object.keys(POSITIONS).map((pKey) => [`${bKey}_${pKey}`, h === 1 ? cachedCum : []])),
    );
    const aggCum = aggregateBracketItems({ weekDenominators: wd, readHeroWeekItems: readCum, heroes: [1, 2], weeks: [w], itemKeyById, timeWindow, firstInstance: 0, cumulative: true });
    expect(aggCum.heroes.la['1']['1']).toEqual({ games: 100, wins: 52, items: [['blink', 40, 23, 24]] });

    const noBaseline = (h: number) => Object.fromEntries(
      Object.keys(BRACKETS).flatMap((bKey) => Object.keys(POSITIONS).map((pKey) => [`${bKey}_${pKey}`, h === 1 ? [{ itemId: 1, time: 10, instance: 0, matchCount: 40, winCount: 20 }] : []])),
    );
    expect(() => aggregateBracketItems({ weekDenominators: wd, readHeroWeekItems: noBaseline, heroes: [1, 2], weeks: [w], itemKeyById, timeWindow, firstInstance: 0, cumulative: true })).toThrow(/no pre-10:00 baseline/);

    // resolveRef resolves both pro_items and build with bracket items intact and strips internal gaps.
    const rankedMatch = { ...match, players: match.players.map((p: any) => ({ ...p, rank_tier: 55 })) };
    const proRec: any = resolveRef(trace, 'pro_items:beastmaster', { hero: 'beastmaster', lang: 'zh', match: rankedMatch, bracketData: makeSnapshot() });
    const buildRec: any = resolveRef(trace, 'build:beastmaster', { hero: 'beastmaster', lang: 'zh', match: rankedMatch, bracketData: makeSnapshot() });
    expect(proRec.record.public_items_in_this_bracket).toMatchObject({ bracket: 'la', role: 'support', public_games: 200, source: 'STRATZ' });
    expect(buildRec.record.most_built_in_this_bracket).toMatchObject({ bracket: 'la', role: 'support', public_games: 200, source: 'STRATZ' });
    expect(proRec.record).not.toHaveProperty('gaps');
    expect(buildRec.record).not.toHaveProperty('gaps');
  });
});
