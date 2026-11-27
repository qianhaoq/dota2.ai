import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildCheck, goldOnTop, powerSpikes, SITUATION_TOOLS } from '../../lib/agent/situationTools.js';
import { KNOWLEDGE_TOOLS } from '../../lib/agent/knowledgeTools.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { DEEP_REVIEW_PROMPT_VERSION, SUBMIT_REVIEW, approachClaims, collectFacts, deepReviewSystem, planOf, reviewToolkit, verifyReview, wordingProblems } from '../../lib/agent/deepReview.js';
import { HABITS, evaluateHabit, habitGoal } from '../../lib/coach/goals.js';
import { ANSWERS, GAP_CLOSERS } from '../../lib/coach/knowledge.js';
import { MIN_FEW_GAMES, proItemsFor } from '../../lib/agent/proItems.js';
import { patchData } from '../../lib/agent/patchData.js';
import { deathContext, itemTimeline } from '../../packages/review-engine/src/trace/index.js';

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const match = JSON.parse(readFileSync(new URL('../fixtures/agent/match9100904020.scoreboard.json', import.meta.url), 'utf8'));
const items = JSON.parse(readFileSync(new URL('../../lib/data/constants/items.json', import.meta.url), 'utf8'));

describe('build_check: the build against what killed the player', () => {
  const r: any = buildCheck(trace, { hero: 'Beastmaster' }, { lang: 'zh', match });

  it('where the damage in the deaths came from is the death tool\'s own shares, regrouped by enemy', () => {
    const d: any = deathContext(trace, { hero: 'beastmaster', all_damage_sources: true });
    expect(r).toMatchObject({ ref: 'build:beastmaster', hero: 'beastmaster', deaths_total: d.deaths_total });
    // Over every source of damage in the death windows, not the six largest the death tool shows a reader:
    // Phantom Assassin's attacks are 0.44 of it, and the other enemies' attacks bring the heroes' share to 0.48.
    expect(Object.keys((deathContext(trace, { hero: 'beastmaster' }) as any).damage_share_in_death_windows)).toHaveLength(6);
    expect(Object.keys(d.damage_share_in_death_windows).length).toBeGreaterThan(6);
    expect(r.damage_in_my_deaths.share_from_enemy_attacks).toBe(0.48);
    expect(r.damage_in_my_deaths.share_from_enemy_abilities_and_items).toBe(0.49);
    const heroAttacks = trace.heroes.filter((h: any) => h.team !== trace.heroes.find((x: any) => x.key === 'beastmaster').team).reduce((a: number, h: any) => a + (d.damage_in_death_windows[`${h.key}: attacks`] ?? 0), 0);
    expect(r.damage_in_my_deaths.share_from_enemy_attacks).toBe(Math.round((heroAttacks / d.damage_in_death_windows_total) * 100) / 100);
    // A creep's or a ward's attacks are in the total and in neither sum.
    expect(Object.keys(d.damage_in_death_windows).some((k) => k.startsWith('creep_'))).toBe(true);
    expect(r.damage_in_my_deaths.by_enemy.find((e: any) => e.enemy === 'venomancer').share_from_their_attacks).toBe(d.damage_share_in_death_windows['venomancer: attacks']);
    expect(r.damage_in_my_deaths.by_enemy[0]).toMatchObject({ enemy: 'phantom_assassin', kills_of_me: d.killed_by.phantom_assassin, share_from_their_attacks: d.damage_share_in_death_windows['phantom_assassin: attacks'], share_from_their_abilities_and_items: d.damage_share_in_death_windows['phantom_assassin: abilities and items'], known_for: ['physical', 'evasion'] });
    // An enemy who neither killed the player nor damaged them in a death is not listed; one with no curated trait has no "known_for".
    for (const e of r.damage_in_my_deaths.by_enemy) expect(e.kills_of_me + e.share_from_their_attacks + e.share_from_their_abilities_and_items).toBeGreaterThan(0);
    expect(r.damage_in_my_deaths.by_enemy.find((e: any) => e.enemy === 'venomancer')).not.toHaveProperty('known_for');
  });

  it('each big item says what it is for from the data, and an item the data does not classify says nothing', () => {
    const by = Object.fromEntries(r.my_big_items_in_order.map((i: any) => [i.item, i]));
    expect(r.my_big_items_in_order.map((i: any) => i.first_held)).toEqual(['16:48', '29:08', '38:58']);
    // Pipe: curated as an answer to spell damage, and Valve lists magic resistance on it.
    expect(by.pipe).toMatchObject({ name: '洞察烟斗', cost: items.pipe.cost, built_for: ['answer_to_spell_damage', 'magic_resistance'] });
    expect(by.pipe.does[0]).toMatchObject({ title: 'Barrier', valve_text: items.pipe.abilities[0].description.replace(/\s+/g, ' ') });
    expect(by.assault.built_for).toEqual(['answer_to_attack_damage', 'armor']);
    // Aghanim's Scepter is in no list: no purpose is made up for it, and it is not called an offensive item.
    expect(by.ultimate_scepter.built_for).toEqual([]);
    expect(r.gold_in_big_items_by_purpose.not_classified).toEqual({ gold: items.ultimate_scepter.cost, items: ['阿哈利姆神杖'], first_at: '16:48' });
    expect(r.gold_in_big_items_by_purpose.answer_to_spell_damage).toEqual({ gold: items.pipe.cost, items: ['洞察烟斗'], first_at: '29:08' });
    expect(r.note).toContain('not "offensive"');
    // An item built from a big item already held is charged only for the rest: Skull Basher into Abyssal Blade.
    const pa: any = buildCheck(trace, { hero: 'phantom_assassin' }, { lang: 'en' });
    const basher = pa.my_big_items_in_order.find((i: any) => i.item === 'basher'); const abyssal = pa.my_big_items_in_order.find((i: any) => i.item === 'abyssal_blade');
    expect(basher).not.toHaveProperty('gold_on_top_of_items_already_held');
    expect(abyssal).toMatchObject({ cost: items.abyssal_blade.cost, gold_on_top_of_items_already_held: items.abyssal_blade.cost - items.basher.cost });
    // A chain: the three add up to the last one's price, with nothing charged twice and nothing left out.
    const chain = goldOnTop(['kaya', 'meteor_hammer', 'starforge']);
    expect(chain).toEqual([null, items.meteor_hammer.cost - items.kaya.cost, items.starforge.cost - items.meteor_hammer.cost]);
    expect(items.kaya.cost + chain[1]! + chain[2]!).toBe(items.starforge.cost);
    // Two separate parts both count; an unrelated item, or the part bought after, does not.
    expect(goldOnTop(['heavens_halberd', 'sange', 'skypiercer'])).toEqual([null, null, items.skypiercer.cost - items.heavens_halberd.cost - items.sange.cost]);
    expect(goldOnTop(['arcane_blink', 'blink', 'black_king_bar'])).toEqual([null, null, null]);
    // A part that went into one item is not there for the next: Soul Booster into Bloodstone, then an Octarine Core in full.
    const shared = goldOnTop(['soul_booster', 'bloodstone', 'octarine_core']);
    expect(shared).toEqual([null, items.bloodstone.cost - items.soul_booster.cost, null]);
    expect(items.soul_booster.cost + shared[1]! + items.octarine_core.cost).toBe(items.bloodstone.cost + items.octarine_core.cost);
    const spent = Object.values(pa.gold_in_big_items_by_purpose as Record<string, { gold: number; items: string[] }>).filter((v) => v.items.includes('Abyssal Blade') && v.items.includes('Skull Basher'));
    for (const v of spent) expect(v.gold).toBeLessThan(pa.my_big_items_in_order.filter((i: any) => v.items.includes(i.name)).reduce((a: number, i: any) => a + i.cost, 0));
  });

  it('the answers are the curated lists for this role, with what each does and whether the player held it', () => {
    expect(r.my_role).toBe('support');
    const attack = r.items_that_answer_attack_damage.map((x: any) => x.item);
    expect(attack).toEqual(ANSWERS.physical.support);
    const halberd = r.items_that_answer_attack_damage.find((x: any) => x.item === 'heavens_halberd');
    expect(halberd).toMatchObject({ name: '天堂之戟', cost: items.heavens_halberd.cost, player_first_held: null, does: [{ kind: 'active', title: 'Disarm', valve_text: 'Prevents a target from attacking for 3 seconds.' }] });
    // The drawback is in Valve's own text, for the model to read: Ghost Scepter and magic damage.
    expect(r.items_that_answer_attack_damage.find((x: any) => x.item === 'ghost').does[0].valve_text).toContain('more vulnerable to magic damage');
    expect(r.items_that_answer_spell_damage.find((x: any) => x.item === 'pipe').player_first_held).toBe('29:08');
    // Without the match data the role is not known: both roles' answers are offered, and the gap says why.
    const bare: any = buildCheck(trace, { hero: 'beastmaster' }, { lang: 'en' });
    expect(bare).not.toHaveProperty('my_role');
    expect(bare.gaps[0]).toEqual({ topic: 'role', reason: 'no_match_data_for_this_game' });
    expect(bare.items_that_answer_attack_damage.map((x: any) => x.item)).toEqual([...new Set([...ANSWERS.physical.core, ...ANSWERS.physical.support])]);
    expect(bare.my_big_items_in_order[1].name).toBe('Pipe of Insight');
  });

  it('the hero\'s most-built professional items stand next to when the player had them, and the gap closers next to each other', () => {
    const core = r.most_built_by_pros_on_this_hero;
    expect(core.window).toBe('finished between 10:00 and 24:59');
    // The fixture game was played on 7.42, days after it came out: the pro games are 7.42's own, few, and said to be.
    const sample = proItemsFor(38, patchData('7.42'))!;
    expect(sample.games).toBeGreaterThanOrEqual(MIN_FEW_GAMES);
    expect(core).toMatchObject({ pro_games: sample.games, played_on_releases: ['7.42'] });
    expect(Boolean(core.few_games)).toBe(Boolean(sample.few_games));
    expect(core).not.toHaveProperty('from_the_patch_before_this_game');
    expect(core.items.map((i: any) => i.item)).toEqual(sample.items.map(([k]) => k).slice(0, 3));
    expect(core.items.find((i: any) => i.item === 'blink')).toMatchObject({ name: '闪烁匕首', player_first_held: null, built_for: ['initiation_or_gap_closer'] });
    expect(core.items.find((i: any) => i.item === 'blink')).not.toHaveProperty('player_had_it_by_24_59');
    expect(core.items.find((i: any) => i.item === 'ultimate_scepter')).toMatchObject({ player_first_held: '16:48', player_had_it_by_24_59: true });
    if (sample.few_games) expect(r.gaps.find((g: any) => g.topic === 'pro_mid_game_items').reason).toContain(`only_${sample.games}_pro_games`);
    // The player never held a gap closer; one enemy did.
    expect(r.gap_closers.mine).toBeNull();
    const first = (itemTimeline(trace, { hero: 'axe' }) as any).items.find((i: any) => GAP_CLOSERS.includes(i.item));
    expect(r.gap_closers.enemies).toEqual([{ enemy: 'axe', item: first.item, name: '闪烁匕首', first_held: first.first_held.clock }]);
    expect(buildCheck(trace, { hero: 'pudge' })).toMatchObject({ error: 'unknown_hero' });
  });
});

