// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppRoutes } from './App';
import { I18nProvider } from './v2/i18n/I18nProvider';
import { FlagsProvider } from './v2/FlagsProvider';

// Keep the legacy shell out of route tests (network/heavy deps) — we only
// assert which route the router picked.
vi.mock('./app/WorkspaceShell', () => ({
  default: () => <div data-testid="legacy-shell" />,
}));

// The v2 match page fetches review data on mount; route tests only care about
// which shell renders, so fetch fails fast (the page shows its error state).
const fetchMock = vi.fn(() => Promise.reject(new Error('no network in route tests')));

function renderRoute(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <I18nProvider>
        <FlagsProvider>
          <AppRoutes />
        </FlagsProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe('App routes', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.lang = 'en';
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('/ shows the new v2 home', () => {
    renderRoute('/');
    expect(screen.getByText('Why did you win or lose?')).toBeTruthy();
    expect(screen.getByPlaceholderText('Paste match ID or link')).toBeTruthy();
    // / is indexable: no noindex meta.
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
  });

  it('/new shows the v2 empty state with the composer placeholder', () => {
    renderRoute('/new');
    expect(screen.getByText('Why did you win or lose?')).toBeTruthy();
    expect(screen.getByPlaceholderText('Paste match ID or link')).toBeTruthy();
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');
  });

  it('/m/:matchId shows the match chip and the load error state', async () => {
    renderRoute('/m/9035042364?hero=pudge');
    expect(screen.getByText('9035042364')).toBeTruthy();
    await screen.findByRole('button', { name: 'Retry' });
    // /m pages are indexable: no noindex meta
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
  });

  it('/m/:matchId?lang=zh renders Chinese copy and sets html lang zh-CN', async () => {
    renderRoute('/m/9035042364?hero=pudge&lang=zh');
    expect(await screen.findByText('比赛')).toBeTruthy();
    expect(screen.getByPlaceholderText('粘贴比赛 ID 或链接')).toBeTruthy();
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('non-numeric match id gets a friendly message', () => {
    renderRoute('/m/not-a-match');
    expect(screen.getByText(/doesn’t look like a match ID/)).toBeTruthy();
  });

  it('bare /m (no match id) renders the invalid-match view, not the legacy shell', () => {
    const { unmount } = renderRoute('/m');
    expect(screen.getByText(/doesn’t look like a match ID/)).toBeTruthy();
    unmount();
    renderRoute('/m/');
    expect(screen.getByText(/doesn’t look like a match ID/)).toBeTruthy();
  });

  it('/legacy renders the legacy shell', () => {
    renderRoute('/legacy');
    expect(screen.getByTestId('legacy-shell')).toBeTruthy();
  });

  it('legacy hash deep links on / redirect to /legacy + hash', async () => {
    renderRoute('/#training');
    await waitFor(() => expect(screen.getByTestId('legacy-shell')).toBeTruthy());
  });

  it('unknown routes fall back to the new home', () => {
    renderRoute('/totally/unknown');
    expect(screen.getByText('Why did you win or lose?')).toBeTruthy();
    expect(screen.queryByTestId('legacy-shell')).toBeNull();
  });
});
