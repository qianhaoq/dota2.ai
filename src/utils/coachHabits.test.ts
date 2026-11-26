import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { HABITS, HABIT_KEYS, evaluateGoal, evaluateHabit, habitGoal, habitRef } from '../../lib/coach/goals.js';
import { abilityAudit, deathContext } from '../../packages/review-engine/src/trace/index.js';

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const deaths: any = deathContext(trace, { hero: 'beastmaster' });
const roar: any = abilityAudit(trace, { hero: 'beastmaster', ability: 'primal_roar' });
const ROAR = { hero: 'beastmaster', hero_id: 38, ability: 'primal_roar', name: { en: 'Primal Roar', zh: '原始咆哮' } };
const where = (lists: Record<string, string[]>, notKnown: Record<string, number> | null = { health_at_window_start: 0, allies_at_death: 0 }) => ({ deaths_where: lists, ...(notKnown ? { deaths_not_known: notKnown } : {}) });

describe('habitGoal', () => {
  it('every habit names a list death_context really keeps', () => {
    // Each habit names a count its tool really keeps: over the deaths, or over an ability's casts.
    for (const k of HABIT_KEYS) {
      const h = HABITS[k as keyof typeof HABITS];
      const summary = h.from === 'deaths' ? deaths : roar;
      expect(h.at.length === 2 ? summary[h.at[0]] : summary, k).toHaveProperty(h.at[h.at.length - 1]);
      // What it could not decide is kept beside it: over the deaths, or over the ability's casts.
      if (h.unsure) expect(h.from === 'deaths' ? deaths.deaths_not_known : roar.casts_not_known, k).toHaveProperty(h.unsure);
    }
  });
  it('half as often as this game, from the replay\'s own count; code writes the label', () => {
    // Five of the eleven deaths were to three or more enemy heroes.
    expect(habitGoal('outnumbered', deaths)).toEqual({ kind: 'replay_habit', habit: 'outnumbered', max: 2, baseline: 5, label: { en: 'At most 2 deaths to three or more enemy heroes (this game: 5)', zh: '被三个以上敌方英雄围杀的阵亡不超过 2 次（这局 5 次）' } });
    expect(habitGoal('low_health', where({ health_below_half_at_window_start: ['4:21', '6:07', '24:10'] }))).toMatchObject({ max: 1, baseline: 3 });
    expect(habitGoal('alone', where({ no_ally_within_2200_at_death: ['1:00', '2:00'] }))).toMatchObject({ max: 1, baseline: 2 });
    // Lone deaths that bought nothing are their own count: four alone, two of them traded, is a baseline of two (review of #303).
    expect(habitGoal('alone_not_traded', where({ no_ally_within_2200_at_death: ['1:00', '2:00', '3:00', '4:00'], no_ally_within_2200_at_death_and_not_traded: ['1:00', '3:00'] }))).toMatchObject({ habit: 'alone_not_traded', max: 1, baseline: 2 });
  });
  it('once is not a habit, and an unknown count or habit is no check', () => {
    // One death alone (2:51), none below half health.
    expect(habitGoal('alone', deaths)).toBeNull();
    expect(habitGoal('low_health', deaths)).toBeNull();
    expect(habitGoal('farming', deaths)).toBeNull();
    expect(habitGoal(undefined as any, deaths)).toBeNull();
    expect(habitGoal('alone', null)).toBeNull();
    expect(habitGoal('alone', { deaths_where: {} })).toBeNull();
  });
});

