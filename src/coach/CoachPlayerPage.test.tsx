// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ACCOUNT_STORAGE_KEY, SEEN_STORAGE_KEY, markReviewed } from './accountInput';

vi.mock('../v2/i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'zh', setLang: () => {} }) }));
const recent = vi.fn();
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), fetchRecentMatches: (...a: unknown[]) => recent(...a) }));
const { CoachPlayerPage, CoachHome } = await import('./CoachApp');
const GAME = { match_id: 9096792210, start_time: 1795000000, duration: 2549, hero: { id: 44, en: 'Phantom Assassin', zh: '幻影刺客', icon: null }, slot: 7, radiant: false, won: false, kda: [7, 5, 23], mode: { en: 'All Pick', zh: '全英雄选择' }, ranked: true };

afterEach(() => { cleanup(); window.localStorage.clear(); recent.mockReset(); });
const at = (url: string) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes>
      <Route path="/" element={<CoachHome />} />
      <Route path="/p/:accountId" element={<CoachPlayerPage />} />
      <Route path="/r/:matchId" element={<p>report</p>} />
    </Routes>
  </MemoryRouter>,
);

describe('recent games page', () => {
  it('lists games that open the review on the player\'s seat, and remembers the account', async () => {
    recent.mockResolvedValue({ account_id: 86745912, empty_hint: null, matches: [
      { match_id: 9096792210, start_time: 1795000000, duration: 2549, hero: { id: 44, en: 'Phantom Assassin', zh: '幻影刺客', icon: null }, slot: 7, radiant: false, won: false, kda: [7, 5, 23], mode: { en: 'All Pick', zh: '全英雄选择' }, ranked: true },
    ] });
    const { container } = at('/p/86745912');
    await waitFor(() => expect(screen.getByText('幻影刺客')).toBeTruthy());
    expect(recent.mock.calls[0][0]).toBe('86745912');
    expect(container.querySelector('a.cx-recent-row')?.getAttribute('href')).toBe('/r/9096792210?p=7&lang=zh');
    expect(screen.getByText('负')).toBeTruthy();
    expect(window.localStorage.getItem(ACCOUNT_STORAGE_KEY)).toBe('86745912');
  });

  it('the Steam fallback list: says what is missing, shows no made-up result or K/D/A, and still opens the review on the seat', async () => {
    recent.mockResolvedValue({ account_id: 86745912, empty_hint: null, source: 'steam_web_api', matches: [
      { match_id: 9096792210, start_time: 1795000000, duration: null, hero: { id: 44, en: 'Phantom Assassin', zh: '幻影刺客', icon: null }, slot: 7, radiant: false, won: null, kda: null, mode: null, ranked: true },
    ] });
    const { container } = at('/p/86745912');
    await waitFor(() => expect(screen.getByText('幻影刺客')).toBeTruthy());
    expect(screen.getByRole('status').textContent).toMatch(/OpenDota 暂时不可用，这份列表来自 Steam/);
    expect(container.querySelector('a.cx-recent-row')?.getAttribute('href')).toBe('/r/9096792210?p=7&lang=zh');
    expect(container.querySelector('.cx-recent-result')?.textContent).toBe('—');
    expect(container.querySelector('.cx-recent-kda')?.textContent).toBe('—');
    expect(screen.queryByText('胜')).toBeNull();
    expect(screen.queryByText('负')).toBeNull();
    // Only what is known, with no separator left dangling in front.
    expect(container.querySelector('.cx-recent-meta')?.textContent).toMatch(/^天梯 · \d{4}\/\d{1,2}\/\d{1,2}$/);
  });

  it('an OpenDota list carries no fallback notice', async () => {
    recent.mockResolvedValue({ account_id: 86745912, empty_hint: null, source: 'opendota', matches: [GAME] });
    const { container } = at('/p/86745912');
    await waitFor(() => expect(screen.getByText('幻影刺客')).toBeTruthy());
    expect(screen.queryByText(/这份列表来自 Steam/)).toBeNull();
    expect(container.querySelector('.cx-recent-meta')?.textContent).toMatch(/^全英雄选择 · 天梯 · 42:29 · /);
  });

  it('explains a private profile and does not remember it', async () => {
    recent.mockResolvedValue({ account_id: 1, empty_hint: 'private_or_no_matches', matches: [] });
    at('/p/1');
    await waitFor(() => expect(screen.getByText(/公开比赛数据/)).toBeTruthy());
    expect(window.localStorage.getItem(ACCOUNT_STORAGE_KEY)).toBeNull();
  });
});

