import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { heroAbilities, KNOWLEDGE_TOOLS, laneReport, proItemChoices } from '../../lib/agent/knowledgeTools.js';
import { proItemsFor } from '../../lib/agent/proItems.js';
import { patchData } from '../../lib/agent/patchData.js';
import { goalFromReview } from '../../lib/agent/goal.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { verifyReview } from '../../lib/agent/deepReview.js';
import { evaluateGoal } from '../../lib/coach/goals.js';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { STATIC_HEROES } from '../../packages/review-engine/src/staticHeroes.js';
import { deepReviewProvider } from '../../lib/agent/providers.js';

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());

describe('knowledge tools', () => {
  it('hero_abilities: Valve\'s flags, in the reader\'s language, with the patch', () => {
    const r: any = heroAbilities(trace, { hero: 'Beastmaster' }, { lang: 'zh' });
    expect(r).toMatchObject({ ref: 'abilities:beastmaster', hero: 'beastmaster', patch: expect.any(String), source: expect.any(String) });
    expect(r.abilities.find((a: any) => a.ultimate)).toMatchObject({ ability: 'beastmaster_primal_roar', name: '原始咆哮', damage_type: 'magical', goes_through_spell_immunity: true, cooldown_by_level: [90, 75, 60] });
    // A flag Valve does not give is left out, not reported as false.
    expect(r.abilities.find((a: any) => a.ability === 'beastmaster_summon_raptor')).not.toHaveProperty('goes_through_spell_immunity');
    expect((heroAbilities(trace, { hero: 'beastmaster' }, {}) as any).abilities.at(-1).name).toBe('Primal Roar');
    expect(heroAbilities(trace, { hero: 'nobody' })).toEqual({ error: 'unknown_hero' });
  });

  it('pro_item_choices: what pros build, next to when the player held it', () => {
    const r: any = proItemChoices(trace, { hero: 'beastmaster' }, { lang: 'zh' });
    const item = (k: string) => r.mid_game_items.items.find((i: any) => i.item === k);
    // The game was played on 7.42: pro games of 7.42 only, and the patch before told apart.
    const sample = proItemsFor(38, patchData('7.42'))!;
    expect(r.mid_game_items).toMatchObject({ pro_games: sample.games, played_on_releases: ['7.42'] });
    expect(r.mid_game_items.items.map((i: any) => [i.item, i.share_of_pro_games])).toEqual(sample.items.slice(0, 5).map(([k, n]) => [k, Math.round((n / sample.games) * 100) / 100]));
    if (sample.few_games) expect(r.mid_game_items_in_the_patch_before.played_on_releases.at(-1)).toBe('7.41f');
    else expect(r).not.toHaveProperty('mid_game_items_in_the_patch_before');
    expect(item('blink')).toMatchObject({ name: '闪烁匕首', player_first_held: null });
    expect(item('ultimate_scepter').player_first_held).toBe('16:48');
    // Only this match's enemies, each with its sample size.
    const enemies = new Set(trace.heroes.filter((h: any) => h.team === 2).map((h: any) => h.key));
    expect(r.built_more_against_these_enemies.length).toBeGreaterThan(0);
    for (const x of r.built_more_against_these_enemies) { expect(enemies.has(x.enemy)).toBe(true); expect(x.pro_games).toBeGreaterThanOrEqual(30); expect(x.share_of_pro_games_against_this_enemy).toBeGreaterThan(x.share_usually); }
    expect(r.built_more_against_these_enemies.find((x: any) => x.item === 'pipe')).toMatchObject({ player_first_held: '29:08' });
    expect(r.note).toContain('not this player\'s rank');
    expect(r.gaps.map((g: any) => g.topic)).toContain('rank_bracket_items');
    expect(proItemChoices(trace, { hero: 'pudge' })).toMatchObject({ error: 'unknown_hero' });
  });

  it('registers both with a required hero', () => {
    expect(KNOWLEDGE_TOOLS.map((t) => [t.name, t.input_schema.required])).toEqual([['hero_abilities', ['hero']], ['pro_item_choices', ['hero']], ['lane_report', ['hero']], ['lineup_timing', undefined], ['window_report', ['hero']], ['build_for_plan', ['hero']], ['farm_report', ['hero']], ['build_check', ['hero']], ['power_spikes', ['hero']], ['fight_report', ['hero']], ['game_state', ['hero', 'at']], ['siege_report', ['hero']], ['roshan_report', ['hero']], ['decision_points', ['hero']]]);
  });
});