describe('evaluateHabit', () => {
  const goal = habitGoal('low_health', where({ health_below_half_at_window_start: ['4:21', '6:07', '24:10'] }))!;
  it('met at or under the goal, missed over it, with the deaths named', () => {
    expect(evaluateHabit(goal, where({ health_below_half_at_window_start: ['12:40'] }), 38)).toEqual({ result: 'met', evidence: { en: '1 deaths that began below half health (12 s before) (12:40); goal ≤ 1', zh: '死前 12 秒已不到半血的阵亡 1 次（12:40）；目标 ≤ 1' } , count: 1 });
    expect(evaluateHabit(goal, where({ health_below_half_at_window_start: [] }), 38)).toMatchObject({ result: 'met' });
    expect(evaluateHabit(goal, where({ health_below_half_at_window_start: ['3:00', '9:10'] }), 38)).toMatchObject({ result: 'missed', evidence: { zh: '死前 12 秒已不到半血的阵亡 2 次（3:00、9:10）；目标 ≤ 1' } });
  });
  it('a settled result carries the count it was settled on — what the curve across games is drawn from', () => {
    expect(evaluateHabit(goal, where({ health_below_half_at_window_start: ['3:00', '9:10'] }), 38)).toMatchObject({ result: 'missed', count: 2 });
    expect(evaluateHabit(goal, where({ health_below_half_at_window_start: [] }), 38)).toMatchObject({ result: 'met', count: 0 });
    // Unknown and not-counted results have none.
    expect(evaluateHabit(goal, where({ health_below_half_at_window_start: ['12:40'] }, { health_at_window_start: 1, allies_at_death: 0 }), 38)).not.toHaveProperty('count');
    expect(evaluateHabit(goal, where({ health_below_half_at_window_start: [] }), 8)).not.toHaveProperty('count');
    // Settled with deaths left undecided: the result stands, but the count is only a lower bound — left out.
    const missedWithUnknowns = evaluateHabit(goal, where({ health_below_half_at_window_start: ['1:00', '2:00', '3:00'] }, { health_at_window_start: 5, allies_at_death: 0 }), 38);
    expect(missedWithUnknowns).toMatchObject({ result: 'missed' });
    expect(missedWithUnknowns).not.toHaveProperty('count');
    const metWithUnknowns = evaluateHabit(goal, where({ health_below_half_at_window_start: [] }, { health_at_window_start: 1, allies_at_death: 3 }), 38);
    expect(metWithUnknowns).toMatchObject({ result: 'met' });
    expect(metWithUnknowns).not.toHaveProperty('count');
  });
  it('never a pass on a guess', () => {
    // No replay for that game.
    expect(evaluateHabit(goal, null, 38)).toMatchObject({ result: 'unknown', evidence: { zh: '需要这局的录像：检查目标，或打开这局的录像复盘。' } });
    // Nothing settled, no count: a curve is never drawn through a guess.
    expect(evaluateHabit(goal, null, 38)).not.toHaveProperty('count');
    // A death whose health was not sampled could be one more: 1 known + 1 undecided is not "at most 1".
    expect(evaluateHabit(goal, where({ health_below_half_at_window_start: ['12:40'] }, { health_at_window_start: 1, allies_at_death: 0 }), 38)).toMatchObject({ result: 'unknown' });
    // Undecided deaths that cannot change the answer do not block it.
    expect(evaluateHabit(goal, where({ health_below_half_at_window_start: [] }, { health_at_window_start: 1, allies_at_death: 3 }), 38)).toMatchObject({ result: 'met' });
    expect(evaluateHabit(goal, where({ health_below_half_at_window_start: ['1:00', '2:00'] }, { health_at_window_start: 4, allies_at_death: 0 }), 38)).toMatchObject({ result: 'missed' });
    // A summary from before the undecided count existed cannot rule them out.
    expect(evaluateHabit(goal, where({ health_below_half_at_window_start: [] }, null), 38)).toMatchObject({ result: 'unknown' });
    // The list itself missing is not zero.
    expect(evaluateHabit(goal, where({}), 38)).toMatchObject({ result: 'unknown' });
    expect(evaluateHabit(goal, where({ health_below_half_at_window_start: [] }), 8)).toMatchObject({ result: 'no_opportunity' });
    expect(evaluateHabit({ ...goal, habit: 'nope' }, where({}), 38)).toMatchObject({ result: 'unknown' });
  });
  it('a habit with nothing undecidable needs no undecided count', () => {
    const g = habitGoal('outnumbered', deaths)!;
    expect(evaluateHabit(g, where({ three_or_more_enemy_heroes_dealing_damage: ['5:00'] }, null), 30)).toMatchObject({ result: 'met' });
  });
  it('evaluateGoal judges it from the replay summary it is handed, and says so when there is none', () => {
    const report = { match: { duration: 2400 }, players: [{ hero: { id: 29 }, kda: [1, 4, 9] }], reviews: [{ role: { kind: 'core' } }] };
    expect(evaluateGoal(goal, report, 0)).toMatchObject({ result: 'unknown' });
    expect(evaluateGoal(goal, report, 0, where({ health_below_half_at_window_start: ['3:00', '9:10'] }))).toMatchObject({ result: 'missed' });
    expect(evaluateGoal(goal, report, 0, where({ health_below_half_at_window_start: [] }))).toMatchObject({ result: 'met' });
  });
});

