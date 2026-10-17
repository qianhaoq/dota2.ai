import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMatchFacts, requestMatchParse } from '../services/dotaApiService';

describe('fetchMatchFacts', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs /api/review/:id without starting an SSE stream', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        matchFact: { summary: { matchId: 8985182860 }, players: [{ heroId: 54 }] },
        grounded: true,
      }),
    });

    const { matchFact: fact, parse } = await fetchMatchFacts(8985182860, 'zh');
    expect(fact.summary.matchId).toBe(8985182860);
    expect(parse).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/review/8985182860?lang=zh');
    expect(init.method).toBe('GET');
    expect(init.headers.Accept).toBe('application/json');
    expect(init.headers.Accept).not.toContain('text/event-stream');
  });

  it('threads the parse status out of the JSON body', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        matchFact: { summary: { matchId: 9035042364 }, players: [] },
        grounded: false,
        parse: {
          status: 'throttled',
          jobId: null,
          retryAfterSec: 300,
          message: 'OpenDota parse requests are rate-limited',
        },
      }),
    });

    const { parse } = await fetchMatchFacts(9035042364, 'en');
    expect(parse).toEqual({
      status: 'throttled',
      jobId: null,
      retryAfterSec: 300,
      message: 'OpenDota parse requests are rate-limited',
    });
  });

  it('ignores malformed parse status payloads', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        matchFact: { summary: { matchId: 9035042364 }, players: [] },
        parse: { status: 'mystery', jobId: 'nope' },
      }),
    });

    const { parse } = await fetchMatchFacts(9035042364, 'en');
    expect(parse).toBeNull();
  });

  it('surfaces server error text', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: '找不到这场比赛' }),
    });
    await expect(fetchMatchFacts(1, 'zh')).rejects.toThrow('找不到这场比赛');
  });

  it('429 without a Retry-After header: falls back to the body retryAfter (production field name)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: 'rate_limited', message: 'Too many requests', retryAfter: 30 }),
    });

    await expect(fetchMatchFacts(9035042364, 'en')).rejects.toMatchObject({
      name: 'MatchFactsError',
      status: 429,
      retryAfterSec: 30,
    });
  });

  it('appends the request-time heroId so the fact keeps its focus lens', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ matchFact: { summary: { matchId: 9035042364 }, focusHeroId: 74 } }),
    });

    await fetchMatchFacts(9035042364, 'en', undefined, 74);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/review/9035042364?lang=en&heroId=74');
  });

  it('forwards the abort signal so callers can cancel a stale retry', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ matchFact: { summary: { matchId: 9035042364 } } }),
    });

    const controller = new AbortController();
    await fetchMatchFacts(9035042364, 'en', controller.signal);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBe(controller.signal);
  });

  it('threads an unparsed read-only status (facts load never submits)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        matchFact: { summary: { matchId: 9035042364 }, players: [] },
        parse: {
          status: 'unparsed',
          jobId: null,
          retryAfterSec: null,
          message: 'Replay data is not parsed yet — you can request a parse',
        },
      }),
    });

    const { parse } = await fetchMatchFacts(9035042364, 'en');
    expect(parse).toEqual({
      status: 'unparsed',
      jobId: null,
      retryAfterSec: null,
      message: 'Replay data is not parsed yet — you can request a parse',
    });
    // Only the facts GET happened — no parse submission from a facts load.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe('GET');
  });
});

describe('requestMatchParse', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the explicit parse-request endpoint with CSRF-safe headers', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'requested',
        jobId: 42,
        retryAfterSec: 120,
        message: 'Parse requested from OpenDota — retry in ~120s',
      }),
    });

    const parse = await requestMatchParse(9035042364, 'zh');
    expect(parse).toEqual({
      status: 'requested',
      jobId: 42,
      retryAfterSec: 120,
      message: 'Parse requested from OpenDota — retry in ~120s',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/review/9035042364/parse-request?lang=zh');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['X-Requested-With']).toBe('XMLHttpRequest');
  });

  it('returns throttled/cooldown payloads as-is (they are decisions, not errors)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'throttled',
        jobId: null,
        retryAfterSec: 300,
        message: 'Parse request limit reached — try again in ~300s',
      }),
    });

    const parse = await requestMatchParse(9035042364, 'en');
    expect(parse.status).toBe('throttled');
    expect(parse.retryAfterSec).toBe(300);
  });

  it('throws the server error text for non-parse error bodies', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: '找不到这场比赛' }),
    });

    await expect(requestMatchParse(1, 'zh')).rejects.toThrow('找不到这场比赛');
  });

  it('forwards the abort signal so callers can cancel', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'pending', jobId: 1, retryAfterSec: 60, message: 'parsing' }),
    });

    const controller = new AbortController();
    await requestMatchParse(9035042364, 'en', controller.signal);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBe(controller.signal);
  });
});
