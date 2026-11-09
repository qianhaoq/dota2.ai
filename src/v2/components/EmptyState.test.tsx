// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import EmptyState from './EmptyState';
import { I18nProvider } from '../i18n/I18nProvider';

const MatchProbe: React.FC = () => {
  const location = useLocation();
  return <div data-testid="match-probe">{location.pathname}{location.search}</div>;
};

const renderHome = (entry = '/') => render(
  <MemoryRouter initialEntries={[entry]}>
    <I18nProvider>
      <Routes>
        <Route path="/" element={<EmptyState />} />
        <Route path="/m/:matchId" element={<MatchProbe />} />
      </Routes>
    </I18nProvider>
  </MemoryRouter>,
);

describe('EmptyState — Match ID home', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => cleanup());

  it('starts with one disabled primary action and a labeled example', () => {
    renderHome();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect((screen.getByRole('button', { name: 'Review match' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('EXAMPLE · REAL MATCH')).toBeTruthy();
    expect(screen.getByAltText('Faceless Void').getAttribute('src')).toContain('/heroes/faceless_void.png');
    expect(screen.getByAltText('Wraith King').getAttribute('src')).toContain('/heroes/skeleton_king.png');
  });

  it('shows a useful error and stays on home for invalid input', () => {
    renderHome();
    const input = screen.getByRole('textbox', { name: 'Match ID or match link' });
    fireEvent.change(input, { target: { value: 'not a match' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review match' }));
    expect(screen.getByRole('alert').textContent).toContain('That doesn’t look like a match ID or link');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByTestId('match-probe')).toBeNull();
  });

  it('uses the shared match-link parser and navigates to the review', () => {
    renderHome('/?lang=en');
    fireEvent.change(screen.getByRole('textbox', { name: 'Match ID or match link' }), {
      target: { value: ' https://www.opendota.com/matches/9035042364 ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review match' }));
    expect(screen.getByTestId('match-probe').textContent).toBe('/m/9035042364?lang=en');
  });

  it('opens the real sample review from the example card', () => {
    renderHome();
    fireEvent.click(screen.getByRole('button', { name: /Open sample review · 9035042364/ }));
    expect(screen.getByTestId('match-probe').textContent).toBe('/m/9035042364?lang=en');
  });

  it('keeps the home copy and primary path bilingual', () => {
    renderHome('/?lang=zh');
    expect(screen.getByRole('heading', { name: '复盘这一局，想好下一局。' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '比赛 ID 或比赛链接' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '开始复盘' })).toBeTruthy();
    expect(screen.getByText('示例 · 真实比赛')).toBeTruthy();
  });
});