describe('home: start from a friend code', () => {
  it('the one input turns a Steam profile link into the recent-games page, and explains vanity URLs', async () => {
    recent.mockResolvedValue({ account_id: 86745912, empty_hint: null, matches: [] });
    at('/');
    // One box takes a match ID or a friend code: no second form.
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    const input = screen.getByPlaceholderText('比赛 ID，或 OpenDota / Dotabuff / STRATZ 链接');
    fireEvent.change(input, { target: { value: 'https://steamcommunity.com/id/someone' } });
    fireEvent.submit(input.closest('form')!);
    expect(screen.getByRole('alert').textContent).toMatch(/自定义的 Steam 链接/);
    fireEvent.change(input, { target: { value: 'https://steamcommunity.com/profiles/76561198047011640' } });
    expect(screen.getByRole('button', { name: '列出我的比赛' })).toBeTruthy(); // the button follows what was recognised
    fireEvent.click(screen.getByRole('button', { name: '列出我的比赛' }));
    await waitFor(() => expect(recent).toHaveBeenCalledWith('86745912', expect.anything()));
  });

  it('a bare friend code needs the friend-code mode: in match mode the same number is a match ID (review #211)', async () => {
    recent.mockResolvedValue({ account_id: 86745912, empty_hint: null, matches: [] });
    at('/');
    fireEvent.click(screen.getByRole('radio', { name: '好友码' }));
    const input = screen.getByPlaceholderText('好友代码、SteamID64 或个人资料链接');
    fireEvent.change(input, { target: { value: '86745912' } });
    expect(screen.getByRole('button', { name: '列出我的比赛' })).toBeTruthy();
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(recent).toHaveBeenCalledWith('86745912', expect.anything()));
  });

  it('friend-code mode rejects what is not an account instead of opening a match', () => {
    at('/');
    fireEvent.click(screen.getByRole('radio', { name: '好友码' }));
    const input = screen.getByPlaceholderText('好友代码、SteamID64 或个人资料链接');
    fireEvent.change(input, { target: { value: 'not an id' } });
    fireEvent.submit(input.closest('form')!);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(recent).not.toHaveBeenCalled();
  });

  it('offers "my recent games" once an account is remembered (no games loaded yet / none)', async () => {
    window.localStorage.setItem(ACCOUNT_STORAGE_KEY, '86745912');
    recent.mockResolvedValue({ account_id: 86745912, empty_hint: 'private_or_no_matches', matches: [] });
    at('/');
    expect(screen.getByText(/我的最近比赛/).closest('a')?.getAttribute('href')).toBe('/p/86745912?lang=zh');
    await waitFor(() => expect(recent).toHaveBeenCalled());
    expect(screen.getByText(/我的最近比赛/)).toBeTruthy();
  });

  it('puts the latest game one tap from its review, and marks it once reviewed', async () => {
    window.localStorage.setItem(ACCOUNT_STORAGE_KEY, '86745912');
    recent.mockResolvedValue({ account_id: 86745912, empty_hint: null, matches: [GAME] });
    const first = at('/');
    await waitFor(() => expect(screen.getByText('复盘这局')).toBeTruthy());
    expect(screen.getByText('复盘这局').closest('a')?.getAttribute('href')).toBe('/r/9096792210?p=7&lang=zh');
    expect(screen.getByText(/全部最近比赛/).closest('a')?.getAttribute('href')).toBe('/p/86745912?lang=zh');
    expect(screen.queryByText('已复盘')).toBeNull();
    first.unmount();
    markReviewed(9096792210);
    at('/');
    await waitFor(() => expect(screen.getByText('已复盘')).toBeTruthy());
  });
});

describe('recent games: new and reviewed', () => {
  it('tags games newer than the last visit, and games already reviewed', async () => {
    const older = { ...GAME, match_id: 1, start_time: 1794000000 };
    recent.mockResolvedValue({ account_id: 86745912, empty_hint: null, matches: [GAME, older] });
    window.localStorage.setItem(ACCOUNT_STORAGE_KEY, '86745912');
    window.localStorage.setItem(SEEN_STORAGE_KEY, '1794500000');
    markReviewed(1);
    const { container } = at('/p/86745912');
    await waitFor(() => expect(container.querySelectorAll('.cx-recent-row')).toHaveLength(2));
    const rows = [...container.querySelectorAll('.cx-recent-row')];
    expect(rows[0].textContent).toContain('新');
    expect(rows[0].textContent).not.toContain('已复盘');
    expect(rows[1].textContent).toContain('已复盘');
    expect(rows[1].textContent).not.toContain('新');
    // This visit has now seen everything up to the newest game.
    expect(window.localStorage.getItem(SEEN_STORAGE_KEY)).toBe(String(GAME.start_time));
  });

  it('shows no "new" tags on a first visit or for a different account', async () => {
    recent.mockResolvedValue({ account_id: 2, empty_hint: null, matches: [GAME] });
    window.localStorage.setItem(ACCOUNT_STORAGE_KEY, '86745912');
    window.localStorage.setItem(SEEN_STORAGE_KEY, '1');
    const { container } = at('/p/2');
    await waitFor(() => expect(container.querySelectorAll('.cx-recent-row')).toHaveLength(1));
    expect(container.querySelector('.cx-tag--new')).toBeNull();
  });
});
