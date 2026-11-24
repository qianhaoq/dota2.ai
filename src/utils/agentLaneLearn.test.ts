import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dayNight, laneOf, laneRole, lanePhase, skillOrder } from '../../lib/agent/lanePhase.js';
import { learnFromPros, MIN_PRO_GAMES, PRO_LANE_SOURCE } from '../../lib/agent/proLens.js';
import { EMPTY_ADVICE, emptyAdvice, LEARN_TOPICS, learnOf, runDeepReview, SUBMIT_REVIEW, verifyReview, wordingProblems, deepReviewSystem } from '../../lib/agent/deepReview.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { patchData } from '../../lib/agent/patchData.js';

// The acceptance game: 9080127650, 7.41, the player on Night Stalker (Dire), bottom lane with Witch Doctor against Slark and Pudge.
const load = (name: string) => JSON.parse(gunzipSync(readFileSync(new URL(`../../packages/review-engine/test/fixtures/${name}`, import.meta.url))).toString());
const trace = load('trace-9080127650.json.gz');
const match = JSON.parse(readFileSync(new URL('../fixtures/coach/match9080127650.public.json', import.meta.url), 'utf8'));
const ctx = { match, perspective: 'night_stalker', lang: 'en' };
const other = load('trace-9100904020.json.gz');
const PRO_LANE = JSON.parse(readFileSync(new URL('../../lib/coach/data/hero-pro-lane.json', import.meta.url), 'utf8'));