describe('power_spikes: when each side became strong', () => {
  const r: any = powerSpikes(trace, { hero: 'beastmaster' }, { lang: 'zh', match });

  it('levels come from the per-second samples, and the big items from the item timeline', () => {
    expect(r).toMatchObject({ ref: 'spikes:beastmaster', hero: 'beastmaster' });
    expect(r.me.reached).toEqual({ level_6: '7:28', level_12: '18:39', level_18: '30:27' });
    expect(r.me.ultimate).toEqual({ ability: 'beastmaster_primal_roar', name: '原始咆哮', cooldown_by_level: [90, 75, 60] });
    expect(r.me.big_items.map((i: any) => [i.item, i.first_held])).toEqual([['ultimate_scepter', '16:48'], ['pipe', '29:08'], ['assault', '38:58']]);
    const pa = r.enemies[0];
    expect(pa).toMatchObject({ enemy: 'phantom_assassin', kills_of_me_total: 7, reached: { level_6: '6:14', level_12: '17:18', level_18: '25:31' } });
    expect(r.level_at.map((x: any) => x.at)).toEqual(['10:00', '20:00', '30:00']);
    expect(r.level_at[1]).toMatchObject({ at: '20:00', me: 12, phantom_assassin: 14 });
    // The items here have no ref of their own: what stands beside them (kill counts, cost) is this record's.
    expect(JSON.stringify(r)).not.toContain('"ref":"item:');
    expect(JSON.stringify(buildCheck(trace, { hero: 'beastmaster' }, { lang: 'zh', match }))).not.toContain('"ref":"item:');
  });

  it('an enemy\'s kills of the player are counted before and after each of that enemy\'s items, and add up', () => {
    const pa = r.enemies[0];
    const bf = pa.big_items.find((i: any) => i.item === 'bfury');
    expect(bf).toMatchObject({ name: '狂战斧', first_held: '15:47', kills_of_me_before: 2, kills_of_me_from_then_on: 5 });
    for (const i of pa.big_items) expect(i.kills_of_me_before + i.kills_of_me_from_then_on).toBe(pa.kills_of_me_total);
    // The same counts at the top of the record, where a sentence's count is looked for.
    expect(r.kills_of_me).toMatchObject({ phantom_assassin: 7 });
    expect(r.kills_of_me).not.toHaveProperty('axe');
    expect(r.kills_of_me_before_their_item['phantom_assassin: bfury']).toBe(2);
    expect(r.kills_of_me_from_their_item_on['phantom_assassin: bfury']).toBe(5);
    expect(Object.keys(r.kills_of_me_before_their_item).some((k) => k.startsWith('axe: '))).toBe(false);
    // An enemy who never killed the player has items and levels, and no kill counts to read anything into.
    const axe = r.enemies.find((e: any) => e.enemy === 'axe');
    expect(axe.kills_of_me_total).toBe(0);
    expect(axe.big_items.find((i: any) => i.item === 'blink')).toMatchObject({ gap_closer: true });
    expect(axe.big_items[0]).not.toHaveProperty('kills_of_me_before');
    // Most kills first.
    expect(r.enemies.map((e: any) => e.kills_of_me_total)).toEqual([...r.enemies.map((e: any) => e.kills_of_me_total)].sort((a, b) => b - a));
  });

  it('a matchup is quoted with its sample, only where the data has one; an unknown bracket is a gap, not a guess', () => {
    for (const e of r.enemies) {
      const m = e.my_hero_against_them_in_pro_games;
      if (m) { expect(m.games).toBeGreaterThan(0); expect(['favoured', 'unfavoured', 'even']).toContain(m.matchup); expect(m.win_rate).toBeGreaterThan(0); }
      expect(e).not.toHaveProperty('my_hero_against_them_in_public_games');
    }
    expect(r).not.toHaveProperty('public_source');
    expect(r.gaps[0]).toEqual({ topic: 'public_matchups', reason: 'bracket_unknown_for_this_game' });
    expect((powerSpikes(trace, { hero: 'beastmaster' }, {}) as any).gaps[0]).toEqual({ topic: 'public_matchups', reason: 'no_match_data_for_this_game' });
    // With the players' medals known, the public matchup of the bracket is there with its games.
    const ranked = { ...match, players: match.players.map((p: any) => ({ ...p, rank_tier: 55 })) };
    const withRank: any = powerSpikes(trace, { hero: 'beastmaster' }, { lang: 'en', match: ranked });
    expect(withRank.public_source).toMatchObject({ bracket: 'la', source: 'STRATZ' });
    const known = withRank.enemies.filter((e: any) => e.my_hero_against_them_in_public_games);
    expect(known.length).toBeGreaterThan(0);
    for (const e of known) expect(e.my_hero_against_them_in_public_games).toMatchObject({ bracket: 'la', games: expect.any(Number), matchup: expect.stringMatching(/^(favoured|unfavoured|even)$/) });
    expect(powerSpikes(trace, { hero: 'pudge' })).toMatchObject({ error: 'unknown_hero' });
  });
});

