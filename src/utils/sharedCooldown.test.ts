import { describe, expect, it } from 'vitest';
import { createSharedCooldown as createCooldown } from '../../lib/upstream/sharedCooldown.js';
import { createOpenDotaClient as createClient } from '../../lib/upstream/opendota.js';

// Fakes stand in for the GCS bucket and fetch; the JSDoc types expect the real ones.
const createSharedCooldown = (o: any): any => createCooldown(o);
const createOpenDotaClient = (o: any): any => createClient(o);
const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeBucket() {
  const objects = new Map<string, string>();
  const calls = { download: 0, save: 0 };
  return {
    objects, calls,
    file(key: string) {
      return {
        async download() {
          calls.download += 1;
          if (!objects.has(key)) throw Object.assign(new Error('gcs_request_failed'), { code: 404 });
          return [Buffer.from(objects.get(key)!)];
        },
        async save(body: string) { calls.save += 1; objects.set(key, body); },
      };
    },
  };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});
const BASE = 'https://api.opendota.com/api';

describe('shared OpenDota cooldown (GCS)', () => {
  it('a 429 on instance A stops instance B within one refresh', async () => {
    let t = 1_000_000;
    const bucket = fakeBucket();
    const now = () => t;
    const a = createOpenDotaClient({ rpm: 6000, now, sleep: async () => {}, cooldown: createSharedCooldown({ bucket, now }), fetchImpl: async () => json({}, 429, { 'retry-after': '60' }) });
    let bCalls = 0;
    const bCooldown = createSharedCooldown({ bucket, now });
    const b = createOpenDotaClient({ rpm: 6000, now, cooldown: bCooldown, fetchImpl: async () => { bCalls += 1; return json({ ok: 1 }); } });

    expect(await b.getJson(`${BASE}/heroStats`)).toEqual({ ok: 1 }); // B reads: nothing shared yet
    await expect(a.getJson(`${BASE}/matches/1`)).rejects.toMatchObject({ status: 429 });
    await flush();
    expect(JSON.parse(bucket.objects.get('ratelimit/opendota.json')!).until).toBe(t + 60_000);

    t += 5_000; // B's next refresh
    await expect(b.getJson(`${BASE}/matches/2`)).rejects.toMatchObject({ status: 429 });
    expect(bCalls).toBe(1);
    t += 60_000; // the cooldown is over
    expect(await b.getJson(`${BASE}/matches/2`)).toEqual({ ok: 1 });
  });

  it('reads the shared object at most once per refresh window', async () => {
    let t = 0;
    const bucket = fakeBucket();
    const c = createSharedCooldown({ bucket, now: () => t, refreshMs: 5000 });
    await c.get(); await c.get(); await c.get();
    expect(bucket.calls.download).toBe(1);
    t += 5000;
    await c.get();
    expect(bucket.calls.download).toBe(2);
  });

  it('never shortens a longer shared cooldown, and a failed read keeps the last value', async () => {
    let t = 0;
    const bucket = fakeBucket();
    bucket.objects.set('ratelimit/opendota.json', JSON.stringify({ until: 90_000 }));
    const c = createSharedCooldown({ bucket, now: () => t });
    expect(await c.get()).toBe(90_000);
    c.set(30_000, 'shorter');
    await flush();
    expect(bucket.calls.save).toBe(0);
    expect(JSON.parse(bucket.objects.get('ratelimit/opendota.json')!).until).toBe(90_000);

    const broken = { file: () => ({ download: async () => { throw Object.assign(new Error('x'), { code: 503 }); }, save: async () => {} }) };
    const d = createSharedCooldown({ bucket: broken, now: () => t });
    d.set(50_000);
    t += 6000;
    expect(await d.get()).toBe(50_000);
    expect(d.snapshot().readErrors).toBe(1);
  });
});
