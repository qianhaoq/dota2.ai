import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenDotaClient as create, endpointOf, redact, retryAfterMs, withKey } from '../../lib/upstream/opendota.js';

// Fakes stand in for fetch/Response; the JSDoc types expect the real ones.
const createOpenDotaClient = (o: any): any => create(o);

const BASE = 'https://api.opendota.com/api';
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});

afterEach(() => { vi.useRealTimers(); });

describe('opendota client helpers', () => {
  it('collapses ids per endpoint, redacts the query, parses Retry-After, adds the key once', () => {
    expect(endpointOf(`${BASE}/matches/9091400302`)).toBe('/matches/:id');
    expect(endpointOf(`${BASE}/players/123/recentMatches?x=1`)).toBe('/players/:id/recentMatches');
    expect(redact(`${BASE}/explorer?sql=1&api_key=secret`)).toBe(`${BASE}/explorer`);
    expect(retryAfterMs('7')).toBe(7000);
    expect(retryAfterMs(new Date(Date.now() + 5000).toUTCString(), Date.now())).toBeGreaterThan(3000);
    expect(retryAfterMs('soon')).toBeNull();
    expect(withKey(`${BASE}/matches/1`, 'k')).toBe(`${BASE}/matches/1?api_key=k`);
    expect(withKey(`${BASE}/explorer?sql=a`, 'k')).toBe(`${BASE}/explorer?sql=a&api_key=k`);
    expect(withKey(`${BASE}/matches/1?api_key=x`, 'k')).toBe(`${BASE}/matches/1?api_key=x`);
    expect(withKey(`${BASE}/matches/1`, '')).toBe(`${BASE}/matches/1`);
  });
});