describe('the review agent has both tools, and their records can be cited and shown', () => {
  it('registered with a required hero, offered to the model, and named in the method', () => {
    expect(SITUATION_TOOLS.map((t) => [t.name, t.input_schema.required])).toEqual([['build_check', ['hero']], ['power_spikes', ['hero']]]);
    expect(KNOWLEDGE_TOOLS.map((t) => t.name).slice(-16, -6)).toEqual(['build_check', 'power_spikes', 'fight_report', 'game_state', 'siege_report', 'roshan_report', 'key_moments', 'ward_report', 'save_report', 'decision_points']);
    const kit: any = reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh', match });
    expect(kit.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['build_check', 'power_spikes']));
    expect(kit.runTool('build_check', { hero: 'beastmaster' })).toMatchObject({ tool: 'build_check', ref: 'build:beastmaster' });
    expect(kit.runTool('power_spikes', { hero: 'beastmaster' })).toMatchObject({ tool: 'power_spikes', ref: 'spikes:beastmaster' });
    const system = deepReviewSystem('zh');
    for (const word of ['build_check', 'power_spikes', 'Read choices, not minds', 'most_built_by_pros_on_this_hero']) expect(system).toContain(word);
    expect(DEEP_REVIEW_PROMPT_VERSION).toBeGreaterThanOrEqual(18);
  });

  it('a sentence may state what the records hold, citing them; the evidence route resolves them with display names', () => {
    const build = buildCheck(trace, { hero: 'beastmaster' }, { lang: 'zh', match });
    const spikes = powerSpikes(trace, { hero: 'beastmaster' }, { lang: 'zh', match });
    const facts = collectFacts([build, spikes]);
    expect([...facts.refs.keys()]).toEqual(expect.arrayContaining(['build:beastmaster', 'spikes:beastmaster']));
    const review = { verdict: 'v', mainline: [], blind_spots: [], findings: [{
      title: '烟斗 29:08 才出', claim: '你阵亡前的伤害里 48% 是普攻。', fix: 'f',
      evidence: [{ refs: ['build:beastmaster'], fact: '洞察烟斗 29:08 才拿到，花了 3725 金币；阵亡伤害里 48% 来自敌方英雄的普攻。' }, { refs: ['spikes:beastmaster'], fact: '幻影刺客 15:47 做出狂战斧，之后杀了你 5 次，之前 2 次。' }],
      rule: { when: 'w', do: 'd', this_game: '幻影刺客杀了你 7 次。' },
    }] };
    expect(verifyReview(review, [build, spikes]).problems).toEqual([]);
    // A level at one of the marks is a fact of the strengths record; the kill counts are not facts of the item's own record.
    const marks = { ...review, findings: [{ ...review.findings[0], evidence: [{ refs: ['spikes:beastmaster'], fact: '20:00 时你 12 级，幻影刺客 14 级。' }] }] };
    expect(verifyReview(marks, [build, spikes]).problems).toEqual([]);
    expect(collectFacts([build, spikes]).refs.has('item:phantom_assassin:bfury')).toBe(false);
    // A number neither record holds is still caught.
    const wrong = { ...review, findings: [{ ...review.findings[0], evidence: [{ refs: ['build:beastmaster'], fact: '洞察烟斗 21:08 才拿到。' }] }] };
    expect(verifyReview(wrong, [build, spikes]).problems).toEqual([expect.objectContaining({ kind: 'moment' })]);
    for (const ref of ['build:beastmaster', 'spikes:beastmaster']) {
      const out: any = resolveRef(trace, ref, { hero: 'beastmaster', lang: 'zh', match });
      expect(out).toMatchObject({ ref, kind: ref.split(':')[0], names: { phantom_assassin: '幻影刺客' } });
      expect(out.record).not.toHaveProperty('gaps');
    }
    expect(resolveRef(trace, 'build:pudge', { hero: 'beastmaster' })).toBeNull();
    expect(resolveRef(trace, 'spikes:beastmaster:1', { hero: 'beastmaster' })).toBeNull();
  });
});

