import { describe, it, expect } from 'vitest';
import { clampFollowUpAttemptMs, DEFAULT_FOLLOW_UP_ATTEMPT_MS } from '../../lib/matchReview/followUpTimeout.js';
import { REVIEW_CLIENT_TIMEOUT_MS } from '../services/geminiService';

const budgets = { fetchBudgetMs: 90000, requestBudgetMs: 170000, maxAttempts: 2, minAttemptMs: 5000 };

describe('clampFollowUpAttemptMs', () => {
  it('defaults to a 40s attempt: exactly (170000 - 90000) / 2', () => {
    expect(DEFAULT_FOLLOW_UP_ATTEMPT_MS).toBe(40000);
    expect(clampFollowUpAttemptMs(undefined, budgets)).toBe(40000);
    expect(clampFollowUpAttemptMs('', budgets)).toBe(40000);
  });

  it('clamps oversized values to the budget ceiling', () => {
    expect(clampFollowUpAttemptMs(120000, budgets)).toBe(40000);
    expect(clampFollowUpAttemptMs('1000000', budgets)).toBe(40000);
    expect(clampFollowUpAttemptMs(Number.MAX_SAFE_INTEGER, budgets)).toBe(40000);
  });

  it('falls back to the 40s default on negative, zero, and non-numeric values', () => {
    expect(clampFollowUpAttemptMs(-1, budgets)).toBe(40000);
    expect(clampFollowUpAttemptMs(0, budgets)).toBe(40000);
    expect(clampFollowUpAttemptMs(NaN, budgets)).toBe(40000);
    expect(clampFollowUpAttemptMs('abc', budgets)).toBe(40000);
    expect(clampFollowUpAttemptMs(null, budgets)).toBe(40000);
  });

  it('keeps sane configured values unchanged (numbers and env strings)', () => {
    expect(clampFollowUpAttemptMs(40000, budgets)).toBe(40000);
    expect(clampFollowUpAttemptMs('25000', budgets)).toBe(25000);
    expect(clampFollowUpAttemptMs(8000, budgets)).toBe(8000);
  });

  it('tracks a tightened budget: ceiling is floor((request - fetch) / attempts)', () => {
    expect(clampFollowUpAttemptMs(40000, { ...budgets, requestBudgetMs: 120000 })).toBe(15000);
    expect(clampFollowUpAttemptMs(40000, { ...budgets, maxAttempts: 3 })).toBe(Math.floor(80000 / 3));
    // ...and never dips below the per-attempt floor.
    expect(clampFollowUpAttemptMs(40000, { ...budgets, requestBudgetMs: 95000 })).toBe(5000);
  });

  it('keeps fetch + every attempt inside the request budget for any configured value', () => {
    for (const raw of [undefined, 1, 4999, 5000, 40000, 99000, '123456', 'garbage']) {
      const attemptMs = clampFollowUpAttemptMs(raw, budgets);
      expect(attemptMs).toBeGreaterThanOrEqual(budgets.minAttemptMs);
      expect(budgets.fetchBudgetMs + budgets.maxAttempts * attemptMs).toBeLessThanOrEqual(budgets.requestBudgetMs);
    }
    // The whole worst-case chain still ends before the client's fixed timeout.
    expect(budgets.requestBudgetMs).toBeLessThan(REVIEW_CLIENT_TIMEOUT_MS);
    expect(REVIEW_CLIENT_TIMEOUT_MS).toBeLessThan(300000);
  });
});
