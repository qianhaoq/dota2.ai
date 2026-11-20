/**
 * The player's current training goal and how later games did against it.
 * Browser-only (localStorage): no account, nothing leaves the device.
 * Evaluation is the engine's pure `evaluateGoal`, so the web page, the API
 * and a future CLI judge a goal the same way.
 */
import { useEffect, useState } from 'react';
import { evaluateGoal } from '../../lib/coach/goals.js';
import type { Bi, CoachReport, GoalSpec } from './types';

export const GOAL_STORAGE_KEY = 'dota2ai.coach.goal'; // gitleaks:allow (storage key name, not a secret)
export const GOAL_CHECKS_STORAGE_KEY = 'dota2ai.coach.goalChecks'; // gitleaks:allow (storage key name, not a secret)
const CHANGED = 'dota2ai:goal';
const CHECKED = 'dota2ai:goal-checks';
const MAX_CHECKS = 30;

export interface ActiveGoal {
  id: string;
  goal: GoalSpec;
  action: Bi;
  findingId: string;
  fromMatch: number;
  fromStart: number;
  accountId: number | null;
  heroId: number;
  setAt: number;
}

export type GoalResult = 'met' | 'missed' | 'no_opportunity' | 'unknown';
export interface GoalCheck { goalId: string; matchId: number; result: GoalResult; evidence: Bi }

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
/** `event` says what changed: the goal itself, or only its check history. */
function write(key: string, value: unknown, event: string): void {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: the goal lasts for this page only.
  }
  window.dispatchEvent(new Event(event));
}

export function activeGoal(): ActiveGoal | null {
  const g = read<ActiveGoal | null>(GOAL_STORAGE_KEY, null);
  return g && typeof g.id === 'string' && g.goal && typeof g.fromStart === 'number' ? g : null;
}

export function setGoal(g: ActiveGoal | null): void {
  write(GOAL_STORAGE_KEY, g, CHANGED);
}

export function goalChecks(goalId: string): GoalCheck[] {
  const all = read<GoalCheck[]>(GOAL_CHECKS_STORAGE_KEY, []);
  return Array.isArray(all) ? all.filter((c) => c?.goalId === goalId) : [];
}

function recordCheck(c: GoalCheck): void {
  const all = read<GoalCheck[]>(GOAL_CHECKS_STORAGE_KEY, []).filter((x) => !(x.goalId === c.goalId && x.matchId === c.matchId));
  all.push(c);
  // Not a goal change: listeners of the active goal must not re-run checks.
  write(GOAL_CHECKS_STORAGE_KEY, all.slice(-MAX_CHECKS), CHECKED);
}

/**
 * Judge `report` (seat `slot`) against the active goal, if this game counts:
 * played after the game the goal came from, and by the same account when
 * both are known. Records the result once per match.
 */
export function checkGoal(goal: ActiveGoal, report: CoachReport, slot: number): GoalCheck | null {
  const m = report.match;
  if (m.id === goal.fromMatch || !m.start_time || m.start_time <= goal.fromStart) return null;
  const acct = report.players[slot]?.account_id ?? null;
  if (goal.accountId != null && acct != null && acct !== goal.accountId) return null;
  const r = evaluateGoal(goal.goal, report, slot) as { result: GoalResult; evidence: Bi };
  const check: GoalCheck = { goalId: goal.id, matchId: m.id, result: r.result, evidence: r.evidence };
  recordCheck(check);
  return check;
}

/** Re-renders when the goal changes anywhere on the page (or in another tab). */
export function useActiveGoal(): ActiveGoal | null {
  const [goal, set] = useState<ActiveGoal | null>(() => activeGoal());
  useEffect(() => {
    // Keep the same object while the stored goal is unchanged, so effects
    // that depend on it (checks) do not re-run on unrelated storage events.
    const sync = () => {
      const next = activeGoal();
      set((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    window.addEventListener(CHANGED, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(CHANGED, sync); window.removeEventListener('storage', sync); };
  }, []);
  return goal;
}

export function goalFromFinding(report: CoachReport, slot: number, findingId: string, goal: GoalSpec, action: Bi): ActiveGoal {
  const m = report.match;
  return {
    id: `${m.id}:${slot}:${findingId}`,
    goal, action, findingId,
    fromMatch: m.id,
    fromStart: m.start_time ?? 0,
    accountId: report.players[slot]?.account_id ?? null,
    heroId: report.players[slot]?.hero.id ?? 0,
    setAt: Date.now(),
  };
}
