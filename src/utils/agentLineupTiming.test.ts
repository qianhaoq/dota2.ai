import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { TIMING_GROUPS, TIMING_SOURCE, heroTiming, timingFromRows, timingGroupOf } from '../../lib/coach/heroTiming.js';
import { lineupTiming } from '../../lib/agent/knowledgeTools.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { reviewToolkit, verifyReview } from '../../lib/agent/deepReview.js';
import { STATIC_HEROES } from '../../packages/review-engine/src/staticHeroes.js';

const DATA = JSON.parse(readFileSync(new URL('../../lib/coach/data/hero-timing.json', import.meta.url), 'utf8'));
const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const idOf = (slug: string) => Object.values(STATIC_HEROES as Record<string, any>).find((h) => h.internalSlug === slug).id;
/** A match record that only says who played what, at which medal. */
const matchWith = (tier: (hero: string) => number | null) => ({ players: trace.heroes.map((h: any) => ({ hero_id: idOf(h.key), rank_tier: tier(h.key) })) });

describe('hero-timing snapshot', () => {
  it('names its source, credit, patch and a window of whole STRATZ weeks', () => {
    expect(TIMING_SOURCE.attribution).toEqual({ en: 'Data: STRATZ', url: 'https://stratz.com' });
    expect(TIMING_SOURCE.source).toMatch(/STRATZ/);
    expect(TIMING_SOURCE.patch).toMatch(/^\d+\.\d+/);
    expect(TIMING_SOURCE.cuts).toEqual([35, 45]);
    // STRATZ weeks run Thursday to Wednesday (week = floor(unix seconds / 604800)).
    const from = Date.parse(TIMING_SOURCE.weeks.from); const to = Date.parse(TIMING_SOURCE.weeks.to);
    expect(new Date(from).getUTCDay()).toBe(4);
    expect((to - from) / 86400000 + 1).toBe(7 * TIMING_SOURCE.weeks.count);
    expect(Date.parse(TIMING_SOURCE.fetched)).toBeGreaterThan(to);
  });

  it('holds three groups of [games, wins] per hero and bracket, and ten heroes per game', () => {
    expect(Object.keys(DATA.heroes)).toEqual(['hg', 'ca', 'la', 'di']);
    for (const b of Object.keys(DATA.heroes)) {
      const rows: [number, number][][] = Object.values(DATA.heroes[b]);
      expect(rows.length).toBeGreaterThan(100);
      let games = 0;
      for (const row of rows) {
        expect(row).toHaveLength(3);
        for (const [g, w] of row) { expect(Number.isInteger(g) && Number.isInteger(w) && w >= 0 && w <= g).toBe(true); games += g; }
      }
      expect(Math.abs(games / 10 - DATA.games[b])).toBeLessThanOrEqual(1);
      // Every game has a winner: over all heroes, half the hero-games are wins.
      const wins = rows.reduce((a, row) => a + row.reduce((x, [, w]) => x + w, 0), 0);
      expect(wins / games).toBeCloseTo(0.5, 2);
    }
  });
});

