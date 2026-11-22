import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildCoachReport } from '../../lib/coach/analyze.js';
import { buildSurface } from '../../lib/coach/cards.js';
import { clearCardsCache, fetchCoachCards } from './api';

const report = buildCoachReport(JSON.parse(readFileSync(path.join(process.cwd(), 'src/fixtures/coach/match9091400302.parsed.json'), 'utf8'))) as any;
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
afterEach(() => { vi.unstubAllGlobals(); clearCardsCache(); });

describe('fetchCoachCards', () => {
  it('one request per match+seat per session (seat switching does not spend the rate limit)', async () => {
    const fetchMock = vi.fn(async () => ok(buildSurface(report, 0)));
    vi.stubGlobal('fetch', fetchMock);
    await fetchCoachCards('9091400302', 0);
    await fetchCoachCards('9091400302', 0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/coach/9091400302/cards?seat=0');
  });

  it('validates the payload: a wrong catalog is an error, never rendered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ catalog: 'dota-coach-ui/1', cards: [] })));
    await expect(fetchCoachCards('9091400302', 2)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('drops invalid cards and actions it cannot vouch for', async () => {
    const s = buildSurface(report, 0) as any;
    s.cards.push({ id: 'x', component: 'RawHtml', title: { en: 'x', zh: 'x' }, authority: 'fact', tone: 'neutral', data: {}, actions: [], evidence: [] });
    vi.stubGlobal('fetch', vi.fn(async () => ok(s)));
    const got = await fetchCoachCards('9091400302', 4);
    expect(got.cards.some((c) => c.component === 'RawHtml')).toBe(false);
  });

  it('failures are not cached: the next call retries', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({ code: 'upstream', error: 'down' }) })
      .mockResolvedValueOnce(ok(buildSurface(report, 0)));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchCoachCards('9091400302', 0)).rejects.toMatchObject({ status: 502 });
    await expect(fetchCoachCards('9091400302', 0)).resolves.toMatchObject({ slot: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
