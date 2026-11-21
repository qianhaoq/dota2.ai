// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { detectSmartInput } from './QuickJump';
import { GOAL_STORAGE_KEY, checkGoal, goalFromFinding, setGoal } from './goalStore';
import { markReviewed } from './accountInput';

vi.mock('../v2/i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'zh', setLang: () => {} }) }));

const loadFixture = (name: string) => JSON.parse(readFileSync(path.join(process.cwd(), 'src/fixtures/coach', name), 'utf8'));
const parsedReport = buildCoachReport(loadFixture('match9091400302.parsed.json'));
const unparsedReport = buildCoachReport(loadFixture('match9091400302.unparsed.json'));

const fetchReport = vi.fn();
const fetchRecent = vi.fn();
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  fetchCoachReport: (...a: unknown[]) => fetchReport(...a),
  fetchRecentMatches: (...a: unknown[]) => fetchRecent(...a),
  fetchCoachCases: () => new Promise(() => {}),
}));

const { CoachHome, CoachPlayerPage, CoachReportPage } = await import('./CoachApp');

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  fetchReport.mockReset();
  fetchRecent.mockReset();
});

describe('detectSmartInput', () => {
  it('distinguishes match IDs/URLs from SteamID64, [U:1:n], profile URLs and vanity URLs', () => {
    expect(detectSmartInput('9091400302')).toEqual({ kind: 'match', id: '9091400302' });
    expect(detectSmartInput('https://www.opendota.com/matches/9091400302')).toEqual({ kind: 'match', id: '9091400302' });
    expect(detectSmartInput('76561198047011640')).toEqual({ kind: 'account', id: '86745912' });
    expect(detectSmartInput('[U:1:86745912]')).toEqual({ kind: 'account', id: '86745912' });
    expect(detectSmartInput('https://steamcommunity.com/profiles/76561198047011640')).toEqual({ kind: 'account', id: '86745912' });
    expect(detectSmartInput('https://www.dotabuff.com/players/86745912')).toEqual({ kind: 'account', id: '86745912' });
    expect(detectSmartInput('https://steamcommunity.com/id/someone')).toEqual({ kind: 'vanity' });
    expect(detectSmartInput('not-valid')).toEqual({ kind: 'invalid' });
    expect(detectSmartInput('   ')).toEqual({ kind: 'empty' });
  });
});

describe('CoachHome smart omnibox', () => {
  it('accepts a Steam profile URL directly in the primary box and navigates to recent games', async () => {
    fetchRecent.mockResolvedValue({ account_id: 86745912, empty_hint: null, matches: [] });
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<CoachHome />} />
          <Route path="/p/:accountId" element={<CoachPlayerPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const input = screen.getByPlaceholderText('比赛 ID，或 OpenDota / Dotabuff / STRATZ 链接');
    fireEvent.change(input, { target: { value: 'https://steamcommunity.com/profiles/76561198047011640' } });
    expect(screen.getByText(/已识别为 Steam 账号 86745912/)).toBeTruthy();
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(fetchRecent).toHaveBeenCalledWith('86745912', expect.anything()));
  });
});

describe('CoachReportPage redesigned workspace', () => {
  it('renders sticky context bar, inline role override, verdict hero, linked timeline and dual-tab dock', async () => {
    fetchReport.mockResolvedValue(parsedReport);
    const { container } = render(
      <MemoryRouter initialEntries={['/r/9091400302?p=0']}>
        <Routes><Route path="/r/:matchId" element={<CoachReportPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector('.cx-ctxbar')).toBeTruthy());

    // Compact roster by default once hero is selected, expandable on click.
    expect(container.querySelector('.cx-lineup.is-compact')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '展开 10 人详情' }));
    expect(container.querySelector('.cx-lineup.is-compact')).toBeNull();

    // Verdict hero surfaces headline above the timeline and chapters.
    expect(container.querySelector('.cx-verdict-headline')?.textContent).toBe(parsedReport.reviews[0].headline.zh);

    // Clicking a death dot on the timeline jumps straight to the Deaths tab and highlights the row.
    const deathDot = container.querySelector('.cx-death-dot') as HTMLButtonElement;
    expect(deathDot).toBeTruthy();
    fireEvent.click(deathDot);
    expect(container.querySelector('#cx-ch-deaths')).toBeTruthy();
    expect(container.querySelector('#cx-death-row-0.is-highlighted')).toBeTruthy();

    // Clicking a fight tick jumps straight to the Fights tab and highlights that fight.
    const fightTick = container.querySelector('.cx-fight-tick') as HTMLButtonElement;
    expect(fightTick).toBeTruthy();
    fireEvent.click(fightTick);
    expect(container.querySelector('#cx-ch-fights')).toBeTruthy();
    expect(container.querySelector('#cx-fight-row-0.is-highlighted')).toBeTruthy();

    // Right sticky dock toggles between Ask Coach and Player Profile, and "追问这部分" brings Ask back with context.
    fireEvent.click(screen.getByRole('tab', { name: '选手档案' }));
    expect(screen.getByText('对比同英雄的其他对局')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '追问这部分' }));
    expect(screen.getByText(/当前围绕：5 · 逐波团战/)).toBeTruthy();

    // "长页全览" shows all chapters simultaneously.
    fireEvent.click(screen.getByRole('button', { name: '长页全览' }));
    expect(container.querySelector('#cx-ch-story')).toBeTruthy();
    expect(container.querySelector('#cx-ch-laning')).toBeTruthy();
    expect(container.querySelector('#cx-ch-deaths')).toBeTruthy();
    expect(container.querySelector('#cx-ch-fights')).toBeTruthy();
  });

  it('places ParsePanel above the lineup for unparsed matches', async () => {
    fetchReport.mockResolvedValue(unparsedReport);
    const { container } = render(
      <MemoryRouter initialEntries={['/r/9091400302?p=4']}>
        <Routes><Route path="/r/:matchId" element={<CoachReportPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector('.cx-gaps--priority')).toBeTruthy());
    const order = [...container.querySelectorAll('.cx-gaps--priority, .cx-lineup')].map((el) => el.classList[0]);
    expect(order).toEqual(['cx-gaps', 'cx-lineup']);
  });
});