describe('lane_phase: the acceptance game, from the replay alone', () => {
  const r: any = lanePhase(trace, { hero: 'night_stalker' }, ctx);
  const f = r.facts;

  it('finds the lane, the role, the partner and the lane opponents', () => {
    expect(r).toMatchObject({ ref: 'lane_phase:night_stalker', until: '10:00', data_release: '7.41f', release_exact: true });
    expect(f).toMatchObject({ my_lane: 'bot', my_lane_role: 'off_lane', opendota_lane_role: 3, lane_partners: ['witch_doctor'], lane_opponents: ['slark', 'pudge'] });
    // Every second alive in the lane is counted once, by who stood within 1500.
    expect(f.seconds_alive_in_lane_by_heroes_within_1500).toEqual({ '2v2': 116, '2v1': 44, '2v0': 22, '1v2': 115, '1v1': 78, '1v0': 54 });
    expect(Object.values(f.seconds_alive_in_lane_by_heroes_within_1500).reduce((a: number, b: any) => a + b, 0)).toBe(f.seconds_alive_in_lane);
    expect(f.levels_at_10_00).toMatchObject({ night_stalker: 6, witch_doctor: 4, slark: 7, pudge: 7 });
    // The first night (5:00–10:00) against the level the ultimate comes at.
    expect(f.level_6_at).toEqual({ night_stalker: '9:42', witch_doctor: '14:11', slark: '7:39', pudge: '8:02' });
  });

  it('day and night: the 5:00 cycle is confirmed by Void mini-stunning only at night in this replay', () => {
    expect(r.day_and_night).toMatchObject({ basis: 'observed_in_this_replay', observations: { matching_the_rule: 15, total: 15 } });
    expect(r.day_and_night.observations.void_mini_stunned_at[0]).toBe('5:33');
    expect(r.day_and_night.observations.void_did_not_stun_at.at(-1)).toBe('4:28');
    expect(r.day_and_night.my_abilities_that_change_at_night.map((a: any) => a.ability)).toEqual(expect.arrayContaining(['night_stalker_void', 'night_stalker_crippling_fear']));
    // Over the whole game the check stops at the first Dark Ascension: after it night can come off the clock.
    const whole = dayNight(trace, trace.n);
    expect(whole.basis).toBe('observed_in_this_replay');
    expect(whole.night_forced_by_dark_ascension_at[0]).toBe('11:45');
  });

  it('death 1 (3:18) and 2 (4:39): 2v2 fights the partner died in first — not the player left alone', () => {
    const [d1, d2] = f.my_deaths;
    expect(d1).toMatchObject({ clock: '3:18', killer: 'slark', phase: 'day', next_night_in_seconds: 101, death_context_ref: 'death:night_stalker:1', my_health_share_10s_before: 0.63 });
    expect(d1.lane_partners[0]).toMatchObject({ hero: 'witch_doctor', alive: false, died_seconds_before: 5.7, killed_by: 'slark', in_an_absence: false });
    // Close fights: both lane opponents were at about a third of their health or less when the player fell.
    expect(d1.lane_opponents.map((o: any) => [o.hero, o.health_share_10s_before, o.health_share_1s_before])).toEqual([['slark', 0.3, 0.29], ['pudge', 0.46, 0.3]]);
    expect(d1.damage_in_last_15s_with_lane_opponents).toEqual({ slark: { dealt_by_me: 219, taken_by_me: 372 }, pudge: { dealt_by_me: 131, taken_by_me: 140 } });
    expect(d2).toMatchObject({ clock: '4:39', killer: 'pudge', phase: 'day', next_night_in_seconds: 21, side_of_river: 'river' });
    expect(d2.lane_partners[0]).toMatchObject({ alive: false, died_seconds_before: 9.7 });
    expect(d2.lane_opponents.map((o: any) => o.health_share_1s_before)).toEqual([0.23, 0.45]);
    // No lane death had the record's own ref: that belongs to death_context's record of the same death.
    expect(f.my_deaths.every((d: any) => d.ref === undefined)).toBe(true);
  });

  it('death 3 (8:15): at night, partner back and alive nearby, the player at 28% health and level 5 against two level 6s', () => {
    const d3 = f.my_deaths[2];
    expect(d3).toMatchObject({ clock: '8:15', phase: 'night', my_level: 5, my_health_share_10s_before: 0.28, consumables_held_10s_before: ['tpscroll', 'magic_wand'], items_used_in_last_15s: [] });
    expect(d3.lane_opponents.map((o: any) => o.level)).toEqual([6, 6]);
    expect(d3.lane_partners[0]).toMatchObject({ alive: true, distance_1s_before: 386, in_an_absence: false });
    expect(d3.lane_opponent_unit_target_spells_on_me_in_last_15s).toEqual([{ by: 'pudge', ability: 'pudge_dismember', seconds_before_death: 1.1 }]);
    // Whether the Magic Wand had charges is not in the replay: said, not assumed.
    expect(r.not_known.map((x: any) => x.topic)).toContain('item_charges');
  });

  it('the support\'s absences are trades with both sides measured; the 2v2 that did not happen is not', () => {
    expect(f.partner_absences.map((a: any) => [a.ref, a.from, a.to])).toEqual([['absence:night_stalker:witch_doctor:1', '4:48', '5:45'], ['absence:night_stalker:witch_doctor:2', '5:51', '7:53']]);
    const a = f.partner_absences[1];
    expect(a.partner_was_in.map((p: any) => p.place)).toEqual(['river_bot_jungle', 'river_mid', 'river_top_lane']);
    expect(a.payoff_measured).toMatchObject({ enemy_hero_deaths_partner_took_part_in: 0, partner_deaths: [], partner_casts_on_enemy_heroes: 0 });
    expect(a.payoff_measured.enemy_hero_deaths.map((d: any) => [d.clock, d.hero, d.killer])).toEqual([['6:49', 'dark_willow', 'ogre_magi'], ['7:42', 'dark_willow', 'lion']]);
    expect(a.payoff_measured.wards_placed).toHaveLength(6);
    expect(a.cost_measured).toEqual({ my_deaths: [], my_seconds_dead: 0, my_seconds_alive_with_both_lane_opponents_within_1500: 78 });
    expect(a.levels_at_start).toEqual({ me: 3, partner: 3, slark: 5, pudge: 4 });
    expect(a.levels_at_end).toEqual({ me: 5, partner: 3, slark: 6, pudge: 5 });
    expect(a.not_measurable).toContain('what_staying_for_the_2v2_would_have_given');
  });

  it('vision is unknown, not absent; wards are listed with the placer\'s place only', () => {
    const vision = r.not_known.find((x: any) => x.topic === 'vision');
    expect(vision.reason).toMatch(/not the same as nobody seeing/);
    expect(f.wards_placed.find((w: any) => w.clock === '2:22')).toEqual({ clock: '2:22', side: 'my_team', hero: 'witch_doctor', kind: 'observer', placer_at: 'river_bot_jungle' });
    expect(r.not_known.map((x: any) => x.topic)).toEqual(expect.arrayContaining(['ward_spots', 'creep_waves_pulls_and_lane_equilibrium', 'gold_and_last_hits']));
  });

  it('how this lane usually goes, with source, patch and bracket', () => {
    expect(r.lane_baselines.map((b: any) => [b.against, b.in_public_lanes_of_this_bracket?.bracket, b.in_public_lanes_of_this_bracket?.matchup])).toEqual([['slark', 'ca', 'even'], ['pudge', 'ca', 'unfavoured']]);
    expect(r.lane_baselines[0].in_public_lanes_of_this_bracket).toMatchObject({ source: 'STRATZ', patch: '7.41', lanes: expect.any(Number) });
  });

  it('the first ten skill points, without the innate ability', () => {
    expect(f.my_first_skill_points.map((p: any) => p.ability)).toEqual(['night_stalker_void', 'night_stalker_midnight_feast', 'night_stalker_void', 'night_stalker_midnight_feast', 'night_stalker_void', 'night_stalker_darkness', 'night_stalker_midnight_feast', 'night_stalker_crippling_fear', 'night_stalker_void', 'night_stalker_midnight_feast']);
    expect(f.my_first_skill_points[7]).toMatchObject({ ability: 'night_stalker_crippling_fear', clock: '13:43' });
  });
});

