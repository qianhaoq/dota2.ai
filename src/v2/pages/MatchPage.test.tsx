// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import MatchPage from './MatchPage';
import { I18nProvider } from '../i18n/I18nProvider';
import { trackEvent, trackReviewViewed } from '../../services/analytics';
import { REVIEW_CLIENT_TIMEOUT_MS } from '../../services/geminiService';

vi.mock('../../services/analytics', () => ({
  trackEvent: vi.fn(),
  trackReviewViewed: vi.fn(),
}));

// Partial mock: the page must honor the resolved flags without caring how
// they were resolved (flags.test.ts covers env/preview kill switches).
const flagState = { fakedoor_v2: true };
vi.mock('../FlagsProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../FlagsProvider')>();
  return {
    ...actual,
    useFlags: () => ({
      ui_v2: true,
      legacy_mentor: false,
      legacy_tabs: false,
      legacy_next_actions: false,
      fakedoor_v2: flagState.fakedoor_v2,
    }),
  };
});

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * SSE response whose chunks are released manually — models an in-flight
 * follow-up stream that stays pending until the test pushes the next chunk.
 */
function gatedSseResponse() {
  let releaseRead: ((r: { done: boolean; value?: Uint8Array }) => void) | null = null;
  const encode = (payload: string) => Uint8Array.from(payload, (c) => c.charCodeAt(0));
  return {
    response: {
      ok: true,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
      body: {
        getReader: () => ({
          read: () =>
            new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
              releaseRead = resolve;
            }),
          cancel: async () => {},
        }),
      },
    },
    /** Push one SSE data event; the mock fetch ignores the abort signal, so
     * chunks pushed after an abort exercise the page's stale-callback guard. */
    push: (obj: unknown) => {
      releaseRead?.({ done: false, value: encode(`data: ${JSON.stringify(obj)}\n\n`) });
      releaseRead = null;
    },
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

/** Test-only navigation control: clicking it routes elsewhere while the page
 * stays mounted (mirrors App.tsx, where /m/:matchId and /m share MatchPage). */
const JumpButton: React.FC<{ to: string }> = ({ to }) => {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      jump
    </button>
  );
};

function renderPage(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <I18nProvider>
        <JumpButton to="/m" />
        <Routes>
          <Route path="/m/:matchId" element={<MatchPage />} />
          <Route path="/m" element={<MatchPage />} />
        </Routes>
      </I18nProvider>
    </MemoryRouter>,
  );
}

const CONCLUSION_KEYS = ['turningPoint', 'topMistake', 'nextGameRule'] as const;

/** Flush pending microtasks so SSE chunks / fetch promises settle. */
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};

const postCall = () =>
  fetchMock.mock.calls.find(([, init]) => (init as { method?: string } | undefined)?.method === 'POST');

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

describe('MatchPage — fakedoor card flag', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    flagState.fakedoor_v2 = true;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the fakedoor card when fakedoor_v2 is on (MVP default)', async () => {
    stubFetch({ base: enFixture, hero: pudgeEn });
    renderPage('/m/9035042364?hero=pudge');
    await screen.findByText(pudgeEn.threeConclusions.turningPoint.summary);

    expect(screen.getByText('Want this after every match?')).toBeTruthy();
  });

  it('hides the fakedoor card when the flag is off (kill switch)', async () => {
    flagState.fakedoor_v2 = false;
    stubFetch({ base: enFixture, hero: pudgeEn });
    renderPage('/m/9035042364?hero=pudge');
    await screen.findByText(pudgeEn.threeConclusions.turningPoint.summary);

    expect(screen.queryByText('Want this after every match?')).toBeNull();
  });
});