describe('CoachPlayerPage training hub', () => {
  it('shows active goal banner, per-match goal result badge, and filters by unreviewed/ranked', async () => {
    const f = unparsedReport.reviews[4].findings.find((x: any) => x.goal)!;
    const goal = goalFromFinding(unparsedReport as any, 4, f.id, f.goal as any, f.action);
    setGoal(goal);
    const laterRaw = loadFixture('match9091400302.unparsed.json');
    laterRaw.match_id = 9091400999; laterRaw.start_time += 3600; laterRaw.players[4].item_5 = 116; // Black King Bar: meets the "finish one answer item" goal
    const laterReport = buildCoachReport(laterRaw);
    checkGoal(goal, laterReport as any, 4);
    markReviewed(9091400302);

    fetchRecent.mockResolvedValue({
      account_id: 86745912,
      empty_hint: null,
      matches: [
        { match_id: 9091400999, start_time: laterRaw.start_time, duration: 2500, hero: { id: 67, en: 'Spectre', zh: '幽鬼', icon: null }, slot: 4, radiant: true, won: true, kda: [10, 2, 12], mode: { en: 'All Pick', zh: '全英雄选择' }, ranked: true },
        { match_id: 9091400302, start_time: 1794747997, duration: 2722, hero: { id: 29, en: 'Tidehunter', zh: '潮汐猎人', icon: null }, slot: 0, radiant: true, won: false, kda: [6, 12, 15], mode: { en: 'All Pick', zh: '全英雄选择' }, ranked: false },
      ],
    });

    const { container } = render(
      <MemoryRouter initialEntries={['/p/86745912']}>
        <Routes><Route path="/p/:accountId" element={<CoachPlayerPage />} /></Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(container.querySelectorAll('.cx-recent-row')).toHaveLength(2));
    expect(window.localStorage.getItem(GOAL_STORAGE_KEY)).toBeTruthy();
    expect(screen.getByText('达成')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '未复盘' }));
    expect(container.querySelectorAll('.cx-recent-row')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '天梯' }));
    expect(container.querySelectorAll('.cx-recent-row')).toHaveLength(1);
  });
});

describe('review follow-ups (#192)', () => {
  it('the context bar Ask button focuses the chapterless conversation on unparsed matches', async () => {
    fetchReport.mockResolvedValue(unparsedReport);
    const { container } = render(
      <MemoryRouter initialEntries={['/r/9091400302?p=4']}>
        <Routes><Route path="/r/:matchId" element={<CoachReportPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector('.cx-ctx-ask')).toBeTruthy());
    expect(container.querySelector('.cx-chapters')).toBeNull();
    fireEvent.click(container.querySelector('.cx-ctx-ask')!);
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active && container.querySelector('.cx-side')!.contains(active) && /^(TEXTAREA|INPUT)$/.test(active.tagName)).toBe(true);
    });
  });

  it('a repeat timeline jump to the same death clears a row filter that hides it', async () => {
    fetchReport.mockResolvedValue(parsedReport);
    const { container } = render(
      <MemoryRouter initialEntries={['/r/9091400302?p=0']}>
        <Routes><Route path="/r/:matchId" element={<CoachReportPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector('.cx-death-dot')).toBeTruthy());
    const dot = container.querySelector('.cx-death-dot') as HTMLButtonElement;
    fireEvent.click(dot);
    expect(container.querySelector('#cx-death-row-0')).toBeTruthy();
    // Death 0 is a lane death, so "caught alone" hides it.
    fireEvent.click(screen.getByRole('button', { name: '团战外被抓' }));
    expect(container.querySelector('#cx-death-row-0')).toBeNull();
    fireEvent.click(dot);
    await waitFor(() => expect(container.querySelector('#cx-death-row-0.is-highlighted')).toBeTruthy());
  });

  it('opening another player clears the hero filter from the previous one', async () => {
    const row = (match_id: number, id: number, en: string) => ({
      match_id, start_time: 1794747997 - match_id % 1000, duration: 2500, hero: { id, en, zh: en, icon: null }, slot: 0, radiant: true,
      won: true, kda: [1, 1, 1], mode: { en: 'All Pick', zh: '全英雄选择' }, ranked: true,
    });
    fetchRecent.mockImplementation(async (account: string) => (account === '111'
      ? { account_id: 111, empty_hint: null, matches: [row(1, 1, 'Anti-Mage'), row(2, 2, 'Axe')] }
      : { account_id: 222, empty_hint: null, matches: [row(3, 3, 'Bane'), row(4, 4, 'Bloodseeker')] }));
    const { container } = render(
      <MemoryRouter initialEntries={['/p/111']}>
        <Link to="/p/222">other player</Link>
        <Routes><Route path="/p/:accountId" element={<CoachPlayerPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelectorAll('.cx-recent-row')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: /Anti-Mage/ }));
    expect(container.querySelectorAll('.cx-recent-row')).toHaveLength(1);
    fireEvent.click(screen.getByText('other player'));
    await waitFor(() => expect(container.querySelectorAll('.cx-recent-row')).toHaveLength(2));
  });
});