describe('lane_phase keeps unknown unknown', () => {
  it('a partner with no position samples is no absence, and the seconds are counted as unknown, not as alone', () => {
    const blank = structuredClone(trace);
    const wd = blank.heroes.findIndex((h: any) => h.key === 'witch_doctor');
    for (let i = 300; i < 480; i += 1) blank.states[wd].x[i] = null;
    const r: any = lanePhase(blank, { hero: 'night_stalker' }, ctx);
    // Both absences fell inside (or were cut by) the unseen stretch: an unseen second is never "away".
    expect(r.facts.partner_absences).toEqual([]);
    const seen = Object.values(r.facts.seconds_alive_in_lane_by_heroes_within_1500).reduce((a: number, b: any) => a + b, 0);
    expect(seen).toBeLessThan(429);
  });

  it('no Night Stalker: the cycle is assumed and said to be', () => {
    const r: any = lanePhase(other, { hero: 'beastmaster' }, { perspective: 'beastmaster' });
    expect(r.day_and_night.basis).toBe('not_observable_in_this_replay');
    expect(r.not_known).toContainEqual({ topic: 'day_night', reason: 'not_observable_in_this_replay; the 5:00 cycle is assumed' });
    expect(r.not_known).toContainEqual({ topic: 'public_lane_baseline', reason: 'no_match_data_for_this_game' });
    expect(r.facts).toMatchObject({ my_lane: 'bot', my_lane_role: 'off_lane', lane_partners: ['undying'], lane_opponents: ['phantom_assassin', 'venomancer'] });
  });

  it('lane and role helpers', () => {
    expect([laneOf('dire_bot_lane'), laneOf('river_mid'), laneOf('radiant_top_jungle'), laneOf(null)]).toEqual(['bot', 'mid', null, null]);
    expect([laneRole(2, 'bot'), laneRole(3, 'bot'), laneRole(3, 'top'), laneRole(2, 'mid'), laneRole(2, null)]).toEqual([1, 3, 1, 2, null]);
    expect(skillOrder(trace, 9, patchData('7.41').heroAbilities(60)!.map((a: any) => a.id), 3).map((p: any) => p.ability)).toEqual(['night_stalker_void', 'night_stalker_midnight_feast', 'night_stalker_void']);
  });
});

