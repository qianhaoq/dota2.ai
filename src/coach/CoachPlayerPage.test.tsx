// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ACCOUNT_STORAGE_KEY } from './accountInput';

vi.mock('../v2/i18n/I18nProvider', () => ({ useI18n: () => ({ lang: 'zh', setLang: () => {} }) }));
const recent = vi.fn();
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), fetchRecentMatches: (...a: unknown[]) => recent(...a) }));
const { CoachPlayerPage, CoachHome } = await import('./CoachApp');

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

  it('explains a private profile and does not remember it', async () => {
    recent.mockResolvedValue({ account_id: 1, empty_hint: 'private_or_no_matches', matches: [] });
    at('/p/1');
    await waitFor(() => expect(screen.getByText(/公开比赛数据/)).toBeTruthy());
    expect(window.localStorage.getItem(ACCOUNT_STORAGE_KEY)).toBeNull();
  });
});

describe('home: start from a friend code', () => {
  it('turns a Steam profile link into the recent-games page, and explains vanity URLs', async () => {
    recent.mockResolvedValue({ account_id: 86745912, empty_hint: null, matches: [] });
    at('/');
    // Collapsed until asked for: the match ID box stays the one primary input.
    expect(screen.queryByPlaceholderText('好友代码、SteamID64 或个人资料链接')).toBeNull();
    fireEvent.click(screen.getByText('找不到比赛 ID？用 Steam 好友代码'));
    const input = screen.getByPlaceholderText('好友代码、SteamID64 或个人资料链接');
    fireEvent.change(input, { target: { value: 'https://steamcommunity.com/id/someone' } });
    fireEvent.click(screen.getByText('列出我的比赛'));
    expect(screen.getByRole('alert').textContent).toMatch(/自定义的 Steam 链接/);
    fireEvent.change(input, { target: { value: 'https://steamcommunity.com/profiles/76561198047011640' } });
    fireEvent.click(screen.getByText('列出我的比赛'));
    await waitFor(() => expect(recent).toHaveBeenCalledWith('86745912', expect.anything()));
  });

  it('offers "my recent games" once an account is remembered', () => {
    window.localStorage.setItem(ACCOUNT_STORAGE_KEY, '86745912');
    at('/');
    expect(screen.getByText(/我的最近比赛/).closest('a')?.getAttribute('href')).toBe('/p/86745912?lang=zh');
  });
});
