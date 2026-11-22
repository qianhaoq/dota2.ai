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
  it('reads top to bottom: header, verdict, next-game list, then each area on demand — all from the engine surface', async () => {
    fetchReport.mockResolvedValue(parsedReport);
    const { container } = render(
      <MemoryRouter initialEntries={['/r/9091400302?p=0']}>
        <Routes><Route path="/r/:matchId" element={<CoachReportPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector('.rv-head')).toBeTruthy());
    const surface = buildSurface(parsedReport, 0) as any;
    const rv = parsedReport.reviews[0];

    // Full lineup on demand only.
    expect(container.querySelector('.cx-lineup')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开 10 人详情' }));
    expect(container.querySelector('.cx-lineup')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '收起 10 人详情' }));
    expect(container.querySelector('.cx-lineup')).toBeNull();

    // One verdict, then the plan's things in order.
    expect(container.querySelector('.rv-headline')?.textContent).toBe(rv.headline.zh);
    const things = [...container.querySelectorAll('#cx-ch-plan .rv-things h3')].map((e) => e.textContent);
    expect(things).toEqual(rv.chapters.plan.map((p: any) => p.title.zh));

    // The first screen says nothing twice: the headline text appears once, and no finding body is open.
    expect(container.textContent!.split(rv.headline.zh).length - 1).toBe(1);
    for (const d of container.querySelectorAll('.rv-sec')) expect((d as HTMLDetailsElement).open).toBe(false);

    // Areas in the engine's chapter order, each summarised by its takeaway.
    const chapters = surface.cards.filter((c: any) => c.id.startsWith('chapter:'));
    const areas = [...container.querySelectorAll('.rv-sections > .rv-sec')];
    expect(areas.map((d) => d.id)).toEqual(chapters.map((c: any) => `rv-sec-${c.id.slice(8)}`));
    areas.forEach((d, n) => expect(d.querySelector('.rv-sec-take')!.textContent).toBe(chapters[n].data.chapter.takeaway.zh.replace(/\*\*/g, '')));

    // Every finding card is shown exactly once, inside the area its inspect action points to.
    for (const c of surface.cards.filter((x: any) => x.component === 'Finding')) {
      const el = container.querySelectorAll(`#card-${c.id.replace(/[^a-z0-9_-]/gi, '-')}`);
      expect(el).toHaveLength(1);
      const target = c.actions.find((a: any) => a.action === 'inspect')?.target;
      if (target) expect(el[0].closest('.rv-sec')!.id).toBe(`rv-sec-${target}`);
    }

    // Clicking a death dot opens Deaths and highlights the row; a fight tick does the same for Fights.
    fireEvent.click(container.querySelector('.cx-death-dot') as HTMLButtonElement);
    await waitFor(() => expect((container.querySelector('#rv-sec-deaths') as HTMLDetailsElement).open).toBe(true));
    expect(container.querySelector('#cx-death-row-0.is-highlighted')).toBeTruthy();
    fireEvent.click(container.querySelector('.cx-fight-tick') as HTMLButtonElement);
    await waitFor(() => expect((container.querySelector('#rv-sec-fights') as HTMLDetailsElement).open).toBe(true));
    expect(container.querySelector('#cx-fight-row-0.is-highlighted')).toBeTruthy();

    // A finding's "问教练" fills the coach rail with that finding.
    const first = rv.findings[0];
    const card = container.querySelector(`#card-finding-${first.id.replace(/[^a-z0-9_-]/gi, '-')}`) as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: '问教练' }));
    await waitFor(() => expect((container.querySelector('.rv-rail textarea') as HTMLTextAreaElement).value).toContain(first.title.zh));

    // Its evidence is shown with it; an item no player owns shows its icon, never a raw key like "cyclone".
    expect(card.querySelectorAll('.cx-ev').length).toBe(first.evidence.length);
    for (const chip of card.querySelectorAll('.cx-chip')) expect(chip.textContent).not.toMatch(/^[a-z_]+$/);

    // Compare buttons are only the engine's own compare actions.
    const allowed = new Set(surface.cards.flatMap((c: any) => c.actions.filter((x: any) => x.action === 'compare').map((x: any) => x.label.zh)));
    for (const btn of container.querySelectorAll('.rv-compare-btn')) expect(allowed.has(btn.textContent!.split(' · ')[0])).toBe(true);

    // Every chapter is in the page (collapsed, not behind tabs).
    for (const id of ['story', 'laning', 'deaths', 'fights']) expect(container.querySelector(`#cx-ch-${id}`)).toBeTruthy();
  });

  it('unparsed: the parse panel comes right after the verdict, before the next-game list and any finding', async () => {
    fetchReport.mockResolvedValue(unparsedReport);
    const { container } = render(
      <MemoryRouter initialEntries={['/r/9091400302?p=4']}>
        <Routes><Route path="/r/:matchId" element={<CoachReportPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector('.cx-gaps--priority')).toBeTruthy());
    const blocks = [...container.querySelector('.rv-main')!.children];
    expect(blocks[0].classList.contains('rv-verdict')).toBe(true);
    expect(blocks[1].classList.contains('cx-gaps--priority')).toBe(true);
    expect(blocks.slice(2).some((b) => b.querySelector('.cx-gaps'))).toBe(false);
    // No chapters: the next-game list comes from the engine's fixes, and the findings are open below it.
    const fixes = unparsedReport.reviews[4].findings.filter((f: any) => f.tone === 'fix').slice(0, 3);
    expect([...container.querySelectorAll('#cx-ch-plan .rv-things h3')].map((e) => e.textContent)).toEqual(fixes.map((f: any) => f.title.zh));
    expect((container.querySelector('.rv-sec.is-more') as HTMLDetailsElement).open).toBe(true);
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
  it('the header Ask button focuses the conversation on unparsed matches (no chapters)', async () => {
    fetchReport.mockResolvedValue(unparsedReport);
    const { container } = render(
      <MemoryRouter initialEntries={['/r/9091400302?p=4']}>
        <Routes><Route path="/r/:matchId" element={<CoachReportPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector('.cx-ctx-ask')).toBeTruthy());
    expect(container.querySelector('#cx-ch-deaths')).toBeNull(); // unparsed: no chapters
    fireEvent.click(container.querySelector('.cx-ctx-ask')!);
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active && container.querySelector('.rv-rail')!.contains(active) && /^(TEXTAREA|INPUT)$/.test(active.tagName)).toBe(true);
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

describe('every way into the conversation (review #219)', () => {
  it('chapter, plan-area and finding asks all reach the coach rail and focus it', async () => {
    fetchReport.mockResolvedValue(parsedReport);
    const { container } = render(
      <MemoryRouter initialEntries={['/r/9091400302?p=0']}>
        <Routes><Route path="/r/:matchId" element={<CoachReportPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector('.rv-sections')).toBeTruthy());
    const rail = () => container.querySelector('.rv-rail') as HTMLElement;
    const box = () => container.querySelector('.rv-rail textarea') as HTMLTextAreaElement;
    // A chapter's own ask (laning), prefilled with that chapter's question.
    const laning = container.querySelector('#cx-ch-laning') as HTMLElement;
    fireEvent.click(within(laning).getAllByRole('button', { name: /追问/ })[0]);
    await waitFor(() => expect(rail().contains(document.activeElement)).toBe(true));
    expect(box().value.length).toBeGreaterThan(0);
    // The header's ask.
    (document.activeElement as HTMLElement).blur();
    fireEvent.click(container.querySelector('.cx-ctx-ask')!);
    await waitFor(() => expect(rail().contains(document.activeElement)).toBe(true));
  });
});
