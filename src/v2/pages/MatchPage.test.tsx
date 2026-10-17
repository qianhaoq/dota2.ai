// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import MatchPage from './MatchPage';
import { I18nProvider } from '../i18n/I18nProvider';
import { trackEvent } from '../../services/analytics';

vi.mock('../../services/analytics', () => ({
  trackEvent: vi.fn(),
  trackReviewViewed: vi.fn(),
}));

const fixturesDir = path.join(__dirname, '../__fixtures__');
const readFixture = (name: string) =>
  JSON.parse(readFileSync(path.join(fixturesDir, `review-9035042364${name}.json`), 'utf8'));

const enFixture = readFixture('-en');
const zhFixture = readFixture('-zh');
const pudgeEn = readFixture('-pudge-en');
const pudgeZh = readFixture('-pudge-zh');

/** Duck-typed Responses (jsdom has no fetch implementation to lean on). */
function jsonResponse(obj: unknown) {
  return {
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => obj,
  };
}

function sseResponse(chunks: Array<Record<string, unknown>>) {
  const lines = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'];
  const encoded = lines.map((l) => Uint8Array.from(l, (c) => c.charCodeAt(0)));
  let i = 0;
  return {
    ok: true,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
    body: {
      getReader: () => ({
        read: async () =>
          i < encoded.length ? { done: false, value: encoded[i++] } : { done: true, value: undefined },
        cancel: async () => {},
      }),
    },
  };
}

/** Duck-typed 429 with a Retry-After header + localized body (server PR #89). */
function rateLimitResponse(sec: number) {
  return {
    ok: false,
    status: 429,
    headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? String(sec) : null) },
    json: async () => ({ error: 'rate_limited', message: 'Too many requests', retryAfterSec: sec }),
  };
}

const fetchMock = vi.fn();
let heroResponse: unknown = null;

function stubFetch(opts: {
  base: unknown;
  hero?: unknown;
  post?: Array<Record<string, unknown>>;
  postResponse?: unknown;
}) {
  heroResponse = opts.hero ?? opts.base;
  const post = opts.post ?? [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((input: unknown, init?: { method?: string }) => {
    if ((init?.method ?? 'GET') === 'POST') {
      return Promise.resolve(opts.postResponse ?? sseResponse(post));
    }
    const url = new URL(String(input), 'http://local.test');
    const lang = url.searchParams.get('lang') === 'zh' ? 'zh' : 'en';
    const withHero = url.searchParams.has('heroId');
    if (withHero) return Promise.resolve(jsonResponse(heroResponse));
    return Promise.resolve(jsonResponse(lang === 'zh' ? zhFixture : enFixture));
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderPage(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <I18nProvider>
        <Routes>
          <Route path="/m/:matchId" element={<MatchPage />} />
        </Routes>
      </I18nProvider>
    </MemoryRouter>,
  );
}

const CONCLUSION_KEYS = ['turningPoint', 'topMistake', 'nextGameRule'] as const;

/**
 * Number tokens per TEXT NODE (not glued textContent — adjacent block elements
 * would fuse "43:00" + "44:00" into one fake token). Every token the page shows
 * must exist verbatim somewhere in the fixture JSON: nothing is computed or
 * invented client-side.
 */
function renderedNumberTokens(main: HTMLElement): Set<string> {
  const tokens = new Set<string>();
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    for (const m of (node.nodeValue ?? '').match(/\d[\d,.:]*/g) ?? []) tokens.add(m);
  }
  return tokens;
}

describe('MatchPage — golden fixtures', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the 3 cards verbatim; every number in the conversation comes from the fixture (en)', async () => {
    stubFetch({ base: enFixture, hero: pudgeEn });
    renderPage('/m/9035042364?hero=pudge');

    for (const key of CONCLUSION_KEYS) {
      expect(await screen.findByText(pudgeEn.threeConclusions[key].summary)).toBeTruthy();
    }
    expect(screen.getByPlaceholderText('Ask a follow-up about this match')).toBeTruthy();

    const tokens = renderedNumberTokens(screen.getByRole('main'));
    const fixtureText = readFileSync(path.join(fixturesDir, 'review-9035042364-pudge-en.json'), 'utf8');
    expect(tokens.size).toBeGreaterThan(5);
    for (const token of tokens) {
      expect(fixtureText, `rendered number "${token}" must exist in the fixture`).toContain(token);
    }
  });

  it('renders the 3 cards verbatim; every number comes from the zh fixture (zh)', async () => {
    stubFetch({ base: zhFixture, hero: pudgeZh });
    renderPage('/m/9035042364?hero=pudge&lang=zh');

    for (const key of CONCLUSION_KEYS) {
      expect(await screen.findByText(pudgeZh.threeConclusions[key].summary)).toBeTruthy();
    }
    expect(screen.getByPlaceholderText('继续追问这场比赛')).toBeTruthy();

    const tokens = renderedNumberTokens(screen.getByRole('main'));
    const fixtureText = readFileSync(path.join(fixturesDir, 'review-9035042364-pudge-zh.json'), 'utf8');
    for (const token of tokens) {
      expect(fixtureText, `rendered number "${token}" must exist in the fixture`).toContain(token);
    }
  });
});

