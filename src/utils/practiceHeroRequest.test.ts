import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Attribute, Hero } from '../types';
import { analyzeDraftStream, fetchPlaybookStream, fetchSuggestions } from '../services/geminiService';
import { buildPracticeUserContext, resolveCoachingLineup } from './practiceContext';

const invoker: Hero = {
  id: 74,
  name: 'Invoker',
  nameZh: '祈求者',
  nameEn: 'Invoker',
  attribute: Attribute.INTELLIGENCE,
  img: '',
};

function parseBody(call: unknown[]): Record<string, unknown> {
  const init = call[1] as { body: string };
  return JSON.parse(init.body);
}

describe('practice hero request payloads', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('analyze posts seeded practice hero and userContext', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'no key' }),
    });

    const lineup = resolveCoachingLineup({ radiant: [], dire: [] }, 'radiant', invoker);
    const userContext = buildPracticeUserContext(invoker, 'zh', `分析练习英雄 ${invoker.nameZh}`);

    await new Promise<void>((resolve) => {
      analyzeDraftStream(lineup.radiant, lineup.dire, 'zh', userContext, {
        onChunk: () => {},
        onComplete: () => resolve(),
        onError: () => resolve(),
      });
    });

    const body = parseBody(fetchMock.mock.calls[0]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/analyze');
    expect((body.radiant as Hero[])[0].id).toBe(74);
    expect(body.userContext).toContain('练习英雄：祈求者');
    expect(body.userContext).toContain('分析练习英雄 祈求者');
  });

  it('playbook posts seeded allies and focusHeroId', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'no key' }),
    });

    const lineup = resolveCoachingLineup({ radiant: [], dire: [] }, 'radiant', invoker);

    await new Promise<void>((resolve) => {
      fetchPlaybookStream(lineup.allies, lineup.enemies, 'radiant', 'zh', lineup.focusHeroId, {
        onData: () => {},
        onChunk: () => {},
        onComplete: () => resolve(),
        onError: () => resolve(),
      });
    });

    const body = parseBody(fetchMock.mock.calls[0]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/playbook');
    expect((body.allies as Hero[])[0].id).toBe(74);
    expect(body.focusHeroId).toBe(74);
  });

  it('suggest posts seeded allies', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: [] }),
    });

    const lineup = resolveCoachingLineup({ radiant: [], dire: [] }, 'radiant', invoker);
    await fetchSuggestions(lineup.allies, lineup.enemies, 'radiant', undefined, 'zh');

    const body = parseBody(fetchMock.mock.calls[0]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/suggestions');
    expect((body.allies as Hero[])[0].id).toBe(74);
  });
});

describe('fetchSuggestions error surfacing (QA P2: 429 shows the server message)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects with the server-localized rate-limit message on 429 (zh)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({
        error: 'rate_limited',
        message: '请求过于频繁，请约 42 秒后再试',
        retryAfter: 42,
      }),
    });

    await expect(
      fetchSuggestions([], [], 'radiant', undefined, 'zh'),
    ).rejects.toThrow('请求过于频繁，请约 42 秒后再试');
  });

  it('rejects with the server-localized rate-limit message on 429 (en)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({
        error: 'rate_limited',
        message: 'Too many requests, please retry in about 42s',
        retryAfter: 42,
      }),
    });

    await expect(
      fetchSuggestions([], [], 'radiant', undefined, 'en'),
    ).rejects.toThrow('Too many requests, please retry in about 42s');
  });

  it('still returns an empty list for network failures (old behavior)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(fetchSuggestions([], [], 'radiant', undefined, 'en')).resolves.toEqual([]);
  });
});
