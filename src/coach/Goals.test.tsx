// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { GOAL_STORAGE_KEY, activeGoal, goalChecks } from './goalStore';

vi.mock('../v2/i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'zh', setLang: () => {} }) }));
const load = (f: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'src/fixtures/coach', f), 'utf8'));
const first = buildCoachReport(load('match9091400302.unparsed.json'));
// The "next game": same match data, later and with fewer deaths for seat 4.
const nextRaw = load('match9091400302.unparsed.json');
nextRaw.match_id = 9091400999; nextRaw.start_time += 3600; nextRaw.players[4].deaths = 3;
const next = buildCoachReport(nextRaw);
const reports: Record<string, unknown> = { '9091400302': first, '9091400999': next };
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  fetchCoachReport: async (id: string) => reports[id],
  fetchCoachCases: () => new Promise(() => {}),
}));
const { CoachReportPage } = await import('./CoachApp');

afterEach(() => { cleanup(); window.localStorage.clear(); });
const at = (url: string) => render(
  <MemoryRouter initialEntries={[url]}><Routes><Route path="/r/:matchId" element={<CoachReportPage />} /></Routes></MemoryRouter>,
);

describe('training goal loop', () => {
  it('sets a goal from a finding, then checks it on a later game', async () => {
    at('/r/9091400302?p=4');
    await waitFor(() => expect(screen.getAllByText('设为下局目标').length).toBeGreaterThan(0));
    const btn = screen.getAllByText('设为下局目标').map((b) => b.closest('button')!).find((b) => b.textContent!.includes('每 10 分钟死亡'))!;
    fireEvent.click(btn);
    expect(activeGoal()).toMatchObject({ fromMatch: 9091400302, findingId: 'deaths.high', goal: { kind: 'deaths_per10_max', max: 2.2 } });
    // The card and the banner update from the goal event: wait for the render, do not race it.
    expect(await screen.findByText(/已设为下局目标/)).toBeTruthy();
    // On the game it came from, the banner says "play your next one".
    expect(await screen.findByText(/目标就是从这局定的/)).toBeTruthy();
    cleanup();

    at('/r/9091400999?p=4');
    await waitFor(() => expect(screen.getByText('达成')).toBeTruthy());
    // The check's evidence in the goal banner (a finding title may also mention the death count).
    expect(document.querySelector('.cx-goal .cx-goal-ev')?.textContent).toMatch(/死亡 3 次/);
    expect(screen.getByText('1 局里达成 1 局')).toBeTruthy();
    expect(goalChecks(activeGoal()!.id)).toEqual([expect.objectContaining({ matchId: 9091400999, result: 'met' })]);
    // Staying on the page must not loop: recording a check is not a goal change.
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    await new Promise((r) => setTimeout(r, 300));
    expect(writes).not.toHaveBeenCalled();
    writes.mockRestore();
  });

  it('clearing the goal removes it', async () => {
    at('/r/9091400302?p=4');
    await waitFor(() => expect(screen.getAllByText('设为下局目标').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('设为下局目标')[0].closest('button')!);
    fireEvent.click(await screen.findByText('取消'));
    expect(window.localStorage.getItem(GOAL_STORAGE_KEY)).toBeNull();
  });
});
