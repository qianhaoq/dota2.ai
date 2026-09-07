import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchReviewSuggestions } from '../services/dotaApiService';

describe('fetchReviewSuggestions', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs /api/review/suggestions and returns grouped matches', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        recent: [{ matchId: 8987146774, kind: 'recent' }],
        highMmr: [{ matchId: 8987197531, kind: 'highMmr' }],
        count: 2,
        source: 'opendota',
        cacheAge: 12,
      }),
    });

    const data = await fetchReviewSuggestions('zh', 6);
    expect(data.recent).toHaveLength(1);
    expect(data.highMmr).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/review/suggestions?lang=zh&limit=6');
  });

  it('soft-fails with empty lists on network error', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const data = await fetchReviewSuggestions('en', 6);
    expect(data.recent).toEqual([]);
    expect(data.highMmr).toEqual([]);
    expect(data.source).toBe('error');
    expect(data.error).toBeTruthy();
  });
});
