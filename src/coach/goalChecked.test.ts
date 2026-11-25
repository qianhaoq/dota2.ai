// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { checkGoal, checkRules, goalChecks, type ActiveGoal } from './goalStore';
import { HABIT_KEYS } from '../../lib/coach/goals.js';
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
