import { describe, expect, it } from 'vitest';
import { createMatchStore as create } from '../../lib/matchStore.js';

const createMatchStore = (o: any): any => create(o);
const flush = () => new Promise((r) => setTimeout(r, 0));

/** In-memory stand-in for createGcsBucket(): same download/save shape and error codes. */
function fakeBucket(opts: { failReads?: number; slowMs?: number } = {}) {
  const objects = new Map<string, string>();
  const calls = { download: 0, save: 0 };
  const generations = new Map<string, number>();
  return {
    objects, calls, generations,
    file(key: string) {
      return {
        async download(_o?: any) {
          calls.download += 1;
          if (opts.slowMs) await new Promise((r) => setTimeout(r, opts.slowMs));
          if (opts.failReads) throw Object.assign(new Error('gcs_request_failed'), { code: opts.failReads });
          if (!objects.has(key)) throw Object.assign(new Error('gcs_request_failed'), { code: 404 });
          return [Buffer.from(objects.get(key)!)];
        },
        async getMetadata() {
          if (!objects.has(key)) throw Object.assign(new Error('gcs_request_failed'), { code: 404 });
          return [{ generation: String(generations.get(key) ?? 1) }];
        },
        async save(body: string, o: any = {}) {
          calls.save += 1;
          const want = o.preconditionOpts?.ifGenerationMatch;
          if (want === 0 && objects.has(key)) throw Object.assign(new Error('gcs_request_failed'), { code: 412 });
          if (want != null && want !== 0 && String(want) !== String(generations.get(key) ?? 1)) throw Object.assign(new Error('gcs_request_failed'), { code: 412 });
          generations.set(key, objects.has(key) ? (generations.get(key) ?? 1) + 1 : 1);
          objects.set(key, body);
        },
      };
    },
  };
}

const isParsed = (m: any) => Boolean(m?.version);
const parsed = { match_id: 1, version: 21, players: [] };
const unparsed = { match_id: 2, players: [] };

