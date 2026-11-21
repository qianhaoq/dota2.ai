// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { buildSurface } from '../../lib/coach/cards.js';
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
  it('renders sticky context bar, verdict hero, linked timeline and the engine card surface', async () => {
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

    // The review is the engine's card surface, in the engine's order, with only each card's own actions.
    const surface = buildSurface(parsedReport, 0) as any;
    const expected = surface.cards.map((c: any) => c.component.toLowerCase())
      .filter((c: string) => c !== 'matchheader' && c !== 'matchups'); // header is the page's own; the lane chapter carries matchups
    const shown = [...container.querySelectorAll('.cxv-main > .cxv-card')].map((el) => [...el.classList].find((x) => x.startsWith('is-') && !['is-good', 'is-fix', 'is-neutral'].includes(x))!.slice(3));
    expect(shown).toEqual(expected);
    const allowed = new Set(surface.cards.flatMap((c: any) => c.actions.map((x: any) => x.label.zh)));
    for (const btn of container.querySelectorAll('.cxv-act')) expect(allowed.has(btn.textContent!)).toBe(true);

    // A finding's "问教练" fills the docked conversation with that finding.
    const first = parsedReport.reviews[0].findings[0];
    const card = container.querySelector(`#card-finding-${first.id.replace(/[^a-z0-9_-]/gi, '-')}`)!;
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: '问教练' }));
    await waitFor(() => expect((container.querySelector('.cxv-rail textarea') as HTMLTextAreaElement).value).toContain(first.title.zh));

    // Every chapter is on the page at once: no tabs to hunt through.
    for (const id of ['story', 'laning', 'deaths', 'fights']) expect(container.querySelector(`#cx-ch-${id}`)).toBeTruthy();
  });

  it('unparsed: the parse card comes right after the headline, before any finding', async () => {
    fetchReport.mockResolvedValue(unparsedReport);
    const { container } = render(
      <MemoryRouter initialEntries={['/r/9091400302?p=4']}>
        <Routes><Route path="/r/:matchId" element={<CoachReportPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector('.cx-gaps--priority')).toBeTruthy());
    const cards = [...container.querySelectorAll('.cxv-main > .cxv-card')];
    expect(cards[0].classList.contains('is-headline')).toBe(true);
    expect(cards[1].classList.contains('is-datagaps')).toBe(true);
    expect(cards[1].querySelector('.cx-gaps--priority')).toBeTruthy();
    expect(cards.slice(2).every((c) => !c.classList.contains('is-datagaps'))).toBe(true);
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
    expect(container.querySelector('#cx-ch-deaths')).toBeNull(); // unparsed: no chapter cards
    fireEvent.click(container.querySelector('.cx-ctx-ask')!);
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active && container.querySelector('.cxv-rail')!.contains(active) && /^(TEXTAREA|INPUT)$/.test(active.tagName)).toBe(true);
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

describe('review follow-ups, round 2 (#192)', () => {
  it('a timeline jump reopens a data disclosure the user collapsed', async () => {
    fetchReport.mockResolvedValue(parsedReport);
    const { container } = render(
      <MemoryRouter initialEntries={['/r/9091400302?p=0']}>
        <Routes><Route path="/r/:matchId" element={<CoachReportPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector('.cx-death-dot')).toBeTruthy());
    const dot = container.querySelector('.cx-death-dot') as HTMLButtonElement;
    fireEvent.click(dot);
    const details = container.querySelector('#cx-death-row-0')!.closest('details')!;
    details.open = false;
    fireEvent.click(dot);
    await waitFor(() => expect(container.querySelector('#cx-death-row-0')!.closest('details')!.open).toBe(true));
  });

  it("goal results show only on the goal owner's recent games", async () => {
    const f = unparsedReport.reviews[4].findings.find((x: any) => x.goal)!;
    const goal = { ...goalFromFinding(unparsedReport as any, 4, f.id, f.goal as any, f.action), accountId: 111 };
    setGoal(goal);
    const laterRaw = loadFixture('match9091400302.unparsed.json');
    laterRaw.match_id = 9091400999; laterRaw.start_time += 3600;
    expect(checkGoal(goal, buildCoachReport(laterRaw) as any, 4)).toBeTruthy();
    const recent = (account_id: number) => ({
      account_id, empty_hint: null,
      matches: [{ match_id: 9091400999, start_time: laterRaw.start_time, duration: 2500, hero: { id: 67, en: 'Spectre', zh: '幽鬼', icon: null }, slot: 4, radiant: true, won: true, kda: [1, 1, 1], mode: { en: 'All Pick', zh: '全英雄选择' }, ranked: true }],
    });
    fetchRecent.mockImplementation(async (account: string) => recent(Number(account)));
    const { container } = render(
      <MemoryRouter initialEntries={['/p/222']}>
        <Link to="/p/111">owner</Link>
        <Routes><Route path="/p/:accountId" element={<CoachPlayerPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelectorAll('.cx-recent-row')).toHaveLength(1));
    expect(container.querySelector('.cx-recent-row .cx-goal-result')).toBeNull();
    fireEvent.click(screen.getByText('owner'));
    await waitFor(() => expect(container.querySelector('.cx-recent-row .cx-goal-result')).toBeTruthy());
  });

  it('the quick-jump overlay renders outside the blurred header', async () => {
    fetchReport.mockResolvedValue(parsedReport);
    const { container } = render(
      <MemoryRouter initialEntries={['/r/9091400302?p=0']}>
        <Routes><Route path="/r/:matchId" element={<CoachReportPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector('.cx-qj-trigger')).toBeTruthy());
    fireEvent.click(container.querySelector('.cx-qj-trigger')!);
    const backdrop = document.querySelector('.cx-modal-backdrop')!;
    expect(backdrop).toBeTruthy();
    expect(backdrop.closest('.cx-top')).toBeNull();
    expect(backdrop.closest('.cx')).toBeTruthy();
  });
});