describe('opendota client', () => {
  it('puts the key on every request and never in its logs or counters', async () => {
    const urls: string[] = [];
    const logs: string[] = [];
    const c = createOpenDotaClient({ apiKey: 'sekret', rpm: 6000, fetchImpl: async (u: string) => { urls.push(u); return json({ ok: 1 }, 500); }, sleep: async () => {}, log: (m: string) => logs.push(m) });
    await expect(c.getJson(`${BASE}/heroStats`, { retries: 1 })).rejects.toMatchObject({ status: 500, upstream: 'opendota', retryable: true });
    expect(urls).toHaveLength(2);
    for (const u of urls) expect(new URL(u).searchParams.get('api_key')).toBe('sekret');
    expect(logs.join('\n')).not.toContain('sekret');
    expect(JSON.stringify(c.snapshot())).not.toContain('sekret');
    expect(c.snapshot().keyed).toBe(true);
  });

  it('merges identical requests in flight into one upstream call', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const c = createOpenDotaClient({ rpm: 6000, fetchImpl: async () => { calls += 1; await gate; return json({ id: 1 }); } });
    const a = c.getJson(`${BASE}/matches/1`);
    const b = c.getJson(`${BASE}/matches/1`);
    release();
    expect(await a).toEqual({ id: 1 });
    expect(await b).toEqual({ id: 1 });
    expect(calls).toBe(1);
    expect(c.snapshot().merged).toBe(1);
  });

  it('a caller that aborts leaves the shared request running for the others', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const c = createOpenDotaClient({ rpm: 6000, fetchImpl: async () => { await gate; return json({ id: 2 }); } });
    const ac = new AbortController();
    const a = c.getJson(`${BASE}/matches/2`, { signal: ac.signal });
    const b = c.getJson(`${BASE}/matches/2`);
    ac.abort();
    await expect(a).rejects.toBeTruthy();
    release();
    expect(await b).toEqual({ id: 2 });
  });

  it('waits a short Retry-After in place, then succeeds', async () => {
    const waits: number[] = [];
    let n = 0;
    let t = 1_000_000;
    const c = createOpenDotaClient({
      rpm: 6000, now: () => t, sleep: async (ms: number) => { waits.push(ms); t += ms; },
      fetchImpl: async () => (n++ === 0 ? json({}, 429, { 'retry-after': '2' }) : json({ ok: true })),
    });
    expect(await c.getJson(`${BASE}/heroStats`)).toEqual({ ok: true });
    expect(waits).toEqual([2000]);
    expect(c.snapshot().rateLimited).toBe(1);
  });

  it('a long Retry-After fails fast and opens a cooldown that later calls respect', async () => {
    let calls = 0;
    let t = 1_000_000;
    const c = createOpenDotaClient({
      rpm: 6000, now: () => t, sleep: async () => {},
      fetchImpl: async () => { calls += 1; return json({}, 429, { 'retry-after': '60' }); },
    });
    await expect(c.getJson(`${BASE}/matches/3`)).rejects.toMatchObject({ status: 429, retryAfterSec: 60 });
    expect(calls).toBe(1);
    await expect(c.getJson(`${BASE}/matches/4`)).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(1); // no request during the cooldown
    expect(c.snapshot().cooldownRejects).toBe(1);
    t += 61_000;
    await expect(c.getJson(`${BASE}/matches/4`)).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(2);
  });

  it('a shared cooldown set elsewhere stops this instance too', async () => {
    let calls = 0;
    const shared = { until: Date.now() + 30_000, get() { return this.until; }, set(u: number) { this.until = Math.max(this.until, u); } };
    const c = createOpenDotaClient({ rpm: 6000, cooldown: shared, fetchImpl: async () => { calls += 1; return json({}); } });
    await expect(c.getJson(`${BASE}/heroStats`)).rejects.toMatchObject({ status: 429, upstream: 'opendota' });
    expect(calls).toBe(0);
  });

  it('does not retry a 404, and keeps it a 404 for the error mapper', async () => {
    let calls = 0;
    const c = createOpenDotaClient({ rpm: 6000, sleep: async () => {}, fetchImpl: async () => { calls += 1; return json({}, 404); } });
    await expect(c.getJson(`${BASE}/matches/5`, { retries: 3 })).rejects.toMatchObject({ status: 404, retryable: false, message: 'HTTP 404' });
    expect(calls).toBe(1);
  });

  it('serves waiting page requests before background work when the bucket is empty', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    // rpm 60 → capacity 6, one token a second.
    const c = createOpenDotaClient({ rpm: 60, maxQueueWaitMs: 60_000, fetchImpl: async (u: string) => { order.push(new URL(u).pathname); return json({}); } });
    const first = Array.from({ length: 6 }, (_, i) => c.getJson(`${BASE}/burst/${i}`));
    await Promise.all(first);
    const low = c.getJson(`${BASE}/explorer`, { priority: 'low' });
    const high = c.getJson(`${BASE}/matches/9`);
    await vi.advanceTimersByTimeAsync(0); // both reach the bucket
    expect(c.snapshot().queued).toEqual({ high: 1, low: 1 });
    await vi.advanceTimersByTimeAsync(1100);
    await high;
    expect(order.at(-1)).toBe('/api/matches/9');
    await vi.advanceTimersByTimeAsync(1100);
    await low;
    expect(order.at(-1)).toBe('/api/explorer');
  });

  it('records the remaining quota OpenDota reports', async () => {
    const c = createOpenDotaClient({ rpm: 6000, fetchImpl: async () => json({}, 200, { 'x-rate-limit-remaining-minute': '57', 'x-rate-limit-remaining-day': '2400' }) });
    await c.getJson(`${BASE}/heroStats`);
    const s = c.snapshot();
    expect(s.remaining.minute).toBe(57);
    expect(s.remaining.day).toBe(2400);
    expect(s.endpoints['/heroStats'].calls).toBe(1);
    expect(s.status['200']).toBe(1);
  });

  it('defaults to the anonymous budget without a key', () => {
    expect(createOpenDotaClient({}).snapshot().rpm).toBe(50);
    expect(createOpenDotaClient({ apiKey: 'k' }).snapshot().rpm).toBe(1200);
  });
  it('a request queued for a token re-checks the cooldown before sending', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const c = createOpenDotaClient({
      rpm: 60, maxQueueWaitMs: 60_000, sleep: async () => {},
      fetchImpl: async (u: string) => {
        const p = new URL(u).pathname; sent.push(p);
        if (p === '/api/slow') { await gate; return json({}, 429, { 'retry-after': '60' }); }
        return json({});
      },
    });
    const burst = Array.from({ length: 5 }, (_, i) => c.getJson(`${BASE}/b/${i}`));
    const slow = c.getJson(`${BASE}/slow`, { retries: 0 });
    await Promise.all(burst);
    const queued = c.getJson(`${BASE}/queued`, { retries: 0 }); // bucket empty: waits for a token
    await vi.advanceTimersByTimeAsync(0);
    release(); // the in-flight request gets a 429 → cooldown
    await expect(slow).rejects.toMatchObject({ status: 429 });
    const q = expect(queued).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(2000); // a token frees up
    await q;
    expect(sent).not.toContain('/api/queued');
  });

  it('retries a body that fails to read, and marks the final failure as upstream', async () => {
    let n = 0;
    const bad = { ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new SyntaxError('Unexpected end of JSON'); } };
    const c = createOpenDotaClient({ rpm: 6000, sleep: async () => {}, fetchImpl: async () => (n++ === 0 ? bad : json({ ok: 1 })) });
    expect(await c.getJson(`${BASE}/matches/6`)).toEqual({ ok: 1 });
    const always = createOpenDotaClient({ rpm: 6000, sleep: async () => {}, fetchImpl: async () => bad });
    await expect(always.getJson(`${BASE}/matches/7`, { retries: 1 })).rejects.toMatchObject({ upstream: 'opendota', retryable: true });
  });

  it('a 503 with a long Retry-After fails fast instead of retrying early', async () => {
    let calls = 0;
    const waits: number[] = [];
    const c = createOpenDotaClient({ rpm: 6000, sleep: async (ms: number) => { waits.push(ms); }, fetchImpl: async () => { calls += 1; return json({}, 503, { 'retry-after': '60' }); } });
    await expect(c.getJson(`${BASE}/heroStats`, { retries: 3 })).rejects.toMatchObject({ status: 503, retryAfterSec: 60 });
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it('an already-aborted caller starts nothing and leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      let calls = 0;
      const c = createOpenDotaClient({ rpm: 6000, fetchImpl: async () => { calls += 1; return json({}); } });
      const ac = new AbortController(); ac.abort();
      await expect(c.getJson(`${BASE}/heroStats`, { signal: ac.signal })).rejects.toBeTruthy();
      expect(calls).toBe(0);
      // Every caller aborts while the shared request then fails: still handled.
      const cool = createOpenDotaClient({ rpm: 6000, cooldown: { get: () => Date.now() + 60_000, set: () => {} } });
      const ac2 = new AbortController();
      const p = cool.getJson(`${BASE}/matches/8`, { signal: ac2.signal });
      ac2.abort();
      await expect(p).rejects.toBeTruthy();
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('opendota outage breaker (PR-A)', () => {
  const setup = (respond: (n: number) => any, o: any = {}) => {
    let t = 1_000_000;
    let calls = 0;
    const c = createOpenDotaClient({
      rpm: 6000, now: () => t, sleep: async () => {},
      fetchImpl: async () => { calls += 1; const r = respond(calls); if (r instanceof Error) throw r; return r; },
      ...o,
    });
    return { c, calls: () => calls, advance: (ms: number) => { t += ms; } };
  };
  const get = (c: any) => c.getJson(`${BASE}/matches/1`, { retries: 0 });

  it('3 consecutive 520s open the breaker; the 4th call fails fast without fetching', async () => {
    const h = setup(() => json({}, 520));
    for (let i = 0; i < 3; i++) await expect(get(h.c)).rejects.toMatchObject({ status: 520 });
    expect(h.calls()).toBe(3);
    await expect(get(h.c)).rejects.toMatchObject({ status: 503, retryable: true, upstream: 'opendota' });
    expect(h.calls()).toBe(3);
    const snap = h.c.snapshot();
    expect(snap.outageTrips).toBe(1);
    expect(snap.outageRejects).toBe(1);
    expect(snap.lastOutageAt).toBeTruthy();
  });

  it('a 200 between failures resets the count: 2 × 520, 200, 2 × 520 never trips', async () => {
    const seq = [520, 520, 200, 520, 520];
    const h = setup((n) => json({ ok: 1 }, seq[n - 1]));
    for (const st of seq) {
      if (st === 200) await expect(get(h.c)).resolves.toEqual({ ok: 1 });
      else await expect(get(h.c)).rejects.toMatchObject({ status: 520 });
    }
    expect(h.c.snapshot().outageTrips).toBe(0);
    expect(h.calls()).toBe(5);
  });

  it('404s are answers, not an outage', async () => {
    const h = setup(() => json({}, 404));
    for (let i = 0; i < 5; i++) await expect(get(h.c)).rejects.toMatchObject({ status: 404 });
    expect(h.calls()).toBe(5);
    expect(h.c.snapshot().outageTrips).toBe(0);
  });

  it('network timeouts count too, and the breaker stops retries inside one request', async () => {
    const h = setup(() => Object.assign(new Error('t'), { name: 'TimeoutError' }));
    await expect(h.c.getJson(`${BASE}/matches/1`, { retries: 6 })).rejects.toMatchObject({ status: 503 });
    expect(h.calls()).toBe(3);
  });

  it('after the cooldown it lets a call through; one more failure re-opens it, a success closes it', async () => {
    let status = 522;
    const h = setup(() => json({ ok: 1 }, status), { outageCooldownMs: 60_000 });
    for (let i = 0; i < 3; i++) await expect(get(h.c)).rejects.toMatchObject({ status: 522 });
    h.advance(60_001);
    await expect(get(h.c)).rejects.toMatchObject({ status: 522 }); // half-open probe fails…
    await expect(get(h.c)).rejects.toMatchObject({ status: 503 }); // …and it is open again
    expect(h.c.snapshot().outageTrips).toBe(2);
    h.advance(60_001);
    status = 200;
    await expect(get(h.c)).resolves.toEqual({ ok: 1 });
    status = 522;
    await expect(get(h.c)).rejects.toMatchObject({ status: 522 }); // closed: needs 3 again
    await expect(get(h.c)).rejects.toMatchObject({ status: 522 });
    expect(h.c.snapshot().outageTrips).toBe(2);
  });

  it('writes the outage to the shared cooldown so other instances back off', async () => {
    const set = vi.fn();
    const h = setup(() => json({}, 524), { cooldown: { get: () => 0, set } });
    for (let i = 0; i < 3; i++) await expect(get(h.c)).rejects.toBeTruthy();
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][1]).toMatch(/^outage: HTTP 524/);
  });
});

