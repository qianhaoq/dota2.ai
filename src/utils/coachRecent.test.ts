import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoachRouter } from '../../lib/coach/router.js';
import { createRecentService, parseAccountId, seatOf, shapeRecent } from '../../lib/coach/recent.js';

const express = createRequire(import.meta.url)('express');
const row = (o: Record<string, unknown> = {}) => ({
  match_id: 9096792210, player_slot: 130, radiant_win: true, hero_id: 44, start_time: 1795000000, duration: 2549,
  game_mode: 22, lobby_type: 7, kills: 7, deaths: 5, assists: 23, ...o,
});

describe('recent games', () => {
  it('validates friend codes', () => {
    expect(parseAccountId('86745912')).toBe(86745912);
    for (const bad of ['0', '012', '4294967296', 'x', '76561198047011640']) expect(parseAccountId(bad), bad).toBeNull();
  });

  it('maps OpenDota player slots to the coach seats', () => {
    expect([0, 4, 128, 132].map(seatOf)).toEqual([0, 4, 5, 9]);
  });

  it('shapes rows for the picker: seat, side, result, hero, mode', () => {
    const r = shapeRecent(1, [row(), row({ match_id: 2, player_slot: 1, radiant_win: true }), { bogus: true }]);
    expect(r.matches).toHaveLength(2);
    expect(r.matches[0]).toMatchObject({ match_id: 9096792210, slot: 7, radiant: false, won: false, kda: [7, 5, 23], ranked: true, mode: { en: 'All Pick' }, hero: { id: 44, en: 'Phantom Assassin' } });
    expect(r.matches[1]).toMatchObject({ slot: 1, radiant: true, won: true });
    expect(r.empty_hint).toBeNull();
    expect(shapeRecent(1, []).empty_hint).toBe('private_or_no_matches');
  });

  it('caches for a minute, shares one in-flight fetch, never caches failures', async () => {
    let t = 0;
    const fetchRecent = vi.fn(async () => [row()]);
    const svc = createRecentService({ fetchRecent, now: () => t });
    await Promise.all([svc.get(1), svc.get(1)]);
    expect(fetchRecent).toHaveBeenCalledTimes(1);
    t = 61_000;
    await svc.get(1);
    expect(fetchRecent).toHaveBeenCalledTimes(2);
    const failing = createRecentService({ fetchRecent: vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue([row()]) });
    await expect(failing.get(2)).rejects.toThrow('down');
    await expect(failing.get(2)).resolves.toMatchObject({ matches: [{ match_id: 9096792210 }] });
  });
});

describe('GET /api/coach/players/:accountId/recent', () => {
  let server: Server | null = null;
  afterEach(() => { server?.close(); server = null; });
  async function start(recent: object, limited = false) {
    const app = express();
    app.use(createCoachRouter({
      getMatchDetail: async () => ({}),
      resolveClientIp: () => '1.2.3.4',
      mapError: (e: unknown) => ({ status: (e as { status?: number })?.status === 404 ? 404 : 502, body: { error: 'x' } }),
      limiter: { tryConsume: () => ({ ok: !limited, retryAfterSec: 3 }) },
      recent: recent as never,
    }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server!.once('listening', r));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  it('returns the shaped list, rejects bad ids, rate-limits and maps upstream errors', async () => {
    const svc = createRecentService({ fetchRecent: async () => [row()] });
    let base = await start(svc);
    const res = await fetch(`${base}/api/coach/players/86745912/recent`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=60');
    expect((await res.json()).matches[0].slot).toBe(7);
    expect((await fetch(`${base}/api/coach/players/76561198047011640/recent`)).status).toBe(400);
    server?.close();
    base = await start(svc, true);
    expect((await fetch(`${base}/api/coach/players/86745912/recent`)).status).toBe(429);
    server?.close();
    base = await start({ get: async () => { throw new Error('down'); } });
    expect((await fetch(`${base}/api/coach/players/86745912/recent`)).status).toBe(502);
  });
});
