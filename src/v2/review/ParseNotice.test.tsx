// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ParseNotice, { parseRefreshCountdownSec } from './ParseNotice';
import { I18nProvider } from '../i18n/I18nProvider';
import { requestMatchParse, requestReplayIngest } from '../../services/dotaApiService';
import type { ReviewParseStatus } from '../../types/matchReview';

vi.mock('../../services/dotaApiService', () => ({ requestMatchParse: vi.fn(), requestReplayIngest: vi.fn() }));

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

const renderNotice = (opts?: { parse?: ReviewParseStatus | null; onRefresh?: () => void }) =>
  render(
    <MemoryRouter>
      <I18nProvider>
        <ParseNotice
          matchId="9035042364"
          parse={opts && 'parse' in opts ? opts.parse ?? null : unparsed}
          onRefresh={opts?.onRefresh}
        />
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

  it('aborts the in-flight parse request on unmount', async () => {
    const gate = deferred<ReviewParseStatus>();
    vi.mocked(requestMatchParse).mockReturnValue(gate.promise);
    const { unmount } = renderNotice();

    fireEvent.click(screen.getByRole('button', { name: 'Request parse' }));
    const signal = vi.mocked(requestMatchParse).mock.calls[0][2];
    expect(signal?.aborted).toBe(false);

    unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe('ParseNotice — refresh after a parse request', () => {
  /** Submit a parse request and let it resolve with the given status. */
  const submitWith = async (status: ReviewParseStatus) => {
    const gate = deferred<ReviewParseStatus>();
    vi.mocked(requestMatchParse).mockReturnValue(gate.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Request parse' }));
    await act(async () => {
      gate.resolve(status);
    });
  };

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.mocked(requestMatchParse).mockReset();
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    window.sessionStorage.clear();
    if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('counts down from retryAfterSec and calls onRefresh at zero — request button stays hidden', async () => {
    vi.useFakeTimers();
    const onRefresh = vi.fn();
    renderNotice({ onRefresh });

    await submitWith({ status: 'requested', jobId: 7, retryAfterSec: 10, message: 'Parse requested.' });

    expect(screen.getByText('Checking again in 10s…')).toBeTruthy();
    // A parse request is already pending server-side — no second request offered.
    expect(screen.queryByRole('button', { name: 'Request parse' })).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(screen.getByText('Checking again in 1s…')).toBeTruthy();
    expect(onRefresh).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('defaults the countdown to 30s when retryAfterSec is missing, clamped to 5..600', async () => {
    const onRefresh = vi.fn();
    renderNotice({ onRefresh });

    await submitWith({ status: 'pending', jobId: 7, retryAfterSec: null, message: 'Parsing.' });
    expect(screen.getByText('Checking again in 30s…')).toBeTruthy();
  });

  it('clamps the countdown window to 5..600 seconds', () => {
    expect(parseRefreshCountdownSec(null)).toBe(30);
    expect(parseRefreshCountdownSec(undefined)).toBe(30);
    expect(parseRefreshCountdownSec(Number.NaN)).toBe(30);
    expect(parseRefreshCountdownSec(0)).toBe(5);
    expect(parseRefreshCountdownSec(2)).toBe(5);
    expect(parseRefreshCountdownSec(45.6)).toBe(46);
    expect(parseRefreshCountdownSec(99999)).toBe(600);
  });

  it('the Check again button (shown after submission) calls onRefresh immediately', async () => {
    const onRefresh = vi.fn();
    renderNotice({ onRefresh });
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();

    await submitWith({ status: 'requested', jobId: 7, retryAfterSec: 600, message: 'Parse requested.' });

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});


describe('first-party replay action', () => {
  beforeEach(() => { vi.mocked(requestMatchParse).mockReset(); vi.mocked(requestReplayIngest).mockReset(); window.localStorage.clear(); window.sessionStorage.clear(); });
  afterEach(() => cleanup());
  it('submits only on click, keeps the local job distinct, refreshes on success', async () => {
    const gate = deferred<ReviewParseStatus>();
    vi.mocked(requestReplayIngest).mockReturnValue(gate.promise);
    const onRefresh = vi.fn(); renderNotice({onRefresh, parse: {...unparsed, status: 'replay_cdn_error', ingest_available: true}});
    expect(requestReplayIngest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Download and parse official .dem'}));
    expect(screen.getByRole('button',{name:'Downloading / parsing .dem…'}).hasAttribute('disabled')).toBe(true);
    expect(requestMatchParse).not.toHaveBeenCalled();
    await act(async()=>gate.resolve({status:'replay_parsed',jobId:null,retryAfterSec:null,message:'Verified replay facts'}));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', {name: 'Download and parse official .dem'})).toBeNull();
    expect(screen.queryByText(/not enabled/)).toBeNull();
  });
  it('shows a CDN failure without claiming that OpenDota is parsing', () => {
    renderNotice({parse:{ingest_available:true,status:'replay_cdn_error',jobId:null,retryAfterSec:null,message:'Official replay CDN failed; no replay timeline was verified.'}});
    expect(screen.getByText(/no replay timeline was verified/)).toBeTruthy();
    expect(screen.queryByText(/OpenDota is still parsing/)).toBeNull();
    expect(screen.queryByText(/Official .dem ingest is not enabled/)).toBeNull();
    expect(screen.getByRole('button', {name: 'Download and parse official .dem'})).toBeTruthy();
  });
});

describe('ParseNotice — empty upstream disclosure', () => {
  afterEach(() => cleanup());
  it.each([null, { ...unparsed, status: 'replay_ingest_disabled' as const }])('keeps missing or disabled ingest on the OpenDota path (%s)', parse => {
    renderNotice({ parse });
    expect(screen.getByText(/Official .dem ingest is not enabled/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request parse' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download and parse official .dem' })).toBeNull();
  });
  it('provides a reason and distinguishes OpenDota parsing from official ingest', () => {
    renderNotice({ parse: { ...unparsed, message: '' } });
    expect(screen.getByText(/OpenDota has not parsed/)).toBeTruthy();
    expect(screen.getByText(/Official .dem ingest is not enabled/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request parse' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download and parse official .dem' })).toBeNull();
  });
});


describe('ParseNotice — current ingest availability', () => {
  afterEach(() => cleanup());
  it.each(['replay_cdn_error', 'replay_failed', 'replay_pending'] as const)('disabled with stored %s never offers ingest', status => {
    renderNotice({ parse: { ...unparsed, status, ingest_available: false } });
    expect(screen.getByText(/Official .dem ingest is not enabled/)).toBeTruthy();
    expect(screen.queryByText(/Official .dem ingest is available here/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download and parse official .dem' })).toBeNull();
  });
  it('enabled with no artifact offers the first official ingest', () => {
    renderNotice({ parse: { ...unparsed, ingest_available: true } });
    expect(screen.getByRole('button', { name: 'Download and parse official .dem' })).toBeTruthy();
    expect(screen.getByText(/Official .dem ingest is available here/)).toBeTruthy();
    expect(screen.queryByText(/not enabled/)).toBeNull();
  });
});
