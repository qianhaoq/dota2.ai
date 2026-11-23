import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { HABITS, HABIT_KEYS, evaluateGoal, evaluateHabit, habitGoal } from '../../lib/coach/goals.js';
import { deathContext } from '../../packages/review-engine/src/trace/index.js';

const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const deaths: any = deathContext(trace, { hero: 'beastmaster' });
const where = (lists: Record<string, string[]>, notKnown: Record<string, number> | null = { health_at_window_start: 0, allies_at_death: 0 }) => ({ deaths_where: lists, ...(notKnown ? { deaths_not_known: notKnown } : {}) });

describe('habitGoal', () => {
  it('every habit names a list death_context really keeps', () => {
    for (const k of HABIT_KEYS) expect(deaths.deaths_where).toHaveProperty(HABITS[k as keyof typeof HABITS].list);
    for (const k of HABIT_KEYS) { const u = HABITS[k as keyof typeof HABITS].unsure; if (u) expect(deaths.deaths_not_known).toHaveProperty(u); }
  });
  it('half as often as this game, from the replay\'s own count; code writes the label', () => {
    // Five of the eleven deaths were to three or more enemy heroes.
    expect(habitGoal('outnumbered', deaths)).toEqual({ kind: 'replay_habit', habit: 'outnumbered', max: 2, baseline: 5, label: { en: 'At most 2 deaths to three or more enemy heroes (this game: 5)', zh: '被三个以上敌方英雄围杀的阵亡不超过 2 次（这局 5 次）' } });
    expect(habitGoal('low_health', where({ health_below_half_at_window_start: ['4:21', '6:07', '24:10'] }))).toMatchObject({ max: 1, baseline: 3 });
    expect(habitGoal('alone', where({ no_ally_within_2200_at_death: ['1:00', '2:00'] }))).toMatchObject({ max: 1, baseline: 2 });
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
    expect(evaluateHabit(goal, where({ health_below_half_at_window_start: ['12:40'] }), 38)).toEqual({ result: 'met', evidence: { en: '1 deaths that began below half health (12 s before) (12:40); goal ≤ 1', zh: '死前 12 秒已不到半血的阵亡 1 次（12:40）；目标 ≤ 1' } });
    expect(evaluateHabit(goal, where({ health_below_half_at_window_start: [] }), 38)).toMatchObject({ result: 'met' });
    expect(evaluateHabit(goal, where({ health_below_half_at_window_start: ['3:00', '9:10'] }), 38)).toMatchObject({ result: 'missed', evidence: { zh: '死前 12 秒已不到半血的阵亡 2 次（3:00、9:10）；目标 ≤ 1' } });
  });
  it('never a pass on a guess', () => {
    // No replay for that game.
    expect(evaluateHabit(goal, null, 38)).toMatchObject({ result: 'unknown', evidence: { zh: '需要这局的录像：打开这局的录像复盘后核对。' } });
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
