import { describe, expect, it } from 'vitest';
import { createMatchStore as create } from '../../lib/matchStore.js';

const createMatchStore = (o: any): any => create(o);
const flush = () => new Promise((r) => setTimeout(r, 0));

/** In-memory stand-in for createGcsBucket(): same download/save shape and error codes. */
function fakeBucket(opts: { failReads?: number; slowMs?: number } = {}) {
  const objects = new Map<string, string>();
  const calls = { download: 0, save: 0 };
  return {
    objects, calls,
    file(key: string) {
      return {
        async download() {
          calls.download += 1;
          if (opts.slowMs) await new Promise((r) => setTimeout(r, opts.slowMs));
          if (opts.failReads) throw Object.assign(new Error('gcs_request_failed'), { code: opts.failReads });
          if (!objects.has(key)) throw Object.assign(new Error('gcs_request_failed'), { code: 404 });
          return [Buffer.from(objects.get(key)!)];
        },
        async save(body: string, o: any = {}) {
          calls.save += 1;
          if (o.preconditionOpts?.ifGenerationMatch === 0 && objects.has(key)) throw Object.assign(new Error('gcs_request_failed'), { code: 412 });
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