describe('MatchPage — hero change aborts the follow-up stream', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    flagState.fakedoor_v2 = true;
    vi.mocked(trackEvent).mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('aborts the in-flight stream before clearing turns; stale chunks never land', async () => {
    const stream = gatedSseResponse();
    stubFetch({ base: enFixture, hero: pudgeEn, postResponse: stream.response });
    renderPage('/m/9035042364?hero=pudge');
    await screen.findByText(pudgeEn.threeConclusions.turningPoint.summary);

    // Start a follow-up and let its first chunk stream in.
    const chip = pudgeEn.threeConclusions.followUps[0];
    fireEvent.click(screen.getByRole('button', { name: chip }));
    await flush();
    stream.push({ text: 'FIRST CHUNK ' });
    expect(await screen.findByText(/FIRST CHUNK/)).toBeTruthy();
    expect((postCall()![1] as { signal: AbortSignal }).signal.aborted).toBe(false);

    // Change hero while the stream is still in flight.
    fireEvent.click(screen.getByRole('button', { name: /Change/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Faceless Void, 13/14/12' }));

    // The in-flight request was aborted before the turns were cleared…
    await waitFor(() => expect((postCall()![1] as { signal: AbortSignal }).signal.aborted).toBe(true));
    // …the old thread is gone (the streamed answer; the chip itself may
    // legitimately reappear as a preset now that `asked` was reset)…
    expect(screen.queryByText(/FIRST CHUNK/)).toBeNull();
    // …and the composer is released (no turn stuck streaming).
    await waitFor(() =>
      expect((screen.getByPlaceholderText('Ask a follow-up about this match') as HTMLInputElement).disabled).toBe(false),
    );

    // A chunk arriving after the abort (the fetch mock ignores the signal) is
    // dropped — no stale text is appended to the new thread.
    stream.push({ text: 'STALE CHUNK' });
    await flush();
    expect(screen.queryByText(/STALE CHUNK/)).toBeNull();
  });
});

describe('MatchPage — review_viewed tracking', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    flagState.fakedoor_v2 = true;
    vi.mocked(trackReviewViewed).mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('tracks review_viewed once the conclusion cards render', async () => {
    stubFetch({ base: enFixture, hero: pudgeEn });
    renderPage('/m/9035042364?hero=pudge');
    await screen.findByText(pudgeEn.threeConclusions.turningPoint.summary);

    expect(trackReviewViewed).toHaveBeenCalledWith('9035042364');
  });

  it('does not track when threeConclusions is null (no cards rendered)', async () => {
    stubFetch({ base: enFixture, hero: { ...pudgeEn, threeConclusions: null } });
    renderPage('/m/9035042364?hero=pudge');
    await screen.findByText('The three conclusions aren’t available for this match yet.');

    expect(trackReviewViewed).not.toHaveBeenCalled();
  });
});

describe('MatchPage — initial-load progress', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    flagState.fakedoor_v2 = true;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the tool trace while the FIRST facts request is still pending', async () => {
    const firstFacts = deferred<unknown>();
    fetchMock.mockReset();
    fetchMock.mockImplementation((input: unknown, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'POST') return Promise.resolve(sseResponse([]));
      const url = new URL(String(input), 'http://local.test');
      if (url.searchParams.has('heroId')) return Promise.resolve(jsonResponse(pudgeEn));
      return firstFacts.promise.then((payload) => jsonResponse(payload));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPage('/m/9035042364?hero=pudge');

    // facts === null + phase === 'loading' → the trace must already be visible.
    expect(await screen.findByText('Fetching match')).toBeTruthy();
    expect(screen.queryByText('Analyzed match · OpenDota')).toBeNull();

    await act(async () => {
      firstFacts.resolve(enFixture);
    });
    expect(await screen.findByText(pudgeEn.threeConclusions.turningPoint.summary)).toBeTruthy();
    expect(screen.getByText('Analyzed match · OpenDota')).toBeTruthy();
  });
});