describe('match store (GCS)', () => {
  it('writes a parsed match once and serves it back', async () => {
    const bucket = fakeBucket();
    const s = createMatchStore({ bucket, isParsed });
    expect(await s.getMatch(1)).toBeNull();
    s.putMatch(1, parsed);
    await flush();
    expect(bucket.objects.has('matches/1.json')).toBe(true);
    expect(await s.getMatch(1)).toEqual(parsed);
    expect(s.snapshot()).toMatchObject({ hits: 1, misses: 1, writes: 1 });
  });

  it('never stores an unparsed match, and ignores a stored copy that is not parsed', async () => {
    const bucket = fakeBucket();
    const s = createMatchStore({ bucket, isParsed });
    s.putMatch(2, unparsed);
    await flush();
    expect(bucket.calls.save).toBe(0);
    bucket.objects.set('matches/2.json', JSON.stringify(unparsed));
    expect(await s.getMatch(2)).toBeNull();
  });

  it('replaceMatch: a fuller copy replaces a lesser stored one, and only that way round', async () => {
    const lesser = { match_id: 1, version: 22, data_source: 'steam_gc+odota_parser', players: [] };
    const fuller = { match_id: 1, version: 22, players: [{ benchmarks: {} }] };
    const isLesser = (m: any) => m?.data_source === 'steam_gc+odota_parser';
    const bucket = fakeBucket();
    const s = createMatchStore({ bucket, isParsed });
    s.putMatch(1, lesser);
    await flush();
    s.replaceMatch(1, fuller, isLesser);
    await flush(); await flush();
    expect(await s.getMatch(1)).toEqual(fuller);
    // The other way round is refused: by the copy offered, and by the copy stored.
    s.replaceMatch(1, lesser, isLesser);
    s.replaceMatch(1, { ...fuller, players: [] }, isLesser);
    await flush(); await flush();
    expect(await s.getMatch(1)).toEqual(fuller);
    // Never an unparsed copy, never a bad id, nothing when there is no stored match.
    s.replaceMatch(1, unparsed, isLesser);
    s.replaceMatch('../x' as any, fuller, isLesser);
    s.replaceMatch(9, fuller, isLesser);
    await flush(); await flush();
    expect(bucket.objects.has('matches/9.json')).toBe(false);
    expect(s.snapshot().writeErrors).toBe(0);
  });

  it('replaceMatch: loses cleanly when the stored copy changed after it was read', async () => {
    const lesser = { match_id: 1, version: 22, data_source: 'steam_gc+odota_parser' };
    const isLesser = (m: any) => m?.data_source === 'steam_gc+odota_parser';
    const bucket = fakeBucket();
    bucket.objects.set('matches/1.json', JSON.stringify(lesser));
    const s = createMatchStore({ bucket, isParsed });
    const file = bucket.file('matches/1.json');
    const realFile = bucket.file.bind(bucket);
    // Another instance writes between our read and our write.
    (bucket as any).file = (key: string) => {
      const f = realFile(key);
      return { ...f, async download(o: any) { const out = await f.download(o); await file.save(JSON.stringify({ match_id: 1, version: 22, by: 'other' })); return out; } };
    };
    s.replaceMatch(1, { match_id: 1, version: 22, by: 'us' }, isLesser);
    await flush(); await flush();
    expect(JSON.parse(bucket.objects.get('matches/1.json')!).by).toBe('other');
    expect(s.snapshot()).toMatchObject({ writeErrors: 0 });
  });

  it('create-only: a second writer losing the race is not an error', async () => {
    const bucket = fakeBucket();
    const a = createMatchStore({ bucket, isParsed });
    const b = createMatchStore({ bucket, isParsed });
    a.putMatch(1, parsed);
    await flush();
    b.putMatch(1, { ...parsed, other: true });
    await flush();
    expect(JSON.parse(bucket.objects.get('matches/1.json')!)).toEqual(parsed);
    expect(b.snapshot()).toMatchObject({ writeSkips: 1, writeErrors: 0 });
  });

  it('GCS down, slow or garbage is a miss, never an error for the caller', async () => {
    const logs: string[] = [];
    const down = createMatchStore({ bucket: fakeBucket({ failReads: 503 }), isParsed, log: (m: string) => logs.push(m) });
    expect(await down.getMatch(1)).toBeNull();
    expect(down.snapshot().errors).toBe(1);
    const slow = createMatchStore({ bucket: fakeBucket({ slowMs: 50 }), isParsed, readTimeoutMs: 10 });
    expect(await slow.getMatch(1)).toBeNull();
    const bad = fakeBucket(); bad.objects.set('matches/1.json', '{nope');
    expect(await createMatchStore({ bucket: bad, isParsed }).getMatch(1)).toBeNull();
    expect(logs.join()).toContain('503');
  });

  it('rejects ids that are not match ids', async () => {
    const bucket = fakeBucket();
    const s = createMatchStore({ bucket, isParsed });
    expect(await s.getMatch('../x')).toBeNull();
    s.putMatch('../x', parsed);
    await flush();
    expect(bucket.calls.download + bucket.calls.save).toBe(0);
  });

  it('time-boxed results expire by age', async () => {
    let t = 1_000_000;
    const bucket = fakeBucket();
    const s = createMatchStore({ bucket, isParsed, now: () => t });
    s.putResult('select 1', [{ a: 1 }]);
    await flush();
    expect(await s.getResult('select 1', 60_000)).toEqual([{ a: 1 }]);
    t += 61_000;
    expect(await s.getResult('select 1', 60_000)).toBeNull();
    // Keys are hashed: the SQL never becomes an object name.
    expect([...bucket.objects.keys()][0]).toMatch(/^results\/[0-9a-f]{40}\.json$/);
  });
});

describe('server wiring', () => {
  it('reads the store before OpenDota, writes back, and is off without MATCH_CACHE_BUCKET', async () => {
    const { readFileSync } = await import('node:fs');
    const server = readFileSync('server.js', 'utf8');
    expect(server).toMatch(/process\.env\.MATCH_CACHE_BUCKET/);
    const fn = server.slice(server.indexOf('const matchDetailCache = createMatchDetailCache('));
    expect(fn.indexOf('matchStore.getMatch(matchId)')).toBeGreaterThan(-1);
    expect(fn.indexOf('matchStore.getMatch(matchId)')).toBeLessThan(fn.indexOf('fetchWithRetry('));
    expect(fn.indexOf('matchStore?.putMatch(matchId, data)')).toBeGreaterThan(fn.indexOf('fetchWithRetry('));
  });
});