describe('MatchPage — hero flow', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the hero picker without ?hero; picking Pudge requests heroId=14', async () => {
    stubFetch({ base: enFixture, hero: pudgeEn });
    renderPage('/m/9035042364');

    expect(await screen.findByText('Which one was you?')).toBeTruthy();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/review/9035042364?lang=en');

    fireEvent.click(screen.getByRole('button', { name: 'Pudge, 5/19/22' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/review/9035042364?lang=en&heroId=14',
        expect.objectContaining({ method: 'GET' }),
      );
    });
    expect(await screen.findByText(pudgeEn.threeConclusions.turningPoint.summary)).toBeTruthy();
  });

  it('renders the insufficient badge on insufficient conclusions', async () => {
    stubFetch({ base: enFixture, hero: enFixture }); // no-hero payload: topMistake/nextGameRule insufficient
    renderPage('/m/9035042364?hero=pudge');

    expect(await screen.findAllByText('Insufficient data')).toHaveLength(2);
  });
});

describe('MatchPage — follow-ups', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.mocked(trackEvent).mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('clicking a preset chip streams the SSE answer and tracks followup_clicked', async () => {
    stubFetch({
      base: enFixture,
      hero: pudgeEn,
      post: [{ text: 'Wraith King ' }, { text: 'killed you ' }, { text: '8 times.' }],
    });
    renderPage('/m/9035042364?hero=pudge');
    await screen.findByText(pudgeEn.threeConclusions.turningPoint.summary);

    const chip = pudgeEn.threeConclusions.followUps[0];
    fireEvent.click(await screen.findByRole('button', { name: chip }));

    expect(trackEvent).toHaveBeenCalledWith('followup_clicked', { kind: 'preset' });
    await screen.findByText(/8 times\./);
    // The asked chip is removed from the suggestions.
    await waitFor(() => expect(screen.queryByRole('button', { name: chip })).toBeNull());
  });

  it('hard-slices a follow-up to 2000 chars before sending', async () => {
    stubFetch({ base: enFixture, hero: pudgeEn, post: [{ text: 'ok' }] });
    renderPage('/m/9035042364?hero=pudge');
    await screen.findByText(pudgeEn.threeConclusions.turningPoint.summary);

    // fireEvent.change bypasses the input's maxLength, like a programmatic
    // paste would — the page must still cap what goes on the wire.
    fireEvent.change(screen.getByPlaceholderText('Ask a follow-up about this match'), {
      target: { value: 'y'.repeat(2500) },
    });
    fireEvent.submit(screen.getByPlaceholderText('Ask a follow-up about this match').closest('form')!);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => (init as { method?: string } | undefined)?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as { body: string }).body).followUp).toHaveLength(2000);
    });
  });
});

describe('MatchPage — 429 rate limiting', () => {
  /** Fake timers mean findByText/waitFor would hang — flush microtasks instead. */
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
    });
  };

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('facts 429: countdown message, Retry + composer disabled until it elapses', async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => Promise.resolve(rateLimitResponse(30)));
    vi.stubGlobal('fetch', fetchMock);
    renderPage('/m/9035042364');

    await flush();
    expect(screen.getByText('Too many requests right now. Try again in 30s.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByPlaceholderText('Paste match ID or link') as HTMLInputElement).disabled,
    ).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByText('Too many requests right now. Try again in 20s.')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(screen.getByText('Too many requests right now. Try again in a moment.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false);
    expect(
      (screen.getByPlaceholderText('Paste match ID or link') as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it('follow-up 429: countdown in the turn, chips / composer / Retry disabled, then released', async () => {
    stubFetch({ base: enFixture, hero: pudgeEn, postResponse: rateLimitResponse(30) });
    renderPage('/m/9035042364?hero=pudge');

    await flush();
    const chip = pudgeEn.threeConclusions.followUps[0];
    fireEvent.click(screen.getByRole('button', { name: chip }));
    await flush();

    expect(screen.getByText('Too many requests right now. Try again in 30s.')).toBeTruthy();
    const otherChip = screen.getByRole('button', {
      name: pudgeEn.threeConclusions.followUps[1],
    }) as HTMLButtonElement;
    expect(otherChip.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByPlaceholderText('Ask a follow-up about this match') as HTMLInputElement).disabled,
    ).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByText('Too many requests right now. Try again in a moment.')).toBeTruthy();
    expect(otherChip.disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement).disabled).toBe(false);
    expect(
      (screen.getByPlaceholderText('Ask a follow-up about this match') as HTMLInputElement).disabled,
    ).toBe(false);
  });
});