describe('MatchPage — route change to /m aborts the follow-up stream', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    flagState.fakedoor_v2 = true;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('navigating to bare /m mid-stream aborts and clears the conversation', async () => {
    const stream = gatedSseResponse();
    stubFetch({ base: enFixture, hero: pudgeEn, postResponse: stream.response });
    renderPage('/m/9035042364?hero=pudge');
    await screen.findByText(pudgeEn.threeConclusions.turningPoint.summary);

    // Start a follow-up and let its first chunk stream in.
    const chip = pudgeEn.threeConclusions.followUps[0];
    fireEvent.click(screen.getByRole('button', { name: chip }));
    await flush();
    stream.push({ text: 'FIRST CHUNK ' });
    expect(await screen.findByText(/FIRST CHUNK/)).toBeTruthy();
    expect((postCall()![1] as { signal: AbortSignal }).signal.aborted).toBe(false);

    // Route to bare /m while the stream is still in flight.
    fireEvent.click(screen.getByRole('button', { name: 'jump' }));

    // The in-flight request was aborted, the invalid-id notice rendered, and
    // the conversation is gone…
    await waitFor(() => expect((postCall()![1] as { signal: AbortSignal }).signal.aborted).toBe(true));
    expect(await screen.findByText(/doesn’t look like a match ID/)).toBeTruthy();
    expect(screen.queryByText(/FIRST CHUNK/)).toBeNull();

    // …and a chunk arriving after the abort (the fetch mock ignores the
    // signal) is dropped — no stale text lands anywhere.
    stream.push({ text: 'STALE CHUNK' });
    await flush();
    expect(screen.queryByText(/STALE CHUNK/)).toBeNull();
  });
});

describe('MatchPage — partial threeConclusions payload', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders a missing conclusion as an Insufficient data card instead of crashing', async () => {
    const partial = {
      ...pudgeEn,
      threeConclusions: {
        outcome: pudgeEn.threeConclusions.outcome,
        turningPoint: pudgeEn.threeConclusions.turningPoint,
        nextGameRule: pudgeEn.threeConclusions.nextGameRule,
      },
    };
    stubFetch({ base: enFixture, hero: partial });
    renderPage('/m/9035042364?hero=pudge');

    // Present conclusions render verbatim…
    expect(await screen.findByText(pudgeEn.threeConclusions.turningPoint.summary)).toBeTruthy();
    expect(screen.getByText(pudgeEn.threeConclusions.nextGameRule.summary)).toBeTruthy();
    // …the missing topMistake becomes an explicit insufficient card (muted
    // summary + badge)…
    expect(screen.getByText('One thing to change')).toBeTruthy();
    expect(await screen.findAllByText('Insufficient data')).toHaveLength(2);
    // …and the absent followUps default to [] — no preset chips.
    expect(screen.queryByRole('button', { name: pudgeEn.threeConclusions.followUps[0] })).toBeNull();
  });
});

describe('MatchPage — follow-up reviewNotice / fallback (server PR #89)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const askViaComposer = (question: string) => {
    fireEvent.change(screen.getByPlaceholderText('Ask a follow-up about this match'), {
      target: { value: question },
    });
    fireEvent.submit(screen.getByPlaceholderText('Ask a follow-up about this match').closest('form')!);
  };

  it('renders the template text normally with the notice as a muted line under it', async () => {
    stubFetch({
      base: enFixture,
      hero: pudgeEn,
      post: [
        { reviewNotice: 'AI follow-up unavailable; the answer below is built from match data only.', fallback: true },
        { text: 'Deterministic answer from match data.' },
      ],
    });
    renderPage('/m/9035042364?hero=pudge');
    await screen.findByText(pudgeEn.threeConclusions.turningPoint.summary);

    askViaComposer('What went wrong?');

    expect(await screen.findByText('Deterministic answer from match data.')).toBeTruthy();
    expect(screen.getByText('AI follow-up unavailable; the answer below is built from match data only.')).toBeTruthy();
    // The notice is a muted line, not an error state.
    expect(screen.queryByText('Could not answer that.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('accepts the notice as an object ({ message }) too', async () => {
    stubFetch({
      base: enFixture,
      hero: pudgeEn,
      post: [
        { reviewNotice: { message: 'AI follow-up unavailable (object form).' }, fallback: true },
        { text: 'Body.' },
      ],
    });
    renderPage('/m/9035042364?hero=pudge');
    await screen.findByText(pudgeEn.threeConclusions.turningPoint.summary);

    askViaComposer('What went wrong?');

    expect(await screen.findByText('Body.')).toBeTruthy();
    expect(screen.getByText('AI follow-up unavailable (object form).')).toBeTruthy();
  });
});