describe('learn_from_pros: the same hero in the same lane role, with sources and limits', () => {
  const r: any = learnFromPros(trace, { hero: 'night_stalker' }, ctx);

  it('names the sample: pro off-lane Night Stalker since 7.41, and how much of it is the current patch', () => {
    expect(r).toMatchObject({ ref: 'learn:night_stalker', lane_role: 'off_lane', opendota_lane_role: 3 });
    expect(r.pro_sample).toMatchObject({ games: PRO_LANE.heroes['60']['3'].games, since: '7.41', source: expect.stringMatching(/OpenDota explorer, professional matches/) });
    expect(r.pro_sample.games).toBeGreaterThanOrEqual(MIN_PRO_GAMES);
    expect(r.pro_sample.too_few_games).toBeUndefined();
    expect(r.limits.join(' ')).toMatch(/five-stacks/);
    expect(r.limits.join(' ')).toMatch(/lane, not the position/);
    expect(PRO_LANE_SOURCE).toMatchObject({ since: '7.41', fetched: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  it('skills: level by level next to professionals, and Valve\'s text for the reason', () => {
    const lv4 = r.skills.by_level[3];
    expect(lv4).toMatchObject({ level_point: 4, mine: 'night_stalker_midnight_feast', share_of_pros_taking_mine_here: PRO_LANE.heroes['60']['3'].by_level[3].night_stalker_midnight_feast });
    expect(lv4.pros_most_taken[0].ability).toBe('night_stalker_crippling_fear');
    expect(r.skills.my_points_by_level_6).toEqual({ night_stalker_void: 3, night_stalker_midnight_feast: 2, night_stalker_darkness: 1 });
    const fear = r.skills.what_each_ability_does.find((a: any) => a.ability === 'night_stalker_crippling_fear');
    expect(fear).toMatchObject({ dispellable: 'no', valve_says: expect.stringMatching(/silenced.*longer at night/) });
    // An ability with no Valve text in the data has none: no reason is made up for it.
    expect(r.skills.what_each_ability_does.find((a: any) => a.ability === 'night_stalker_midnight_feast').valve_says).toBeNull();
  });

  it('items before 10:00 next to professionals\', with the median minute', () => {
    const phase = r.items_before_10_00.pros.find((x: any) => x.item === 'phase_boots');
    expect(phase).toMatchObject({ mine: '9:17', pro_median_minute: expect.any(Number) });
    expect(r.items_before_10_00.pros.find((x: any) => x.item === 'tango').mine).toBeNull();
    expect(r.mid_game_items.items[0]).toMatchObject({ item: 'blink', mine_first_held: null });
  });

  it('the lane draft by mechanism: Dark Pact can purge Void, not Crippling Fear', () => {
    const slark = r.lane_draft.opponents.find((o: any) => o.against === 'slark');
    expect(slark.their_dispels.map((d: any) => [d.ability, d.kind])).toEqual([['slark_dark_pact', 'strong_dispel']]);
    expect(slark.my_abilities_their_dispels_cannot_remove.map((a: any) => a.ability)).toContain('night_stalker_crippling_fear');
    expect(slark.my_abilities_their_dispels_can_remove.map((a: any) => a.ability)).toEqual(['night_stalker_void']);
    expect(slark.dispel_pairing_only_if).toMatch(/debuff_on_them/);
    expect(slark.lane_in_public_games).toMatchObject({ bracket: 'ca', matchup: 'even' });
    const pudge = r.lane_draft.opponents.find((o: any) => o.against === 'pudge');
    expect(pudge.lane_in_public_games.matchup).toBe('unfavoured');
    expect(r.lane_draft.public_source).toMatch(/STRATZ, 7\.41/);
  });

  it('a role with too few professional games is flagged, not read as a pattern', () => {
    // Night Stalker in the safe lane: a handful of pro games. Read through the data directly.
    expect(PRO_LANE.heroes['60']['1'].games).toBeLessThan(MIN_PRO_GAMES);
    expect(r.other_roles_pros_play_it_in.safe_lane).toBe(PRO_LANE.heroes['60']['1'].games);
  });
});

describe('the review: fact, inference and unknown apart; advice with mechanism, trigger and conditions', () => {
  it('the schema asks for why and depends_on in every rule, inference and unknown per finding, and learn_from_pros', () => {
    const p = SUBMIT_REVIEW.input_schema.properties as any;
    expect(p.findings.items.properties.rule.required).toEqual(['when', 'do', 'this_game', 'why', 'depends_on']);
    expect(Object.keys(p.findings.items.properties)).toEqual(expect.arrayContaining(['inference', 'unknown']));
    expect(p.learn_from_pros.items.required).toEqual(['topic', 'advice', 'why', 'applies_when', 'trade_off', 'refs']);
    expect(p.learn_from_pros.items.properties.topic.enum).toEqual(LEARN_TOPICS);
    const sys = deepReviewSystem('zh');
    expect(sys).toContain('lane_phase'); expect(sys).toContain('learn_from_pros');
    expect(sys).toMatch(/Not seeing is not "no vision"/);
    expect(sys).toMatch(/not from what happened later/);
  });

  it('empty advice is named in advice only, never in a statement of fact', () => {
    expect(emptyAdvice('下一把少死，多看小地图，提升打钱。').map((w) => w.text)).toEqual(['少死', '多看小地图', '提升打钱']);
    expect(emptyAdvice('Watch the map and farm better.').map((w) => w.text)).toEqual(['Watch the map', 'farm better']);
    expect(emptyAdvice('4 级先点伤残恐惧：它的沉默黑暗契约驱散不掉。')).toEqual([]);
    // A count is not advice: "少死人的团", "少死 2 人".
    expect(emptyAdvice('对面在 6 场少死人的团战里推了塔，少死 2 人')).toEqual([]);
    expect(wordingProblems('下一把少死', {}).filter((w: any) => w.kind === 'empty')).toEqual([]);
    const f = { title: 't', claim: 'c', evidence: [], fix: '少死', rule: { when: 'w', do: '注意地图', why: 'y', depends_on: 'd' } };
    const notes = verifyReview({ verdict: '你们 6 场少死人的团战', mainline: [], findings: [f], blind_spots: [] }, []).problems.filter((p: any) => p.kind === 'empty');
    expect(notes.map((p: any) => [p.where, p.text, p.soft])).toEqual([['finding', '少死', true], ['finding', '注意地图', true]]);
    expect(EMPTY_ADVICE.flags).toContain('g');
  });

  it('learn_from_pros entries ship only whole, with refs that resolved and numbers the tools gave', () => {
    const lane: any = lanePhase(trace, { hero: 'night_stalker' }, ctx);
    const learn: any = learnFromPros(trace, { hero: 'night_stalker' }, ctx);
    const share = learn.skills.by_level[3].pros_most_taken[0].share;
    const good = { topic: 'skills', advice: '对线有斯拉克时，4 级前点出伤残恐惧', why: `职业下路夜魔里第 4 点有 ${Math.round(share * 1000) / 10}% 点伤残恐惧`, applies_when: '下路对斯拉克', trade_off: '少一点午夜盛宴', refs: ['learn:night_stalker'] };
    const badRef = { ...good, refs: ['learn:slark'] };
    const madeUp = { ...good, why: '职业里 98765 场都点它' };
    const partial = { topic: 'skills', advice: 'x', refs: ['learn:night_stalker'] };
    const review = { verdict: 'v', mainline: [], findings: [], blind_spots: [], learn_from_pros: [good, badRef, madeUp, partial] };
    const check = verifyReview(review, [lane, learn]);
    expect(check.problems.filter((p: any) => p.where === 'learn' && !p.soft).map((p: any) => [p.index, p.kind])).toEqual([[1, 'ref'], [2, 'number'], [3, 'incomplete'], [3, 'incomplete'], [3, 'incomplete']]);
    expect(learnOf(review.learn_from_pros, check.problems)).toEqual([good]);
  });

  it('end to end on the acceptance game (scripted model): the lane tools are offered, run from the player\'s side, and their records cited', async () => {
    const replies = [
      { toolCalls: [{ id: 'a', name: 'lane_phase', args: { hero: 'night_stalker' } }, { id: 'b', name: 'learn_from_pros', args: { hero: 'night_stalker' } }] },
      { toolCalls: [{ id: 's', name: 'submit_review', args: {
        verdict: '下路前两次阵亡都发生在巫医先倒下之后的 2v2 里。',
        mainline: ['3:18 和 4:39 你在下路阵亡。'],
        findings: [{
          title: '2v2 打输后没有及时脱离',
          claim: '3:18 你阵亡时巫医已在 5.7 秒前倒下；4:39 那次巫医在 9.7 秒前倒下，离入夜还有 21 秒。',
          evidence: [{ refs: ['lane_phase:night_stalker'], fact: '3:18 巫医 5.7 秒前已被斯拉克击杀，你 10 秒前血量 0.63。' }],
          inference: '这更像是一波 2v2 换血打输了，而不是被队友丢下。',
          unknown: '小兵位置和双方视野录像里没有。',
          rule: { when: '白天对线，巫医倒下而你血量过半', do: '后撤到己方一塔，等入夜再打', why: 'Void 入夜后附带微晕，伤残恐惧的沉默入夜更久', depends_on: '对面两名英雄都在线上且没有交过技能', this_game: '3:18 和 4:39 两次' },
          fix: '先退塔下。',
        }],
        learn_from_pros: [{ topic: 'skills', advice: '对线有斯拉克时，4 级前点出伤残恐惧', why: '伤残恐惧的沉默驱散不掉', applies_when: '下路对斯拉克', trade_off: '少一点午夜盛宴', refs: ['learn:night_stalker'] }],
        blind_spots: ['视野'],
      } }] },
    ];
    let i = 0; const seen: any[] = [];
    const r: any = await runDeepReview({ complete: async (o: any) => { seen.push(o); return replies[Math.min(i++, replies.length - 1)]; }, trace, hero: 'night_stalker', lang: 'zh', match });
    expect(seen[0].tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['lane_phase', 'learn_from_pros', 'ability_counters', 'hero_counters']));
    expect(r.status).toBe('ok');
    const f = r.review.findings[0];
    expect(f).toMatchObject({ inference: expect.stringMatching(/2v2/), unknown: expect.stringMatching(/视野/) });
    expect(f.rule).toMatchObject({ why: expect.stringMatching(/微晕/), depends_on: expect.stringMatching(/两名英雄/) });
    expect(r.review.learn_from_pros).toEqual([expect.objectContaining({ topic: 'skills', refs: ['learn:night_stalker'] })]);
    expect(r.tool_calls.slice(0, 2).map((c: any) => c.name)).toEqual(['lane_phase', 'learn_from_pros']);
  });

  it('every new ref resolves for an evidence card', () => {
    for (const ref of ['lane_phase:night_stalker', 'absence:night_stalker:witch_doctor:2', 'learn:night_stalker']) {
      const ev: any = resolveRef(trace, ref, { hero: 'night_stalker', match });
      expect(ev, ref).toMatchObject({ ref, kind: ref.split(':')[0] });
    }
    expect(resolveRef(trace, 'absence:night_stalker:witch_doctor:9', { hero: 'night_stalker', match })).toBeNull();
  });
});