describe('the deaths summary of a hero who never died', () => {
  it('resolves with every count at zero, so a deathless game meets its rules', async () => {
    const { resolveRef } = await import('../../lib/agent/evidence.js');
    // The same replay with Beastmaster's deaths taken out of it.
    const full: any = resolveRef(trace, 'deaths:beastmaster', { hero: 'beastmaster' });
    expect(full.record.deaths_total).toBe(11);
    const mine = new Set(trace.deaths.filter((d: any) => deaths.deaths.some((x: any) => x.row === d[3])).map((d: any) => d[3]));
    expect(mine.size).toBe(11);
    const deathless = { ...trace, deaths: trace.deaths.filter((d: any) => !mine.has(d[3])) };
    const none: any = resolveRef(deathless, 'deaths:beastmaster', { hero: 'beastmaster' });
    expect(none).not.toBeNull();
    expect(none.record).toMatchObject({ ref: 'deaths:beastmaster', deaths_total: 0, deaths_where: { health_below_half_at_window_start: [], no_ally_within_2200_at_death: [] }, deaths_not_known: { health_at_window_start: 0, allies_at_death: 0 } });
    const goal = habitGoal('outnumbered', deaths)!;
    expect(evaluateHabit(goal, none.record, 40)).toMatchObject({ result: 'met' });
  });
});