describe('MatchPage — 400 message_too_long (server PR #89)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the localized server message inline (no "Error:" prefix) and keeps the text', async () => {
    stubFetch({
      base: enFixture,
      hero: pudgeEn,
      postResponse: {
        ok: false,
        status: 400,
        headers: { get: () => null },
        json: async () => ({ error: 'message_too_long', message: 'Error: Follow-ups are limited to 2000 characters.' }),
      },
    });
    renderPage('/m/9035042364?hero=pudge');
    await screen.findByText(pudgeEn.threeConclusions.turningPoint.summary);

    fireEvent.change(screen.getByPlaceholderText('Ask a follow-up about this match'), {
      target: { value: 'A question that is too long' },
    });
    fireEvent.submit(screen.getByPlaceholderText('Ask a follow-up about this match').closest('form')!);

    // Friendly inline message — server copy without the "Error:" prefix…
    expect(await screen.findByText('Follow-ups are limited to 2000 characters.')).toBeTruthy();
    expect(screen.queryByText(/Error:/)).toBeNull();
    expect(screen.queryByText('Could not answer that.')).toBeNull();
    // …and the user's text is back in the composer so they can shorten it.
    await waitFor(() =>
      expect((screen.getByPlaceholderText('Ask a follow-up about this match') as HTMLInputElement).value).toBe(
        'A question that is too long',
      ),
    );
    expect(
      (screen.getByPlaceholderText('Ask a follow-up about this match') as HTMLInputElement).disabled,
    ).toBe(false);
  });
});

/**
 * POST mock whose pending SSE read rejects with an AbortError when the page
 * aborts the request's signal — like a real aborted fetch/SSE. The service's
 * internal 180s timeout and the user's Stop button both call the same
 * controller.abort(); only the page's userStoppedRef tells them apart.
 */
function abortableGatedSse() {
  let releaseRead: ((r: { done: boolean; value?: Uint8Array }) => void) | null = null;
  let rejectRead: ((e: unknown) => void) | null = null;
  const encode = (payload: string) => Uint8Array.from(payload, (c) => c.charCodeAt(0));
  const wireAbort = (signal: AbortSignal) =>
    signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      rejectRead?.(err);
    });
  return {
    wireAbort,
    push: (obj: unknown) => {
      releaseRead?.({ done: false, value: encode(`data: ${JSON.stringify(obj)}\n\n`) });
      releaseRead = null;
      rejectRead = null;
    },
    response: {
      ok: true,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
      body: {
        getReader: () => ({
          read: () =>
            new Promise<{ done: boolean; value?: Uint8Array }>((resolve, reject) => {
              releaseRead = resolve;
              rejectRead = reject;
            }),
          cancel: async () => {},
        }),
      },
    },
  };
}

