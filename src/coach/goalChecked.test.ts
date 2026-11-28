// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { checkGoal, checkRules, goalChecks, habitCurve, GOAL_CHECKS_STORAGE_KEY, type ActiveGoal } from './goalStore';
import { HABIT_KEYS, habitRef } from '../../lib/coach/goals.js';
const HABIT = HABIT_KEYS[0];

const report = buildCoachReport(JSON.parse(readFileSync(path.join(process.cwd(), 'src/fixtures/coach/match9091400302.parsed.json'), 'utf8'))) as any;
const sent: any[] = [];
const read = (b: Blob) => new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(b); });
(navigator as any).sendBeacon = (_u: string, b: Blob) => { sent.push(read(b).then((t) => JSON.parse(t))); return true; };
afterEach(() => { sent.length = 0; window.localStorage.clear(); window.sessionStorage.clear(); });

const goal = (id: string, kind: 'deaths_per10_max' | 'replay_habit'): ActiveGoal => ({
  id,
  goal: (kind === 'deaths_per10_max'
    ? { kind, max: 99, label: { en: 'x', zh: 'x' } }
    : { kind, habit: HABIT, max: 0, label: { en: 'x', zh: 'x' } }) as never,
  action: { en: 'a', zh: 'a' }, findingId: 'f', fromMatch: 1, fromStart: 1, accountId: null, heroId: 29, setAt: 1,
});

describe('goal_checked: the next-game loop closing, counted', () => {
  it('a decided check is counted once per goal and game, however often it is judged', async () => {
    const g = goal('g-met', 'deaths_per10_max');
    expect(checkGoal(g, report, 0)?.result).toBe('met');
    checkGoal(g, report, 0);
    const events = (await Promise.all(sent)).filter((e) => e.event === 'goal_checked');
    expect(events.map((e) => e.props)).toEqual([{ result: 'met' }]);
  });

  it('a later visit in a new browser session does not count the same game again', async () => {
    const g = goal('g-again', 'deaths_per10_max');
    checkGoal(g, report, 0);
    // The player comes back another day: the tab's session is gone, the stored checks are not.
    window.sessionStorage.clear();
    vi.resetModules();
    const later = await import('./goalStore');
    expect(later.checkGoal(g, report, 0)?.result).toBe('met');
    const events = (await Promise.all(sent)).filter((e) => e.event === 'goal_checked');
    expect(events.map((e) => e.props)).toEqual([{ result: 'met' }]);
  });

  it('an "unknown" kept from an earlier visit is counted when it becomes a result', async () => {
    const g = goal('g-later', 'deaths_per10_max');
    window.localStorage.setItem('dota2ai.coach.goalChecks', JSON.stringify([{ goalId: g.id, matchId: report.match.id, result: 'unknown', evidence: { en: '', zh: '' } }]));
    expect(checkGoal(g, report, 0)?.result).toBe('met');
    expect((await Promise.all(sent)).filter((e) => e.event === 'goal_checked').map((e) => e.props)).toEqual([{ result: 'met' }]);
    expect(goalChecks(g.id).map((c) => c.result)).toEqual(['met']);
  });

  it('the goal\'s extra rules are stored but not counted: one goal and one game is one event', async () => {
    const rule = { kind: 'deaths_per10_max', max: 0, label: { en: 'r', zh: 'r' } } as never; // this one is missed
    const g: ActiveGoal = { ...goal('g-rules', 'deaths_per10_max'), rules: [{ finding: 2, when: 'w', do: 'd', check: rule }, { finding: 3, when: 'w', do: 'd', check: { kind: 'deaths_per10_max', max: 99, label: { en: 'r', zh: 'r' } } as never }] };
    expect(checkGoal(g, report, 0)?.result).toBe('met');
    const rules = checkRules(g, report, 0, null);
    expect(rules.map((r) => r.check.result)).toEqual(['missed', 'met']);
    expect(goalChecks('g-rules#2').map((c) => c.result)).toEqual(['missed']); // kept for the page
    const events = (await Promise.all(sent)).filter((e) => e.event === 'goal_checked');
    expect(events.map((e) => e.props)).toEqual([{ result: 'met' }]);
  });

  it('an undecided check (the replay not read yet) is not counted', async () => {
    const c = checkGoal(goal('g-unknown', 'replay_habit'), report, 0);
    expect(c?.result).toBe('unknown');
    expect((await Promise.all(sent)).filter((e) => e.event === 'goal_checked')).toEqual([]);
  });
});