describe('habits counted over one ability', () => {
  it('ability_audit counts what the casts have in common, by game time', () => {
    // Ten roars: none into spell immunity without a stun (it goes through), four whose target was alive 12 s later.
    expect(roar.casts_where).toEqual({ target_spell_immune_and_not_stunned: [], enemy_hero_target_alive_12s_later: ['7:54', '17:32', '22:01', '37:56'], no_hero_target_near_enemies_at_most_one_damaged_and_none_died: [] });
    // Checked against the casts themselves.
    expect(roar.casts.filter((c: any) => !c.deaths_within_12s.some((d: any) => d.hero === c.target)).map((c: any) => c.clock)).toEqual(['7:54', '17:32', '22:01', '37:56']);
  });
  it('a cast that came to little: near an enemy hero, at most one damaged, none of them dead — not travel or farming, not a pick-off', () => {
    const KEY = 'no_hero_target_near_enemies_at_most_one_damaged_and_none_died';
    const audit = (hero: string, ability: string): any => abilityAudit(trace, { hero, ability });
    // What the count used to be: every cast with no hero target whose damage reached one enemy hero or none.
    const atMostOne = (a: any) => a.casts.filter((c: any) => c.target == null && c.enemy_heroes_damaged_within_15s.length <= 1);
    const nobodyNear = (c: any) => c.enemies_within_1300.length === 0 && c.enemy_heroes_damaged_within_15s.length === 0;
    const pickOff = (c: any) => c.deaths_within_12s.some((d: any) => c.enemy_heroes_damaged_within_15s.includes(d.hero));

    // Wild Axes, 98 casts: 90 reached one enemy hero or none. 60 of those were thrown with no enemy hero near (farming), and 19 killed the hero they hit.
    const axes = audit('beastmaster', 'wild_axes');
    expect([axes.casts_total, atMostOne(axes).length, atMostOne(axes).filter(nobodyNear).length, atMostOne(axes).filter((c: any) => !nobodyNear(c) && pickOff(c)).length]).toEqual([98, 90, 60, 19]);
    expect(axes.casts_where[KEY]).toEqual(['2:51', '3:38', '7:26', '8:15', '10:12', '17:34', '22:02', '25:13', '27:54', '28:12', '41:54']);
    // Mystic Flare, 24 casts: 19 reached one enemy hero or none — and 11 of those killed the hero they hit.
    const flare = audit('skywrath_mage', 'mystic_flare');
    expect([flare.casts_total, atMostOne(flare).length, atMostOne(flare).filter(pickOff).length]).toEqual([24, 19, 11]);
    expect(flare.casts_where[KEY]).toEqual(['10:25', '15:19', '17:35', '24:01', '25:57', '36:00', '39:23', '39:41']);
    // 17:35 hit Necrophos and it was Venomancer who died: somebody else's kill does not make it a pick-off.
    expect(flare.casts.find((c: any) => c.clock === '17:35')).toMatchObject({ enemy_heroes_damaged_within_15s: ['necrolyte'], deaths_within_12s: [expect.objectContaining({ hero: 'venomancer' })] });
    // Bedlam: of three casts that reached one hero, two killed her.
    expect(audit('dark_willow', 'bedlam').casts_where[KEY]).toEqual(['22:03']);
    // The count is exactly those three conditions, read back off the cast records.
    for (const a of [axes, flare]) expect(a.casts_where[KEY]).toEqual(atMostOne(a).filter((c: any) => !nobodyNear(c) && !pickOff(c)).map((c: any) => c.clock));
    // The habit a rule can be counted by reads this count, and says what it counts.
    expect(HABITS.reached_few.at).toEqual(['casts_where', KEY]);
    const goal: any = habitGoal('reached_few', flare, { hero: 'skywrath_mage', hero_id: 101, ability: 'mystic_flare', name: { en: 'Mystic Flare', zh: '神秘之耀' } })!;
    expect(goal.label).toEqual({ en: expect.stringContaining('Mystic Flare casts near enemy heroes that damaged at most one and killed none'), zh: expect.stringContaining('在敌方英雄附近放出、至多伤到一人且没有击杀的神秘之耀') });
  });

  it('a cast whose surroundings were not sampled is neither counted nor ruled out, and the check then cannot say "met"', () => {
    const KEY = 'no_hero_target_near_enemies_at_most_one_damaged_and_none_died';
    const of = { hero: 'beastmaster', hero_id: 38, ability: 'wild_axes', name: { en: 'Wild Axes', zh: '野性之斧' } };
    const full: any = abilityAudit(trace, { hero: 'beastmaster', ability: 'wild_axes' });
    expect(full.casts_where[KEY]).toHaveLength(11);
    expect(full.casts_not_known).toEqual({ enemy_heroes_near: 0 });
    // The same game with every position sample gone: nothing about the casts, their damage or the deaths changes.
    const blank = { ...trace, states: trace.states.map((st: any) => ({ ...st, x: st.x.map(() => null), y: st.y.map(() => null) })) };
    const blind: any = abilityAudit(blank, { hero: 'beastmaster', ability: 'wild_axes' });
    // Nine are still known to have been near an enemy hero: each damaged one. The other two, and the sixty thrown
    // with nobody near, are now not known — not quietly read as travel or farming.
    expect(blind.casts_where[KEY]).toEqual(['2:51', '3:38', '8:15', '10:12', '17:34', '22:02', '27:54', '28:12', '41:54']);
    expect(blind.casts_not_known).toEqual({ enemy_heroes_near: 62 });
    expect(blind.casts_where[KEY].length + blind.casts_not_known.enemy_heroes_near).toBe(11 + 60);
    // One enemy hero unsampled is enough: a cast that damaged nobody could have been thrown beside her.
    const pa = trace.heroes.findIndex((h: any) => h.key === 'phantom_assassin');
    const onePartial: any = abilityAudit({ ...trace, states: trace.states.map((st: any, i: number) => (i === pa ? { ...st, x: st.x.map(() => null), y: st.y.map(() => null) } : st)) }, { hero: 'beastmaster', ability: 'wild_axes' });
    expect(onePartial.casts_not_known.enemy_heroes_near).toBeGreaterThan(0);
    expect(onePartial.casts_where[KEY].length).toBeLessThanOrEqual(11);

    // The next game's check: a goal of at most 10.
    const goal = { kind: 'replay_habit', habit: 'reached_few', max: 10, baseline: 20, ...of };
    expect(evaluateHabit(goal, full, 40)).toMatchObject({ result: 'missed' });
    expect(evaluateHabit({ ...goal, max: 11 }, full, 40)).toMatchObject({ result: 'met' });
    // Nine counted and sixty-two not known: under the goal only if none of the sixty-two counts, which nobody can say.
    expect(evaluateHabit(goal, blind, 40)).toEqual({ result: 'unknown', evidence: { en: '9 Wild Axes casts near enemy heroes that damaged at most one and killed none, but some casts have no position sample: cannot tell.', zh: '在敌方英雄附近放出、至多伤到一人且没有击杀的野性之斧 9 次，但有施放缺少位置采样，无法判定。' } });
    // Over the goal on what is known alone: missed, whatever the rest was.
    expect(evaluateHabit({ ...goal, max: 8 }, blind, 40)).toMatchObject({ result: 'missed' });
    // A summary from before the count of the undecided was kept cannot rule them out.
    const { casts_not_known: _gone, ...older } = full;
    expect(evaluateHabit({ ...goal, max: 11 }, older, 40)).toMatchObject({ result: 'unknown' });
    // The other counts over casts need no position, and their checks are as before.
    expect(HABITS.target_survived.unsure).toBeNull();
    expect(HABITS.reached_few.unsure).toBe('enemy_heroes_near');
  });

  it('the check carries whose ability it is, and is worded with the ability\'s name', () => {
    expect(habitGoal('target_survived', roar, ROAR)).toEqual({
      kind: 'replay_habit', habit: 'target_survived', max: 2, baseline: 4, ...ROAR,
      label: { en: 'At most 2 Primal Roar casts on an enemy hero still alive 12 s later (this game: 4)', zh: '原始咆哮放出 12 秒后目标仍存活的施放不超过 2 次（这局 4 次）' },
    });
    // A plain number counts too: three deaths with it ready and not cast.
    expect(habitGoal('died_holding', roar, ROAR)).toMatchObject({ max: 1, baseline: 3, label: { zh: '原始咆哮就绪却没放的阵亡不超过 1 次（这局 3 次）' } });
    // No casts into immunity without a stun; and an ability check without its ability is no check.
    expect(habitGoal('cast_into_immunity', roar, ROAR)).toBeNull();
    expect(habitGoal('target_survived', roar)).toBeNull();
    expect(habitGoal('target_survived', roar, { ...ROAR, name: { en: 'Primal Roar' } } as any)).toBeNull();
    // A deaths habit is not read from an audit.
    expect(habitGoal('alone', roar, ROAR)).toBeNull();
  });
  it('is counted on that hero\'s audit, and on nothing when another hero was played', () => {
    const g = habitGoal('target_survived', roar, ROAR)!;
    expect(habitRef(g, 'beastmaster')).toBe('audit:beastmaster:primal_roar');
    expect(habitRef(g, 'axe')).toBeNull();
    expect(habitRef(habitGoal('outnumbered', deaths), 'axe')).toBe('deaths:axe');
    const report = (heroId: number) => ({ match: { duration: 2400 }, players: [{ hero: { id: heroId }, kda: [1, 4, 9] }], reviews: [{ role: { kind: 'core' } }] });
    expect(evaluateGoal(g, report(2), 0, null)).toMatchObject({ result: 'no_opportunity', evidence: { zh: '这局你玩的是别的英雄。' } });
    expect(evaluateGoal(g, report(38), 0, null)).toMatchObject({ result: 'unknown' });
    expect(evaluateGoal(g, report(38), 0, roar)).toMatchObject({ result: 'missed', evidence: { zh: '原始咆哮放出 12 秒后目标仍存活的施放 4 次（7:54、17:32、22:01、37:56）；目标 ≤ 2' } });
  });
  it('no casts is not "no bad casts", and a missing count is not zero', () => {
    const g = habitGoal('target_survived', roar, ROAR)!;
    const later = (o: object) => ({ learned_at: { t: 400, clock: '6:40' }, casts_total: 6, casts_where: { enemy_hero_target_alive_12s_later: ['9:00'] }, deaths_with_it_ready_and_not_cast_total: 0, ...o });
    expect(evaluateHabit(g, later({}), 35)).toMatchObject({ result: 'met', evidence: { en: '1 Primal Roar casts on an enemy hero still alive 12 s later (9:00); goal ≤ 2' } });
    expect(evaluateHabit(g, later({ casts_total: 0, casts_where: { enemy_hero_target_alive_12s_later: [] } }), 35)).toMatchObject({ result: 'no_opportunity', evidence: { zh: '这局没有放过原始咆哮。' } });
    expect(evaluateHabit(g, later({ learned_at: null, casts_total: 0 }), 35)).toMatchObject({ result: 'no_opportunity', evidence: { zh: '这局没有学原始咆哮。' } });
    expect(evaluateHabit(g, later({ casts_where: {} }), 35)).toMatchObject({ result: 'unknown' });
    // Learned, never cast, and no death with it ready: the deaths count still stands on its own.
    const held = habitGoal('died_holding', roar, ROAR)!;
    expect(evaluateHabit(held, later({ casts_total: 0 }), 35)).toMatchObject({ result: 'met', evidence: { zh: '原始咆哮就绪却没放的阵亡 0 次；目标 ≤ 1' } });
    expect(evaluateHabit(held, later({ deaths_with_it_ready_and_not_cast_total: 2 }), 35)).toMatchObject({ result: 'missed' });
    expect(evaluateHabit(held, later({ deaths_with_it_ready_and_not_cast_total: undefined }), 35)).toMatchObject({ result: 'unknown' });
    // A reached-few count only exists for an ability that shows in the damage log.
    const few = { ...g, habit: 'reached_few' };
    expect(evaluateHabit(few, later({}), 35)).toMatchObject({ result: 'unknown' });
  });
});