describe('deepReviewProvider', () => {
  it('DeepSeek 4.1 Flash with thinking on by default', () => {
    expect(deepReviewProvider('deepseek', { DEEPSEEK_API_KEY: 'k' })).toEqual({ ok: true, provider: 'deepseek', baseURL: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-flash', thinking: 'enabled', extraBody: { thinking: { type: 'enabled' } } });
    // The server's own switch does not turn the review's thinking off; its own does.
    expect(deepReviewProvider('deepseek', { DEEPSEEK_API_KEY: 'k', DEEPSEEK_THINKING: 'disabled' })).toMatchObject({ thinking: 'enabled' });
    expect(deepReviewProvider('deepseek', { DEEPSEEK_API_KEY: 'k', DEEP_REVIEW_THINKING: 'disabled' })).toMatchObject({ thinking: 'disabled', extraBody: { thinking: { type: 'disabled' } } });
  });
  it('GLM 5.3 Flash on Zhipu\'s endpoint', () => {
    expect(deepReviewProvider('glm', { GLM_API_KEY: 'g' })).toMatchObject({ ok: true, provider: 'glm', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3-flash', thinking: 'enabled' });
    expect(deepReviewProvider('glm', { GLM_API_KEY: 'g', GLM_MODEL: 'glm-5.3' })).toMatchObject({ model: 'glm-5.3' });
    expect(deepReviewProvider('glm', { GLM_API_KEY: 'g', GLM_MODEL: 'not a model name' })).toMatchObject({ model: 'glm-5.3-flash' });
  });
  it('says which key is missing, and rejects unknown providers', () => {
    expect(deepReviewProvider('deepseek', {})).toEqual({ ok: false, error: 'missing_key', needs: 'DEEPSEEK_API_KEY' });
    expect(deepReviewProvider('glm', {})).toEqual({ ok: false, error: 'missing_key', needs: 'GLM_API_KEY' });
    expect(deepReviewProvider('other', {})).toEqual({ ok: false, error: 'unknown_provider' });
  });
});

describe('lane_report', () => {
  // Match 9091400302 as OpenDota parsed it, and the part of its replay trace the tool reads: the roster and
  // the player's deaths (4:21 to Hoodwink, 6:07 and 8:12 to Ursa before 10:00; 18:31 after it).
  const match = JSON.parse(readFileSync(new URL('../fixtures/coach/match9091400302.parsed.json', import.meta.url), 'utf8'));
  const heroes = match.players.map((p: any, i: number) => { const key = (STATIC_HEROES as any)[p.hero_id].internalSlug; return { key, npc: `npc_dota_hero_${key}`, team: i < 5 ? 2 : 3, player_index: i }; });
  const names = heroes.map((h: any) => h.npc);
  const id = (key: string) => heroes.findIndex((h: any) => h.key === key);
  const lane9091 = { heroes, names, deaths: [[261, id('tidehunter'), id('hoodwink'), 1], [367, id('tidehunter'), id('ursa'), 2], [492, id('tidehunter'), id('ursa'), 3], [1111, id('tidehunter'), id('ursa'), 4], [300, id('ursa'), id('tidehunter'), 5]] };

  it('the lane at 10:00 from the match data, the early deaths from the replay, the matchup from the snapshots', () => {
    const r: any = laneReport(lane9091, { hero: 'Tidehunter' }, { match });
    expect(r).toMatchObject({
      ref: 'lane:tidehunter', hero: 'tidehunter', lane: 'top', measured_at: ['5:00', '10:00'],
      my_deaths_before_10_00_total: 3,
      my_deaths_before_10_00: [{ clock: '4:21', killer: 'hoodwink' }, { clock: '6:07', killer: 'ursa' }, { clock: '8:12', killer: 'ursa' }],
      lane_gold_at_10_00: { my_team: 4715, enemy: 5439 }, lane_result: 'lost', my_role: 'core',
      first_tower_fell: { my_team: '16:14', enemy: '20:08' },
    });
    expect(r).toMatchObject({
      heroes_in_lane: { tidehunter: 'me', shadow_shaman: 'ally', ursa: 'enemy', hoodwink: 'enemy' },
      last_hits_at_5_00: { tidehunter: 15, shadow_shaman: 3, ursa: 24, hoodwink: 4 },
      last_hits_at_10_00: { tidehunter: 41, shadow_shaman: 3, ursa: 37, hoodwink: 6 },
      denies_at_10_00: { tidehunter: 5, shadow_shaman: 1, ursa: 2, hoodwink: 4 },
      gold_at_10_00: { tidehunter: 2986, shadow_shaman: 1729, ursa: 3663, hoodwink: 1776 },
      xp_at_10_00: { tidehunter: 2850, shadow_shaman: 2274, ursa: 3279, hoodwink: 2343 },
    });
    // The same numbers the coach report's laning chapter holds: one source, not a second computation.
    const chapter = buildCoachReport(match).reviews[0].chapters.laning;
    expect(r.same_cores_in_pro_games).toEqual({
      my_side_core: 'tidehunter', enemy_core: 'ursa', pro_games: chapter.baseline.n,
      core_gold_difference_at_10_00: { mean: chapter.baseline.mean, quarter_of_games_below: chapter.baseline.p25, quarter_of_games_above: chapter.baseline.p75, this_game: -677 },
      share_of_pro_games_my_side_core_was_ahead: Math.round(chapter.baseline.ahead * 100) / 100, matchup: 'unfavoured', this_game_against_that_range: 'typical',
    });
    expect(r.same_lane_in_public_games_of_this_bracket).toMatchObject({ hero: 'tidehunter', against: 'ursa', lanes: chapter.rank_lane.n, share_lost: Math.round(chapter.rank_lane.lost * 100) / 100, source: 'STRATZ' });
    // Nothing that identifies a person: no names, no account ids.
    const text = JSON.stringify(r);
    for (const p of match.players) { if (p.personaname) expect(text).not.toContain(p.personaname); if (p.account_id) expect(text).not.toContain(String(p.account_id)); }
  });

  it('without per-minute match data it gives the deaths and says what is missing, never a guess', () => {
    const unparsed = JSON.parse(readFileSync(new URL('../fixtures/coach/match9091400302.unparsed.json', import.meta.url), 'utf8'));
    for (const [m, reason] of [[null, 'no_match_data_for_this_game'], [unparsed, 'match_not_parsed_for_per_minute_gold'], [{ players: [] }, 'match_data_incomplete']] as const) {
      const r: any = laneReport(lane9091, { hero: 'tidehunter' }, { match: m });
      expect(r).toMatchObject({ ref: 'lane:tidehunter', lane: null, my_deaths_before_10_00_total: 3 });
      expect(r.gaps[0]).toEqual({ topic: 'lane_economy', reason });
      expect(r).not.toHaveProperty('lane_result');
      expect(r).not.toHaveProperty('heroes_in_lane');
      expect(r).not.toHaveProperty('last_hits_at_10_00');
    }
    expect(laneReport(lane9091, { hero: 'pudge_x' }, { match })).toMatchObject({ error: 'unknown_hero' });
  });

  it('is a record a finding can cite: its ref resolves, and its numbers back a sentence', () => {
    const ev: any = resolveRef(lane9091, 'lane:tidehunter', { hero: 'tidehunter', lang: 'zh', match });
    expect(ev).toMatchObject({ ref: 'lane:tidehunter', kind: 'lane', record: { lane_result: 'lost' }, names: { tidehunter: '潮汐猎人', ursa: '熊战士', hoodwink: '森海飞霞' } });
    expect(resolveRef(lane9091, 'lane:tidehunter:x', { hero: 'tidehunter', match })).toBeNull();
    const record = laneReport(lane9091, { hero: 'tidehunter' }, { match });
    const review = (fact: string) => ({ verdict: 'v', mainline: [], findings: [{ title: '对线', claim: '对线期落后。', fix: 'x', evidence: [{ refs: ['lane:tidehunter'], fact }] }] });
    const problems = (fact: string) => verifyReview(review(fact), [record]).problems.filter((p: any) => p.where === 'finding');
    expect(problems('10 分钟时你 41 个补刀、2986 金钱，熊战士 37 个补刀、3663 金钱；10 分钟前你阵亡 3 次：4:21、6:07、8:12。')).toEqual([]);
    expect(problems('10 分钟时你只有 28 个补刀。')).not.toEqual([]);
    // In the claim itself, where a count ("41 个") must be one a tool states: the per-hero maps are such counts.
    const claimed = (claim: string) => verifyReview({ verdict: 'v', mainline: [], findings: [{ title: '对线', claim, fix: 'x', evidence: [{ refs: ['lane:tidehunter'], fact: '上路对线。' }] }] }, [record]).problems.filter((p: any) => p.where === 'finding');
    expect(claimed('10 分钟时你 41 个补刀，熊战士 37 个补刀；10 分钟前你阵亡 3 次。')).toEqual([]);
    expect(claimed('10 分钟时你只有 28 个补刀。')).not.toEqual([]);
    // The two checkpoints are game times the record states, in evidence and in a claim alike.
    expect(problems('At 5:00 you had 15 last hits, at 10:00 41.')).toEqual([]);
    expect(claimed('5:00 时你 15 个补刀，10:00 时 41 个。')).toEqual([]);
    expect(problems('At 7:30 you had 15 last hits.')).not.toEqual([]);
  });

  it('win_lane is a goal only for a lane the report calls lost, and is the engine\'s own lane check', () => {
    const pick = { kind: 'win_lane', finding: 1 };
    const g = goalFromReview(pick, { trace: lane9091, hero: 'tidehunter', findings: 1, match });
    expect(g).toEqual({ finding: 1, spec: { kind: 'lane_not_lost', role_kind: 'core', label: { en: 'Your lane is not behind at 10:00', zh: '10 分钟时你这条线不落后' } } });
    // Judged by the same code as every laning goal: this very game misses it.
    expect(evaluateGoal(g!.spec, buildCoachReport(match), 0)).toMatchObject({ result: 'missed' });
    // No match data, or the enemy core (whose lane was won): no goal.
    expect(goalFromReview(pick, { trace: lane9091, hero: 'tidehunter', findings: 1 })).toBeNull();
    expect(goalFromReview(pick, { trace: lane9091, hero: 'ursa', findings: 1, match })).toBeNull();
  });
});
