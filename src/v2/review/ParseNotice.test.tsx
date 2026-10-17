// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ParseNotice from './ParseNotice';
import { I18nProvider } from '../i18n/I18nProvider';
import { requestMatchParse } from '../../services/dotaApiService';
import type { ReviewParseStatus } from '../../types/matchReview';

vi.mock('../../services/dotaApiService', () => ({ requestMatchParse: vi.fn() }));

const unparsed: ReviewParseStatus = {
  status: 'unparsed',
  jobId: null,
  retryAfterSec: null,
  message: 'Replay data is unavailable for this match.',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const renderNotice = () =>
  render(
    <MemoryRouter>
      <I18nProvider>
        <ParseNotice matchId="9035042364" parse={unparsed} />
      </I18nProvider>
    </MemoryRouter>,
  );

describe('ParseNotice — request-parse pending state', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.mocked(requestMatchParse).mockReset();
  });
  afterEach(() => cleanup());

  it('disables the button with the "Requesting…" label while in flight, re-enables on failure', async () => {
    const gate = deferred<ReviewParseStatus>();
    vi.mocked(requestMatchParse).mockReturnValue(gate.promise);
    renderNotice();

    fireEvent.click(screen.getByRole('button', { name: 'Request parse' }));
    const busy = screen.getByRole('button', { name: 'Requesting…' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);

    gate.reject(new Error('network down'));
    const again = (await screen.findByRole('button', { name: 'Request parse' })) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    expect(screen.getByText('Could not request the parse. Try again.')).toBeTruthy();
  });

  it('shows the pending state until the request resolves, then adopts the new status', async () => {
    const gate = deferred<ReviewParseStatus>();
    vi.mocked(requestMatchParse).mockReturnValue(gate.promise);
    renderNotice();

    fireEvent.click(screen.getByRole('button', { name: 'Request parse' }));
    expect((screen.getByRole('button', { name: 'Requesting…' }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      gate.resolve({ status: 'requested', jobId: 7, retryAfterSec: null, message: 'Parse requested.' });
    });
    // 'requested' no longer offers the action — the button is gone, not stuck busy.
    expect(screen.queryByRole('button', { name: 'Requesting…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request parse' })).toBeNull();
    expect(screen.getByText('Parse requested.')).toBeTruthy();
  });
});
