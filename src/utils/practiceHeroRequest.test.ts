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
