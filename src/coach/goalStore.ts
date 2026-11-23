/**
 * The player's current training goal and how later games did against it.
 * Browser-only (localStorage): no account, nothing leaves the device.
 * Evaluation is the engine's pure `evaluateGoal`, so the web page, the API
 * and a future CLI judge a goal the same way.
 */
import { useSyncExternalStore } from 'react';
import { evaluateGoal, habitRef } from '../../lib/coach/goals.js';
import type { Bi, CoachReport, GoalSpec } from './types';

export const GOAL_STORAGE_KEY = 'dota2ai.coach.goal'; // gitleaks:allow (storage key name, not a secret)
export const GOAL_CHECKS_STORAGE_KEY = 'dota2ai.coach.goalChecks'; // gitleaks:allow (storage key name, not a secret)
const CHANGED = 'dota2ai:goal';
const CHECKED = 'dota2ai:goal-checks';
const MAX_CHECKS = 60;

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
  /** From a replay review: the rules the next game's replay is counted on, each with its check (lib/coach/goals.js habitGoal). */
  rules?: GoalRule[];
}
export interface GoalRule { finding: number; when: string; do: string; check: GoalSpec }
/**
 * What one game's replay says about the player's hero: the tool summaries a
 * goal is counted on, by evidence ref ("deaths:<hero>", "audit:<hero>:<ability>").
 * Null while that replay is not parsed; a ref missing from `records` is not known either.
 */
export type ReplayRecords = { hero: string; records: Record<string, unknown> } | null;

/** The evidence refs a goal and its rules are counted on in a game played as `hero` (none for a rule about another hero's ability). */
export function replayRefs(goal: ActiveGoal, hero: string): string[] {
  const specs = [goal.goal, ...(goal.rules ?? []).map((r) => r.check)].filter((s) => s.kind === 'replay_habit');
  return [...new Set(specs.map((s) => habitRef(s, hero) as string | null).filter((r): r is string => Boolean(r)))];
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
export function checkGoal(goal: ActiveGoal, report: CoachReport, slot: number, replay: ReplayRecords = null): GoalCheck | null {
  if (!counts(goal, report, slot)) return null;
  return judge(goal.id, goal.goal, report, slot, replay);
}

/**
 * Judge one spec and record it. A check that needs the replay, asked without
 * one (the games page has only the scoreboard), answers with what the replay
 * page already recorded for this game rather than replace it with "unknown".
 */
function judge(goalId: string, spec: GoalSpec, report: CoachReport, slot: number, replay: ReplayRecords): GoalCheck {
  const matchId = report.match.id;
  const ref = replay && spec.kind === 'replay_habit' ? (habitRef(spec, replay.hero) as string | null) : null;
  const summary = ref ? replay!.records[ref] ?? null : null;
  if (spec.kind === 'replay_habit' && !summary) {
    const kept = goalChecks(goalId).find((c) => c.matchId === matchId && c.result !== 'unknown');
    if (kept) return kept;
  }
  const r = evaluateGoal(spec, report, slot, summary) as { result: GoalResult; evidence: Bi };
  const check: GoalCheck = { goalId, matchId, result: r.result, evidence: r.evidence };
  recordCheck(check);
  return check;
}

/** Does this game count for the goal: played after the game it came from, by the same account when both are known. */
function counts(goal: ActiveGoal, report: CoachReport, slot: number): boolean {
  const m = report.match;
  if (m.id === goal.fromMatch || !m.start_time || m.start_time <= goal.fromStart) return false;
  const acct = report.players[slot]?.account_id ?? null;
  return !(goal.accountId != null && acct != null && acct !== goal.accountId);
}

/** A goal that needs the later game's replay (its own check, or one of its rules'), not only its scoreboard. */
export const needsReplay = (goal: ActiveGoal): boolean => goal.goal.kind === 'replay_habit' || (goal.rules ?? []).length > 0;

/**
 * The goal's rules, each judged on `replay` (this game's counts; null
 * while its replay is not parsed, which is "unknown", never a pass). Recorded
 * once per rule and match, like the goal itself.
 */
export function checkRules(goal: ActiveGoal, report: CoachReport, slot: number, replay: ReplayRecords): { rule: GoalRule; check: GoalCheck }[] {
  if (!counts(goal, report, slot)) return [];
  return (goal.rules ?? []).map((rule) => ({ rule, check: judge(`${goal.id}#${rule.finding}`, rule.check, report, slot, replay) }));
}

/**
 * Re-renders when the goal changes anywhere on the page (or in another tab).
 * useSyncExternalStore re-reads the store after subscribing, so a change made
 * between render and subscription (a click before effects ran) is not lost.
 * The snapshot is cached by its raw stored string: same goal, same object, so
 * effects that depend on it do not re-run.
 */
let cachedRaw: string | null | undefined;
let cachedGoal: ActiveGoal | null = null;
function goalSnapshot(): ActiveGoal | null {
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(GOAL_STORAGE_KEY); } catch { raw = null; }
  if (raw !== cachedRaw) { cachedRaw = raw; cachedGoal = activeGoal(); }
  return cachedGoal;
}
function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener('storage', onChange);
  return () => { window.removeEventListener(CHANGED, onChange); window.removeEventListener('storage', onChange); };
}

export function useActiveGoal(): ActiveGoal | null {
  return useSyncExternalStore(subscribe, goalSnapshot, () => null);
}
