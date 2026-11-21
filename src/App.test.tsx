// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AppRoutes } from './App';
import { I18nProvider } from './v2/i18n/I18nProvider';
import { FlagsProvider } from './v2/FlagsProvider';

// Pages fetch on mount; route tests only care where the router lands.
const fetchMock = vi.fn(() => Promise.reject(new Error('no network in route tests')));

const Where: React.FC = () => {
  const l = useLocation();
  return <output data-testid="where">{`${l.pathname}${l.search}`}</output>;
};

function renderRoute(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <I18nProvider>
        <FlagsProvider>
          <Where />
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

  it('/ shows the coach home', () => {
    renderRoute('/');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Paste a match.');
    expect(screen.getByPlaceholderText('Match ID or OpenDota / Dotabuff / STRATZ link')).toBeTruthy();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Review' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '9091400302' })).toBeTruthy();
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
  });

  // Retired pages are gone: every path but /, /r/:id and /p/:id goes home (keeping ?lang).
  it.each([
    ['/new', '/'],
    ['/new/anything?lang=zh', '/?lang=zh'],
    ['/legacy', '/'],
    ['/legacy/tools?lang=en', '/?lang=en'],
    ['/m', '/'],
    ['/m/9091400302?hero=pudge&lang=zh', '/?lang=zh'],
    ['/anything/else', '/'],
  ])('%s goes to %s', async (from, to) => {
    renderRoute(from);
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(to));
  });

  it('unknown routes fall back to the coach home', () => {
    renderRoute('/totally/unknown');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Paste a match.');
    expect(screen.queryByTestId('legacy-shell')).toBeNull();
  });
});
