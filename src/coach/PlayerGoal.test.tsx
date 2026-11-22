// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ACCOUNT_STORAGE_KEY } from './accountInput';
import { GOAL_CHECKS_STORAGE_KEY, setGoal, type ActiveGoal } from './goalStore';

vi.mock('../v2/i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'en', setLang: () => {} }) }));
const recent = vi.fn();
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), fetchRecentMatches: (...a: unknown[]) => recent(...a) }));
const { CoachPlayerPage } = await import('./CoachApp');

afterEach(() => { cleanup(); window.localStorage.clear(); recent.mockReset(); });
const OWNER = 86745912;
const OTHER = 12345678;
const goal = (accountId: number | null): ActiveGoal => ({
  id: 'g1', goal: { kind: 'deaths_per10_max', max: 2, label: { en: 'At most 2 deaths per 10 minutes', zh: '每 10 分钟死亡不超过 2 次' } } as never,
  action: { en: 'a', zh: 'a' }, findingId: 'deaths.high', fromMatch: 9091400302, fromStart: 1, accountId, heroId: 29, setAt: 1,
});
const at = async (id: number) => {
  recent.mockResolvedValue({ account_id: id, empty_hint: null, matches: [] });
  const r = render(<MemoryRouter initialEntries={[`/p/${id}`]}><Routes><Route path="/p/:accountId" element={<CoachPlayerPage />} /></Routes></MemoryRouter>);
  await waitFor(() => expect(recent).toHaveBeenCalled());
  await waitFor(() => expect(r.container.querySelector('.cx-recent')).toBeTruthy());
  return r.container;
};

describe('player page: the training goal belongs to its owner (review v2.1 item 5.1)', () => {
  it('another player’s page never shows your goal', async () => {
    setGoal(goal(OWNER));
    const c = await at(OTHER);
    expect(c.querySelector('.cx-recent-goal')).toBeNull();
  });

  it('the owner’s page shows it, with a progress bar from the checked games', async () => {
    setGoal(goal(OWNER));
    window.localStorage.setItem(GOAL_CHECKS_STORAGE_KEY, JSON.stringify([
      { goalId: 'g1', matchId: 1, result: 'met', evidence: { en: '', zh: '' } },
      { goalId: 'g1', matchId: 2, result: 'missed', evidence: { en: '', zh: '' } },
      { goalId: 'g1', matchId: 3, result: 'unknown', evidence: { en: '', zh: '' } },
    ]));
    const c = await at(OWNER);
    expect(c.querySelector('.cx-recent-goal')).toBeTruthy();
    const bar = c.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('1');
    expect(bar.getAttribute('aria-valuemax')).toBe('2'); // "unknown" is not counted either way
    expect(c.querySelector('.cx-goal-tally')!.textContent).toBe('1 of 2 games met');
  });

  it('nothing checked yet: says so, never a 0/0 bar', async () => {
    setGoal(goal(OWNER));
    const c = await at(OWNER);
    expect(c.querySelector('[role="progressbar"]')).toBeNull();
    expect(c.querySelector('.cx-goal-tally')!.textContent).toMatch(/No game checked against it yet/);
  });

  it('an older goal without an account shows only on the account this browser remembers', async () => {
    setGoal(goal(null));
    expect((await at(OTHER)).querySelector('.cx-recent-goal')).toBeNull();
    cleanup();
    window.localStorage.setItem(ACCOUNT_STORAGE_KEY, String(OWNER));
    expect((await at(OWNER)).querySelector('.cx-recent-goal')).toBeTruthy();
  });
});
