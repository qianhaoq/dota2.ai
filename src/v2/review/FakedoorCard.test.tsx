// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FakedoorCard from './FakedoorCard';
import { I18nProvider } from '../i18n/I18nProvider';
import { trackEvent } from '../../services/analytics';

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

describe('FakedoorCard — email validation', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.mocked(trackEvent).mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('rejects a non-empty non-email: inline error, no request, no session marker', () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    renderCard();

    fireEvent.change(screen.getByPlaceholderText('Email (optional)'), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Notify me' }));

    expect(screen.getByText('That email doesn’t look right — fix it or leave it blank.')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('rejects a space-padded junk value too (trimmed before the check)', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));
    renderCard();

    fireEvent.change(screen.getByPlaceholderText('Email (optional)'), { target: { value: '  a@b  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Notify me' }));

    expect(screen.getByText('That email doesn’t look right — fix it or leave it blank.')).toBeTruthy();
  });

  it('clears the error while editing, then submits once the email is valid', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    renderCard();

    const input = screen.getByPlaceholderText('Email (optional)');
    fireEvent.change(input, { target: { value: 'typo@' } });
    fireEvent.click(screen.getByRole('button', { name: 'Notify me' }));
    expect(screen.getByRole('alert')).toBeTruthy();

    fireEvent.change(input, { target: { value: 'fan@example.com' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Notify me' }));

    expect(await screen.findByText('Thanks! We’ll be in touch at launch.')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBe('1');
  });

  it('still submits anonymously when the contact is left empty', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Notify me' }));

    expect(await screen.findByText('Thanks! Your interest is recorded.')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