describe('a hero\'s win rate by game length', () => {
  it('reads the three groups and the hero\'s own win rate', () => {
    const medusa: any = heroTiming(idOf('medusa'), 'la');
    const [short, mid, long] = DATA.heroes.la[idOf('medusa')];
    expect(medusa.games).toBe(short[0] + mid[0] + long[0]);
    expect(medusa.by_length.under_35_min).toEqual({ games: short[0], win_rate: Math.round((short[1] / short[0]) * 1000) / 1000 });
    // Which way a hero leans is this week's STRATZ data (#419: a refresh moved Huskar): read here as the file's own
    // rows say, and the rule itself on rows made for it below.
    expect(medusa).toMatchObject({ wins_more_in: timingFromRows(DATA.heroes.la[idOf('medusa')])!.wins_more_in });
    expect(medusa.short_to_long).toBeCloseTo(medusa.by_length.over_45_min.win_rate - medusa.by_length.under_35_min.win_rate, 2);
    expect(timingFromRows([[2000, 1200], [2000, 1000], [2000, 800]])).toMatchObject({ wins_more_in: 'shorter_games' });
    expect(timingFromRows([[2000, 800], [2000, 1000], [2000, 1200]])).toMatchObject({ wins_more_in: 'longer_games' });
    expect(timingFromRows([[2000, 1000], [2000, 1000], [2000, 1010]])).toMatchObject({ wins_more_in: 'neither' });
    // No bracket: the four together.
    const all: any = heroTiming(idOf('medusa'));
    expect(all.games).toBe(['hg', 'ca', 'la', 'di'].reduce((a, b) => a + DATA.heroes[b][idOf('medusa')].reduce((x: number, [g]: number[]) => x + g, 0), 0));
    expect(heroTiming(99999, 'la')).toBeNull();
    expect(heroTiming(idOf('medusa'), 'xx')).toBeNull();
    // Only no bracket at all means "all of them": an empty one is not a bracket.
    expect(heroTiming(idOf('medusa'), '')).toBeNull();
  });

  it('makes no claim on noise, and none on too few games', () => {
    // 3 points apart and far beyond two standard errors: a lean. The same rates on few games: none.
    expect(timingFromRows([[20000, 10600], [20000, 10000], [20000, 9800]])).toMatchObject({ wins_more_in: 'shorter_games', short_to_long: -0.04 });
    expect(timingFromRows([[400, 212], [400, 200], [400, 196]])).toMatchObject({ wins_more_in: 'neither', short_to_long: -0.04 });
    // Two points apart is under the gap however many games there are.
    expect(timingFromRows([[900000, 459000], [900000, 450000], [900000, 441000]])).toMatchObject({ wins_more_in: 'neither' });
    // Under 300 games in a group: no win rate there, and no lean either way — unknown, not "neither".
    const thin: any = timingFromRows([[299, 200], [5000, 2500], [5000, 2400]]);
    expect(thin.by_length.under_35_min).toEqual({ games: 299, win_rate: null });
    expect(thin).toMatchObject({ wins_more_in: null, short_to_long: null });
    expect(timingFromRows([[0, 0], [0, 0], [0, 0]])).toBeNull();
    expect(timingFromRows(null)).toBeNull();
    expect(timingFromRows([[1, 1]])).toBeNull();
  });

  it('puts a game in its group by the snapshot\'s cuts', () => {
    expect([34 * 60 + 59, 35 * 60, 44 * 60 + 59, 45 * 60, 2551].map(timingGroupOf)).toEqual(['under_35_min', 'from_35_to_45_min', 'from_35_to_45_min', 'over_45_min', 'from_35_to_45_min']);
    expect([0, -5, NaN, null, undefined].map((x: any) => timingGroupOf(x))).toEqual([null, null, null, null, null]);
    expect(TIMING_GROUPS).toEqual(['under_35_min', 'from_35_to_45_min', 'over_45_min']);
  });
});