describe('game_plan.strengths', () => {
  it('is part of the schema, checked like the plan\'s other sentences, and left out alone when it states what no tool said', () => {
    expect(Object.keys(SUBMIT_REVIEW.input_schema.properties.game_plan.properties)).toContain('strengths');
    const spikes = powerSpikes(trace, { hero: 'beastmaster' }, { lang: 'zh', match });
    const plan = { strengths: '幻影刺客 15:47 做出狂战斧，之后杀了你 5 次。', course: '幻影刺客杀了你 7 次。', your_part: '你 18:39 到 12 级。', main_reason: 'enemy_play', why: '幻影刺客 6:14 到 6 级。', evidence: [{ refs: ['spikes:beastmaster'], fact: '幻影刺客 15:47 做出狂战斧，之后杀了你 5 次。' }] };
    const ok = verifyReview({ verdict: 'v', mainline: [], findings: [], blind_spots: [], game_plan: plan }, [spikes]);
    expect(ok.problems).toEqual([]);
    expect(planOf(plan, ok.problems, ok.refs)).toMatchObject({ strengths: plan.strengths, course: plan.course, main_reason: 'enemy_play' });
    const bad = { ...plan, strengths: '幻影刺客 13:13 做出狂战斧。' };
    const check = verifyReview({ verdict: 'v', mainline: [], findings: [], blind_spots: [], game_plan: bad }, [spikes]);
    expect(check.problems).toEqual([expect.objectContaining({ where: 'plan', index: 4, kind: 'time' })]);
    const kept: any = planOf(bad, check.problems, check.refs);
    expect(kept).not.toHaveProperty('strengths');
    expect(kept).toMatchObject({ course: plan.course, your_part: plan.your_part, why: plan.why });
  });
});

