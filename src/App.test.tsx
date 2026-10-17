// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppRoutes } from './App';
import { I18nProvider } from './v2/i18n/I18nProvider';
import { FlagsProvider } from './v2/FlagsProvider';

// Keep the legacy shell out of route tests (network/heavy deps) — we only
// assert which route the router picked.
vi.mock('./app/WorkspaceShell', () => ({
  default: () => <div data-testid="legacy-shell" />,
}));

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
  });
  afterEach(() => cleanup());

  it('/new shows the v2 empty state with the composer placeholder', () => {
    renderRoute('/new');
    expect(screen.getByText('Why did you win or lose?')).toBeTruthy();
    expect(screen.getByPlaceholderText('Paste match ID or link')).toBeTruthy();
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');
  });

  it('/m/:matchId shows the match id and hero', () => {
    renderRoute('/m/9035042364?hero=pudge');
    expect(screen.getByText('9035042364')).toBeTruthy();
    expect(screen.getByText(/pudge/)).toBeTruthy();
    expect(screen.getByText(/later PR/)).toBeTruthy();
    // /m pages are indexable: no noindex meta
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
  });

  it('/m/:matchId?lang=zh renders Chinese copy and sets html lang zh-CN', () => {
    renderRoute('/m/9035042364?hero=pudge&lang=zh');
    expect(screen.getByText(/帕吉|英雄/)).toBeTruthy();
    expect(screen.getByPlaceholderText('粘贴比赛 ID 或链接')).toBeTruthy();
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('non-numeric match id gets a friendly message', () => {
    renderRoute('/m/not-a-match');
    expect(screen.getByText(/doesn’t look like a match ID/)).toBeTruthy();
  });

  it('/ and /legacy render the legacy shell', () => {
    const { unmount } = renderRoute('/');
    expect(screen.getByTestId('legacy-shell')).toBeTruthy();
    unmount();
    renderRoute('/legacy');
    expect(screen.getByTestId('legacy-shell')).toBeTruthy();
  });

  it('unknown routes fall back to the legacy shell', () => {
    renderRoute('/totally/unknown');
    expect(screen.getByTestId('legacy-shell')).toBeTruthy();
  });
});