describe('MatchPage — user Stop vs service timeout', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** POST mock wiring: the gated SSE read rejects with an AbortError once the
   * page aborts the request's signal, like a real aborted fetch/SSE. */
  const stubAbortableStream = (stream: ReturnType<typeof abortableGatedSse>) => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((input: unknown, init?: { method?: string; signal?: AbortSignal }) => {
      if ((init?.method ?? 'GET') === 'POST') {
        stream.wireAbort(init!.signal!);
        return Promise.resolve(stream.response);
      }
      const url = new URL(String(input), 'http://local.test');
      const lang = url.searchParams.get('lang') === 'zh' ? 'zh' : 'en';
      if (url.searchParams.has('heroId')) return Promise.resolve(jsonResponse(pudgeEn));
      return Promise.resolve(jsonResponse(lang === 'zh' ? zhFixture : enFixture));
    });
    vi.stubGlobal('fetch', fetchMock);
  };

  it('a service-side timeout abort (no Stop) keeps the turn in error state with Retry', async () => {
    // Fake timers so the service's OWN REVIEW_CLIENT_TIMEOUT_MS timer fires —
    // the exact path production hits (controller.abort() from inside the
    // service, with no user Stop behind it).
    vi.useFakeTimers();
    const flushTimers = async () => {
      await act(async () => {
        for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
      });
    };
    const stream = abortableGatedSse();
    stubAbortableStream(stream);
    renderPage('/m/9035042364?hero=pudge');
    await flushTimers();

    fireEvent.click(screen.getByRole('button', { name: pudgeEn.threeConclusions.followUps[0] }));
    await flushTimers();
    stream.push({ text: 'PARTIAL ANSWER ' });
    await flushTimers();
    expect(screen.getByText(/PARTIAL ANSWER/)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REVIEW_CLIENT_TIMEOUT_MS);
    });

    // The turn errored (not silently "done"): generic copy + Retry offered,
    // the composer is released.
    expect(screen.getByText('Could not answer that.')).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    expect(
      (screen.getByPlaceholderText('Ask a follow-up about this match') as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it('the user\'s Stop settles the turn with its partial answer, no error shown', async () => {
    const stream = abortableGatedSse();
    stubAbortableStream(stream);
    renderPage('/m/9035042364?hero=pudge');
    await screen.findByText(pudgeEn.threeConclusions.turningPoint.summary);

    fireEvent.click(screen.getByRole('button', { name: pudgeEn.threeConclusions.followUps[0] }));
    await flush();
    stream.push({ text: 'PARTIAL ANSWER ' });
    expect(await screen.findByText(/PARTIAL ANSWER/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await flush();

    expect(screen.queryByText('Could not answer that.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    // The partial answer stays visible and the composer is released.
    expect(screen.getByText(/PARTIAL ANSWER/)).toBeTruthy();
    expect(
      (screen.getByPlaceholderText('Ask a follow-up about this match') as HTMLInputElement).disabled,
    ).toBe(false);
  });
});

describe('MatchPage — tool trace done state', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('never claims "Analyzed" over a failed hero-scoped request', async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((input: unknown, init?: { method?: string }) => {
      if ((init?.method ?? 'GET') === 'POST') return Promise.resolve(sseResponse([]));
      const url = new URL(String(input), 'http://local.test');
      if (url.searchParams.has('heroId')) return Promise.reject(new Error('upstream boom'));
      return Promise.resolve(jsonResponse(enFixture));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPage('/m/9035042364?hero=pudge');

    expect(await screen.findByText('upstream boom')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    // The trace is still expanded (steps, not a checkmark) — the request
    // failed, so "Analyzed match · OpenDota" would be a lie.
    expect(screen.queryByText('Analyzed match · OpenDota')).toBeNull();
    expect(screen.getByText('Fetching match')).toBeTruthy();
  });

  it('claims "Analyzed" once results render', async () => {
    stubFetch({ base: enFixture, hero: pudgeEn });
    renderPage('/m/9035042364?hero=pudge');

    await screen.findByText(pudgeEn.threeConclusions.turningPoint.summary);
    expect(screen.getByText('Analyzed match · OpenDota')).toBeTruthy();
  });

  it('claims "Analyzed" when the picker is deliberately shown (no ?hero)', async () => {
    stubFetch({ base: enFixture, hero: pudgeEn });
    renderPage('/m/9035042364');

    expect(await screen.findByText('Which one was you?')).toBeTruthy();
    expect(screen.getByText('Analyzed match · OpenDota')).toBeTruthy();
  });
});
