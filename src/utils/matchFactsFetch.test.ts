import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMatchFacts } from '../services/dotaApiService';

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
});