describe('deaths in a fight are told apart from deaths outside one', () => {
  it('a death whose position was not sampled is neither in a fight nor outside one, and keeps a check from passing', () => {
    // The fixture with the hero's positions removed around its five deaths to three or more enemies (all in fights).
    const t = JSON.parse(JSON.stringify(trace));
    const h = t.heroes.findIndex((x: any) => x.key === 'beastmaster');
    const full: any = deathContext(trace, { hero: 'beastmaster' });
    for (const d of full.deaths.filter((x: any) => full.deaths_where.three_or_more_enemy_heroes_dealing_damage.includes(x.clock))) {
      for (let s = Math.floor(d.t) - 13; s <= Math.ceil(d.t) + 1; s += 1) { const i = s - t.t0; if (i >= 0 && i < t.n) t.states[h].x[i] = null; }
    }
    const blind: any = deathContext(t, { hero: 'beastmaster' });
    expect(blind.deaths_where.three_or_more_enemy_heroes_dealing_damage).toHaveLength(5);
    expect(blind.deaths_where.three_or_more_enemy_heroes_dealing_damage_outside_fights).toEqual([]);
    expect(blind.deaths_not_known).toMatchObject({ in_a_fight: 5, three_or_more_enemy_heroes_dealing_damage_outside_fights: 5 });
    // None of the five is known to be outside a fight, and none is known to be in one: "none outside fights" is not a pass.
    const goal = { kind: 'replay_habit', habit: 'outnumbered_outside_fights', max: 1, baseline: 3, label: { en: 'x', zh: 'x' } };
    expect(evaluateHabit(goal, blind, 40).result).toBe('unknown');
    expect(evaluateHabit(goal, full, 40).result).toBe('met');
    // Low health outside fights: a death of unknown fight status with health below half, or unknown, is undecided too.
    expect(blind.deaths_not_known.health_below_half_at_window_start_outside_fights).toBeGreaterThanOrEqual(blind.deaths_not_known.in_a_fight - blind.deaths.filter((d: any) => d.in_a_fight == null && d.below_half_health_at_window_start === false).length);
    expect(evaluateHabit({ ...goal, habit: 'low_health_outside_fights', max: 0 }, { ...blind, deaths_not_known: { ...blind.deaths_not_known, health_below_half_at_window_start_outside_fights: 1 } }, 40).result).toBe('unknown');
  });

  it('the outside-fights counts are habits the next game is checked on, and the fight deaths are not in them', () => {
    const summary: any = deathContext(trace, { hero: 'beastmaster' });
    expect(HABITS.low_health_outside_fights.at).toEqual(['deaths_where', 'health_below_half_at_window_start_outside_fights']);
    expect(HABITS.outnumbered_outside_fights.at).toEqual(['deaths_where', 'three_or_more_enemy_heroes_dealing_damage_outside_fights']);
    // Five deaths to three or more enemies, all of them in fights: over every death that is a habit to check, outside fights it is not one.
    expect(habitGoal('outnumbered', summary)).toMatchObject({ kind: 'replay_habit', habit: 'outnumbered', baseline: 5 });
    expect(habitGoal('outnumbered_outside_fights', summary)).toBeNull();
    // The next game, judged on the same list: three such deaths outside fights miss a goal of one.
    const goal = { kind: 'replay_habit', habit: 'low_health_outside_fights', max: 1, baseline: 3, label: { en: 'x', zh: 'x' } };
    const next = { ...summary, deaths_where: { ...summary.deaths_where, health_below_half_at_window_start_outside_fights: ['4:21', '6:07', '9:00'] }, deaths_not_known: { ...summary.deaths_not_known, health_below_half_at_window_start_outside_fights: 0 } };
    expect(evaluateHabit(goal, next, 40).result).toBe('missed');
    expect(evaluateHabit(goal, { ...next, deaths_where: { ...next.deaths_where, health_below_half_at_window_start_outside_fights: ['4:21'] } }, 40).result).toBe('met');
    // A replay summary from before these lists existed has no such count: unknown, never a pass.
    const { health_below_half_at_window_start_outside_fights: _gone, ...old } = summary.deaths_where;
    expect(evaluateHabit(goal, { ...summary, deaths_where: old }, 40).result).toBe('unknown');
    const system = deepReviewSystem('en');
    for (const word of ['in_a_fight', '_outside_fights', 'missing from the minimap']) expect(system).toContain(word);
  });
});

