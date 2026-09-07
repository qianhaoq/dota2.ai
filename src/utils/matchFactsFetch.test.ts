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

    const fact = await fetchMatchFacts(8985182860, 'zh');
    expect(fact.summary.matchId).toBe(8985182860);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/review/8985182860?lang=zh');
    expect(init.method).toBe('GET');
    expect(init.headers.Accept).toBe('application/json');
    expect(init.headers.Accept).not.toContain('text/event-stream');
  });

  it('surfaces server error text', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: '找不到这场比赛' }),
    });
    await expect(fetchMatchFacts(1, 'zh')).rejects.toThrow('找不到这场比赛');
  });
});
