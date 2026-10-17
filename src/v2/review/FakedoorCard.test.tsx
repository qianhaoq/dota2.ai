// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FakedoorCard from './FakedoorCard';
import { I18nProvider } from '../i18n/I18nProvider';

vi.mock('../../services/analytics', () => ({ trackEvent: vi.fn() }));

const SESSION_KEY = 'dota2ai.fakedoorV2Dismissed';

const renderCard = () =>
  render(
    <MemoryRouter>
      <I18nProvider>
        <FakedoorCard />
      </I18nProvider>
    </MemoryRouter>,
  );

describe('FakedoorCard — once per session', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('marks the session after a successful submission: thanks shows, no remount', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));
    const { unmount } = renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Notify me' }));
    expect(await screen.findByText('Thanks! Your interest is recorded.')).toBeTruthy();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBe('1');

    unmount();
    renderCard();
    expect(screen.queryByText('Want this after every match?')).toBeNull();
  });

  it('does not mark the session when the submission fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500 })));
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Notify me' }));
    expect(await screen.findByText('Could not save — try again.')).toBeTruthy();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
    // The card itself stays available for a retry.
    expect(screen.getByRole('button', { name: 'Notify me' })).toBeTruthy();
  });

  it('marks the session on "Not now" and stays hidden after remount', () => {
    const { unmount } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBe('1');

    unmount();
    renderCard();
    expect(screen.queryByText('Want this after every match?')).toBeNull();
  });
});