describe('a rule cannot start from seeing an enemy come', () => {
  it('names the phrase in a rule\'s situation; what the player always has on screen is fine', () => {
    expect(approachClaims('小地图上你周围没有队友，而屏幕上已有敌人朝你这边走')).toEqual(['屏幕上已有敌人朝你这边走']);
    expect(approachClaims('enemies are walking toward you')).toEqual(['enemies are walking toward you']);
    for (const fine of ['小地图上有三个敌方英雄不见了', 'three enemy heroes are missing from the minimap', '你的血量低于一半、熊战士就在你攻击距离附近时', '比赛到 20:00，你身上还没有闪烁匕首', '']) expect(approachClaims(fine)).toEqual([]);
    expect(approachClaims(undefined as any)).toEqual([]);
  });
  it('it is asked about in the repair round; the finding and its rule are kept', () => {
    const build = buildCheck(trace, { hero: 'beastmaster' }, { lang: 'zh', match });
    const review = { verdict: 'v', mainline: [], blind_spots: [], findings: [{ title: 't', claim: '洞察烟斗 29:08 才出。', fix: 'f', evidence: [{ refs: ['build:beastmaster'], fact: '洞察烟斗 29:08 才拿到。' }], rule: { when: '屏幕上已有敌人朝你这边走', do: '往回走', this_game: 'x' } }] };
    const check = verifyReview(review, [build]);
    expect(check.problems).toEqual([{ where: 'finding', index: 0, kind: 'approach', text: '屏幕上已有敌人朝你这边走', soft: true }]);
    expect(check.unsupported.findings.size).toBe(0);
  });
});