describe('habitCurve: a habit\'s count game by game', () => {
  const habit = (rules = false): ActiveGoal => ({
    id: 'h', goal: { kind: 'replay_habit', habit: HABIT, max: 1, baseline: 4, baseline_exact: true, label: { en: 'x', zh: 'x' } } as never,
    action: { en: 'a', zh: 'a' }, findingId: 'f', fromMatch: 100, fromStart: 1, accountId: null, heroId: 29, setAt: 1,
    ...(rules ? { rules: [{ finding: 2, when: 'w', do: 'd', check: { kind: 'replay_habit', habit: HABIT, max: 2, baseline: 5, baseline_exact: true, label: { en: 'y', zh: 'y' } } as never }] } : {}),
  });
  const store = (checks: object[]) => window.localStorage.setItem(GOAL_CHECKS_STORAGE_KEY, JSON.stringify(checks));
  const c = (goalId: string, matchId: number, result: string, count?: number) => ({ goalId, matchId, result, evidence: { en: '', zh: '' }, ...(count == null ? {} : { count }) });

  it('starts at the game the goal came from, then each later game that settled it, in match order', () => {
    store([c('h', 300, 'met', 1), c('h', 200, 'missed', 3), c('h', 250, 'unknown'), c('h', 260, 'no_opportunity'), c('other', 210, 'met', 0)]);
    expect(habitCurve(habit())).toEqual([{ matchId: 100, count: 4, from: true }, { matchId: 200, count: 3 }, { matchId: 300, count: 1 }]);
  });

  it('a rule has its own curve, from its own baseline', () => {
    store([c('h#2', 200, 'missed', 4), c('h', 200, 'met', 1)]);
    expect(habitCurve(habit(true), 'h#2')).toEqual([{ matchId: 100, count: 5, from: true }, { matchId: 200, count: 4 }]);
    expect(habitCurve(habit(true), 'h#9')).toBeNull();
  });

  it('a baseline that was only a lower bound is not the first point: the curve starts at the later games, if two', () => {
    const inexact = { ...habit(), goal: { kind: 'replay_habit', habit: HABIT, max: 1, baseline: 3, label: { en: 'x', zh: 'x' } } as never };
    store([c('h', 200, 'missed', 4)]);
    expect(habitCurve(inexact)).toBeNull();
    store([c('h', 200, 'missed', 4), c('h', 300, 'met', 1)]);
    expect(habitCurve(inexact)).toEqual([{ matchId: 200, count: 4 }, { matchId: 300, count: 1 }]);
  });

  it('nothing settled yet, a check stored before counts were kept, or a goal that is not a habit: no curve', () => {
    store([c('h', 200, 'unknown')]);
    expect(habitCurve(habit())).toBeNull();
    store([c('h', 200, 'met')]);
    expect(habitCurve(habit())).toBeNull();
    store([c('g', 200, 'met', 1)]);
    expect(habitCurve(goal('g', 'deaths_per10_max'))).toBeNull();
    // A habit goal from before baselines were kept: there is no first point to draw from.
    expect(habitCurve({ ...habit(), goal: { kind: 'replay_habit', habit: HABIT, max: 1, label: { en: 'x', zh: 'x' } } as never })).toBeNull();
  });

  it('a check judged from a replay stores its count', () => {
    const g = goal('g-habit', 'replay_habit');
    const ref = habitRef(g.goal, 'tidehunter') as string;
    const summary = { deaths_where: { three_or_more_enemy_heroes_dealing_damage_outside_fights: [] }, deaths_not_known: { three_or_more_enemy_heroes_dealing_damage_outside_fights: 0 } };
    expect(HABIT).toBe('outnumbered_outside_fights');
    expect(checkGoal(g, report, 0, { hero: 'tidehunter', records: { [ref]: summary } })).toMatchObject({ result: 'met', count: 0 });
    expect(goalChecks('g-habit')).toEqual([expect.objectContaining({ result: 'met', count: 0 })]);
  });
});