describe('lineup_timing', () => {
  it('sets the two sides next to each other from the player\'s side, in the player\'s bracket', () => {
    const r: any = lineupTiming(trace, {}, { perspective: 'beastmaster', lang: 'zh', match: matchWith((h) => (h === 'beastmaster' ? 54 : null)) });
    expect(r).toMatchObject({ ref: 'lineup_timing', bracket: 'la', bracket_name: '传奇–万古', bracket_from: 'the_players_medal', this_game: { length: '42:31', group: 'from_35_to_45_min' }, patch: TIMING_SOURCE.patch });
    expect(r.my_team.heroes.map((h: any) => h.hero)).toEqual(['sven', 'beastmaster', 'undying', 'skywrath_mage', 'dark_willow']);
    expect(r.enemy.heroes.map((h: any) => h.hero)).toEqual(['axe', 'phantom_assassin', 'necrolyte', 'venomancer', 'mirana']);
    const bm = r.my_team.heroes[1]; const own: any = heroTiming(idOf('beastmaster'), 'la');
    expect(bm).toEqual({ hero: 'beastmaster', games: own.games, win_rate: own.win_rate, win_rate_under_35_min: own.by_length.under_35_min.win_rate, win_rate_from_35_to_45_min: own.by_length.from_35_to_45_min.win_rate, win_rate_over_45_min: own.by_length.over_45_min.win_rate, change_from_short_to_long_games_in_points: Math.round(own.short_to_long * 1000) / 10, wins_more_in: own.wins_more_in });
    // Every hero is in exactly one of the four lists.
    for (const side of [r.my_team, r.enemy]) expect([...side.heroes_that_win_more_in_shorter_games, ...side.heroes_that_win_more_in_longer_games, ...side.heroes_with_no_clear_lean, ...side.heroes_not_known].sort()).toEqual(side.heroes.map((h: any) => h.hero).sort());
    // The mean is the five heroes' own rates, and the side comparison follows its stated rule.
    const mean = r.my_team.heroes.reduce((a: number, h: any) => a + h.win_rate_under_35_min, 0) / 5;
    expect(r.my_team.mean_win_rate_of_its_heroes.under_35_min).toBeCloseTo(mean, 3);
    const { my_team: mine, enemy: theirs } = r.mean_change_from_short_to_long_games_in_points;
    expect(mine).toBeCloseTo(r.my_team.heroes.reduce((a: number, h: any) => a + h.change_from_short_to_long_games_in_points, 0) / 5, 1);
    expect(r.longer_games_favour).toBe(Math.abs(mine - theirs) < 3 ? 'neither' : mine > theirs ? 'my_team' : 'enemy');
    expect(r.gaps.map((g: any) => g.topic)).toEqual(['line_up_synergy', 'patch']);
    expect(JSON.stringify(r)).not.toMatch(/"radiant"|"dire"/);
    // The same game read by the other side.
    const axe: any = lineupTiming(trace, {}, { perspective: 'axe', match: matchWith(() => 54) });
    expect(axe.my_team.heroes[0].hero).toBe('axe');
    expect(axe.mean_change_from_short_to_long_games_in_points).toEqual({ my_team: theirs, enemy: mine });
  });

  it('says where the bracket comes from, and uses all brackets when no medal is known', () => {
    // The player's medal is hidden: the middle of the three that are public.
    const mid: any = lineupTiming(trace, {}, { perspective: 'beastmaster', match: matchWith((h) => ({ sven: 72, axe: 75, mirana: 51 } as any)[h] ?? null) });
    expect(mid).toMatchObject({ bracket: 'di', bracket_from: 'the_medals_public_in_this_match', bracket_name: 'Divine–Immortal' });
    // Two public medals are too few, and no match data is no medal at all: all four brackets together, and a stated gap.
    const few: any = lineupTiming(trace, {}, { perspective: 'beastmaster', match: matchWith((h) => ({ sven: 72, axe: 75 } as any)[h] ?? null) });
    expect(few).toMatchObject({ bracket: 'all', bracket_from: 'no_medal_known', bracket_name: 'all brackets' });
    expect(few.gaps[0]).toEqual({ topic: 'rank_bracket', reason: 'too_few_public_medals_in_this_match' });
    const none: any = lineupTiming(trace, {}, {});
    expect(none.gaps[0]).toEqual({ topic: 'rank_bracket', reason: 'no_match_data_for_this_game' });
    expect(none.radiant.heroes[0]).toMatchObject({ hero: 'axe', games: (heroTiming(idOf('axe')) as any).games });
    expect(none).not.toHaveProperty('my_team');
    expect(['radiant', 'dire', 'neither']).toContain(none.longer_games_favour);
  });

  it('a hero the data does not have is not known, and its side has no mean', () => {
    const h = trace.heroes.findIndex((x: any) => x.key === 'sven');
    const odd = { ...trace, heroes: trace.heroes.map((x: any, i: number) => (i === h ? { ...x, key: 'sven_x', npc: 'npc_dota_hero_sven_x' } : x)) };
    const r: any = lineupTiming(odd, {}, { perspective: 'beastmaster' });
    expect(r.my_team.heroes[0]).toEqual({ hero: 'sven_x', games: null, wins_more_in: null });
    expect(r.my_team.heroes_not_known).toEqual(['sven_x']);
    expect(r.my_team.mean_win_rate_of_its_heroes).toEqual({ under_35_min: null, from_35_to_45_min: null, over_45_min: null });
    expect(r.mean_change_from_short_to_long_games_in_points.my_team).toBeNull();
    expect(r.longer_games_favour).toBeNull();
    expect(r.gaps.map((g: any) => g.topic)).toContain('hero_timing');
    // A replay that does not show the Ancient falling has no length to place.
    const cut = { ...trace, buildings: trace.buildings.filter((b: any) => !/_fort$/.test(trace.names[b[1]])) };
    expect((lineupTiming(cut, {}, {}) as any).this_game).toBeNull();
  });

  it('is a tool of the agent and a record a finding can cite', () => {
    const match = matchWith(() => 54);
    const kit: any = reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh', match: match as any });
    const record = kit.runTool('lineup_timing', {});
    expect(record).toMatchObject({ tool: 'lineup_timing', ref: 'lineup_timing', bracket: 'la' });
    const ev: any = resolveRef(trace, 'lineup_timing', { hero: 'beastmaster', lang: 'zh', match });
    expect(ev).toMatchObject({ ref: 'lineup_timing', kind: 'lineup_timing', names: { sven: '斯温', phantom_assassin: '幻影刺客' } });
    expect(ev.record).not.toHaveProperty('gaps');
    expect(resolveRef(trace, 'lineup_timing:x', { hero: 'beastmaster', match })).toBeNull();
    const sven = record.my_team.heroes[0];
    const pc = (v: number) => `${(v * 100).toFixed(1)}%`;
    const review = (fact: string) => ({ verdict: 'v', mainline: [], findings: [{ title: '阵容', claim: '你方的英雄在短局里赢得更多。', fix: 'x', evidence: [{ refs: ['lineup_timing'], fact }] }] });
    const problems = (fact: string) => verifyReview(review(fact), [record]).problems;
    expect(problems(`路人局里斯温在 35 分钟内结束的比赛胜率 ${pc(sven.win_rate_under_35_min)}，45 分钟以上 ${pc(sven.win_rate_over_45_min)}；这局打到 42:31。`)).toEqual([]);
    expect(problems('路人局里斯温在 35 分钟内结束的比赛胜率 71.3%。')).toEqual([expect.objectContaining({ kind: 'moment', text: expect.stringContaining('71.3%') })]);
  });
});
