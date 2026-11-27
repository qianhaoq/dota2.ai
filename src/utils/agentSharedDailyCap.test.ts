import { afterAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { createBucketStore, createFileStore, createJsonStore, createTraceStore } from '../../lib/agent/stores.js';
import { createSharedDailyCap, retryAfterUtcMidnightSec, utcDay } from '../../lib/agent/sharedDailyCap.js';
import { ALTERNATIVES, createAgentRouter } from '../../lib/agent/router.js';
import { createAgentService } from '../../lib/agent/service.js';
import { withDailyCap } from '../../lib/llmRateLimit.js';
import { createPatchRouter } from '../../lib/patch/router.js';

const express = createRequire(import.meta.url)('express');
const root = mkdtempSync(join(tmpdir(), 'shared-cap-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fixture = gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url)));
const MATCH = '9100904020';

/** In-memory GCS bucket implementing generation-checked getMetadata / download / save / delete. */
function fakeGcsBucket({ delayMs = 0 } = {}) {
  const objects = new Map<string, { body: Buffer; generation: number }>();
  let nextGen = 1;
  let reads = 0;
  let writes = 0;
  let failReads: any = null;
  let failWrites: any = null;
  const tick = () => (delayMs ? new Promise((r) => setTimeout(r, delayMs)) : Promise.resolve());
  const bucket = {
    file(key: string) {
      return {
        async getMetadata() {
          reads += 1;
          await tick();
          if (failReads) throw failReads;
          const entry = objects.get(key);
          if (!entry) throw Object.assign(new Error('not found'), { code: 404 });
          return [{ generation: String(entry.generation) }];
        },
        async download({ preconditionOpts }: any = {}) {
          await tick();
          if (failReads) throw failReads;
          const entry = objects.get(key);
          if (!entry) throw Object.assign(new Error('not found'), { code: 404 });
          const cond = preconditionOpts?.ifGenerationMatch;
          if (cond != null && String(entry.generation) !== String(cond)) {
            throw Object.assign(new Error('precondition failed'), { code: 412 });
          }
          return [Buffer.from(entry.body)];
        },
        async save(body: Buffer, { preconditionOpts }: any = {}) {
          writes += 1;
          await tick();
          if (failWrites) throw failWrites;
          const cond = preconditionOpts?.ifGenerationMatch;
          const entry = objects.get(key);
          const curGen = entry ? String(entry.generation) : '0';
          if (cond != null && String(cond) !== curGen) {
            throw Object.assign(new Error('precondition failed'), { code: 412 });
          }
          const gen = nextGen += 1;
          objects.set(key, { body: Buffer.from(body), generation: gen });
          return [{ generation: String(gen) }];
        },
        async delete({ preconditionOpts }: any = {}) {
          await tick();
          const cond = preconditionOpts?.ifGenerationMatch;
          const entry = objects.get(key);
          if (!entry) throw Object.assign(new Error('not found'), { code: 404 });
          if (cond != null && String(entry.generation) !== String(cond)) {
            throw Object.assign(new Error('precondition failed'), { code: 412 });
          }
          objects.delete(key);
        },
      };
    },
  };
  return {
    bucket,
    objects,
    stats: () => ({ reads, writes }),
    setFailReads: (err: any) => { failReads = err; },
    setFailWrites: (err: any) => { failWrites = err; },
  };
}

async function serve(router: any) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const at = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = async (path: string, body: object, ip: string) => {
    const r = await fetch(`${at}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-ip': ip }, body: JSON.stringify(body) });
    let json: any = null;
    try { json = await r.json(); } catch { /* SSE */ }
    return { status: r.status, body: json, retryAfter: r.headers.get('retry-after') };
  };
  return { post, close: () => new Promise((r) => srv.close(r)) };
}

const ipOf = (req: any) => String(req.headers?.['x-test-ip'] ?? '10.0.0.1');

describe('sharedDailyCap (#453)', () => {
  it('shares a strict UTC-daily limit across multiple instances under concurrent CAS contention and resets at UTC midnight', async () => {
    const gcs = fakeGcsBucket({ delayMs: 2 });
    let t = Date.UTC(2026, 10, 27, 23, 59, 0); // 60 s before UTC midnight
    const blobsA = createBucketStore(gcs.bucket, 'agent/');
    const blobsB = createBucketStore(gcs.bucket, 'agent/');
    const capA = createSharedDailyCap({ blobs: blobsA, name: 'review', limit: 3, now: () => t });
    const capB = createSharedDailyCap({ blobs: blobsB, name: 'review', limit: 3, now: () => t });

    // Six concurrent requests across two instances: at most 3 are ever admitted.
    const results = await Promise.all([
      capA.tryConsume('all'), capB.tryConsume('all'),
      capA.tryConsume('all'), capB.tryConsume('all'),
      capA.tryConsume('all'), capB.tryConsume('all'),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    const refused = results.filter((r) => !r.ok);
    expect(refused).toHaveLength(3);
    for (const r of refused) {
      expect(r.reason).toBe('daily_cap');
      expect(r.retryAfterSec).toBe(60);
    }

    // Fast path in memory: once known full, another check/consume does zero extra store reads.
    const before = gcs.stats().reads;
    expect(capA.full('all')).toBe(true);
    expect(await capA.check('all')).toMatchObject({ ok: false, reason: 'daily_cap', retryAfterSec: 60 });
    expect(await capA.tryConsume('all')).toMatchObject({ ok: false, reason: 'daily_cap', retryAfterSec: 60 });
    expect(gcs.stats().reads).toBe(before);

    // Cross UTC midnight: fresh day, fresh budget.
    t = Date.UTC(2026, 10, 28, 0, 0, 5);
    expect(utcDay(t)).toBe('2026-11-28');
    expect(retryAfterUtcMidnightSec(t)).toBe(86_395);
    expect(capA.full('all')).toBe(false);
    expect(await capA.tryConsume('all')).toEqual({ ok: true, retryAfterSec: 0 });
  });

  it('fails closed on GCS read or write outages before charging the model budget or caller slots', async () => {
    const gcs = fakeGcsBucket();
    const blobs = createBucketStore(gcs.bucket, 'agent/');
    const logs: string[] = [];
    const cap = createSharedDailyCap({ blobs, name: 'review', limit: 5, log: (m) => logs.push(m) });

    let llmCalls = 0;
    const service: any = {
      availability: async () => ({ trace: true, model_configured: true, can_parse: false, heroes: [{ hero: 'beastmaster' }] }),
      status: async () => ({ status: 'none' }),
      start: async (_m: string, _h: string, _l: string, o: any) => {
        const refusal = await o.admit();
        if (refusal) return { status: 'refused', refusal };
        return { status: 'running' };
      },
    };
    const router = createAgentRouter({
      service,
      resolveClientIp: ipOf,
      llm: { acquire: () => { llmCalls += 1; return { ok: true }; } },
      reviewDaily: cap,
    });
    const s = await serve(router);
    try {
      // Read outage: fails closed with 503 busy (not daily_cap), and never touches deps.llm.
      gcs.setFailReads(Object.assign(new Error('gcs down'), { code: 503 }));
      const r1 = await s.post(`/api/agent/${MATCH}/review`, { hero: 'beastmaster', lang: 'en' }, '10.1.0.1');
      expect(r1.status).toBe(503);
      expect(r1.body).toMatchObject({ code: 'busy', alternatives: ALTERNATIVES });
      expect(llmCalls).toBe(0);
      expect(logs.some((l) => l.includes('failing closed'))).toBe(true);

      // Write outage: fails closed with 503 busy and does not mark the day full.
      gcs.setFailReads(null);
      gcs.setFailWrites(Object.assign(new Error('gcs write failed'), { code: 500 }));
      const r2 = await s.post(`/api/agent/${MATCH}/review`, { hero: 'beastmaster', lang: 'en' }, '10.1.0.2');
      expect(r2.status).toBe(503);
      expect(r2.body).toMatchObject({ code: 'busy', alternatives: ALTERNATIVES });
      expect(cap.full('all')).toBe(false);

      // Recovery: admits cleanly once GCS comes back.
      gcs.setFailWrites(null);
      const r3 = await s.post(`/api/agent/${MATCH}/review`, { hero: 'beastmaster', lang: 'en' }, '10.1.0.3');
      expect(r3.status).toBe(202);
    } finally {
      await s.close();
    }
  });

  it('works over withDailyCap for async shared chat daily caps and fails closed on store outage', async () => {
    const gcs = fakeGcsBucket();
    const cap = createSharedDailyCap({ blobs: createBucketStore(gcs.bucket, 'agent/'), name: 'chat', limit: 1 });
    let innerCalls = 0;
    const capped = withDailyCap({ acquire: () => { innerCalls += 1; return { ok: true }; }, respondRateLimited: () => 'limited' }, cap);

    gcs.setFailReads(Object.assign(new Error('down'), { code: 503 }));
    expect(await capped.acquire({})).toMatchObject({ ok: false, reason: 'cost_guard' });
    expect(innerCalls).toBe(0);

    gcs.setFailReads(null);
    expect(await capped.acquire({})).toEqual({ ok: true });
    expect(innerCalls).toBe(1);

    // Day is now full: refused before inner acquire.
    expect(await capped.acquire({})).toMatchObject({ ok: false, reason: 'cost_guard' });
    expect(innerCalls).toBe(1);
  });

  it('works with createFileStore CAS for local/single-machine deployments', async () => {
    const dir = mkdtempSync(join(root, 'file-cap-'));
    const cap = createSharedDailyCap({ blobs: createFileStore(dir), name: 'parse', limit: 2 });
    const res = await Promise.all([cap.tryConsume('all'), cap.tryConsume('all'), cap.tryConsume('all')]);
    expect(res.filter((r) => r.ok)).toHaveLength(2);
    expect(res.filter((r) => !r.ok && r.reason === 'daily_cap')).toHaveLength(1);
  });
});

describe('cross-instance parse claim lock', () => {
  it('admits and runs only one parse when two instances receive prepare concurrently, and reclaims expired claims', async () => {
    const gcs = fakeGcsBucket({ delayMs: 2 });
    const clock = { t: 1_000_000 };
    const blobs = createBucketStore(gcs.bucket, 'agent/');
    const traces = createTraceStore(blobs);
    const docs = createJsonStore(blobs);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const runA = vi.fn(async (id: any) => { await gate; await traces.put(id, gzipSync(fixture)); return { ok: true }; });
    const runB = vi.fn(async (id: any) => { await gate; await traces.put(id, gzipSync(fixture)); return { ok: true }; });
    const svcA = createAgentService({ traces, complete: null, pipeline: { run: runA }, docs, now: () => clock.t });
    const svcB = createAgentService({ traces, complete: null, pipeline: { run: runB }, docs, now: () => clock.t });

    let admitted = 0;
    const admit = async () => { admitted += 1; return null; };
    const [a, b] = await Promise.all([svcA.prepare(MATCH, { admit }), svcB.prepare(MATCH, { admit })]);
    expect(a.status).toBe('running');
    expect(b.status).toBe('running');
    expect(admitted).toBe(1);
    expect(runA.mock.calls.length + runB.mock.calls.length).toBe(1);

    release();
    await vi.waitFor(async () => expect((await svcA.availability(MATCH)).trace).toBe(true), { timeout: 5000 });

    // An orphaned claim from a crashed instance expires after STALE_MS and is taken over cleanly.
    const MATCH2 = '9100904021';
    await docs.put(`${MATCH2}.parse.claim.json`, { runner: 'dead-instance', at: clock.t - 120_000 });
    const runC = vi.fn(async () => ({ ok: false, reason: 'replay_gone' }));
    const svcC = createAgentService({ traces, complete: null, pipeline: { run: runC }, docs, now: () => clock.t });
    const c = await svcC.prepare(MATCH2);
    expect(c.status).toBe('running');
    await vi.waitFor(() => expect(runC).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });

  it('releases the parse claim immediately when admission is refused', async () => {
    const gcs = fakeGcsBucket();
    const blobs = createBucketStore(gcs.bucket, 'agent/');
    const traces = createTraceStore(blobs);
    const docs = createJsonStore(blobs);
    const run = vi.fn(async () => ({ ok: false, reason: 'replay_gone' }));
    const svc = createAgentService({ traces, complete: null, pipeline: { run }, docs });

    const refused = await svc.prepare(MATCH, { admit: async () => ({ status: 503, body: { code: 'busy' } }) });
    expect(refused).toEqual({ status: 'refused', refusal: { status: 503, body: { code: 'busy' } } });
    expect(run).not.toHaveBeenCalled();

    // Another instance is not blocked by a stale claim and can proceed once admitted.
    const svc2 = createAgentService({ traces, complete: null, pipeline: { run }, docs });
    const ok = await svc2.prepare(MATCH, { admit: async () => null });
    expect(ok.status).toBe('running');
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });

  it('20 concurrent prepares from one IP admit only 5 and increment the shared daily counter by 5 (Codex P1 on #461)', async () => {
    const gcs = fakeGcsBucket({ delayMs: 5 });
    const blobs = createBucketStore(gcs.bucket, 'agent/');
    const parseDaily = createSharedDailyCap({ blobs, name: 'parse', limit: 300 });
    const service: any = {
      availability: async () => ({ trace: false, can_parse: true, parse: null }),
      prepare: async (_id: string, o: any) => {
        const refusal = await o.admit();
        return refusal ? { status: 'refused', refusal } : { status: 'running', stage: 'locating' };
      },
    };
    const router = createAgentRouter({ service, resolveClientIp: ipOf, parseDaily });
    const s = await serve(router);
    try {
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => s.post(`/api/agent/${9100904100 + i}/prepare`, {}, '10.9.0.1')));
      expect(results.filter((r) => r.status === 202)).toHaveLength(5);
      expect(results.filter((r) => r.status === 429)).toHaveLength(15);
      const stored = JSON.parse([...gcs.objects.values()][0].body.toString('utf8'));
      expect(stored.count).toBe(5);
    } finally {
      await s.close();
    }
  });

  it('failed createFileStore putIfMatch does not emit unhandledRejection on the serialization tail (Codex P1 on #461)', async () => {
    const unhandled: any[] = [];
    const onUnhandled = (err: any) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    try {
      const brokenFs: any = {
        mkdir: async () => {},
        readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
        writeFile: async () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); },
        rename: async () => {},
        rm: async () => {},
      };
      const store = createFileStore(join(root, 'broken'), brokenFs);
      await expect(store.putIfMatch('x.json', Buffer.from('{}'), '0')).rejects.toThrow('ENOSPC');
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('conditional deleteIfMatch never removes another instance\'s newer claim (Codex P1 on #461)', async () => {
    const gcs = fakeGcsBucket();
    const blobs = createBucketStore(gcs.bucket, 'agent/');
    const put1: any = await blobs.putIfMatch('claim.json', Buffer.from(JSON.stringify({ runner: 'A', at: 1 })), '0');
    expect(put1.ok).toBe(true);
    // Instance B replaces the claim (e.g. after expiry), advancing generation.
    const put2: any = await blobs.putIfMatch('claim.json', Buffer.from(JSON.stringify({ runner: 'B', at: 2 })), put1.generation);
    expect(put2.ok).toBe(true);
    // Instance A tries to release its old generation: must fail with conflict and keep B's live claim intact.
    const delA = await blobs.deleteIfMatch('claim.json', put1.generation);
    expect(delA).toEqual({ ok: false, conflict: true });
    expect(JSON.parse((await blobs.get('claim.json'))!.toString('utf8')).runner).toBe('B');
    // Instance B releases its own generation: succeeds.
    expect(await blobs.deleteIfMatch('claim.json', put2.generation)).toEqual({ ok: true });
    expect(await blobs.get('claim.json')).toBeNull();
  });

  it('patch chat registers disconnect handling before awaiting async admission so disconnected callers never start the advisor (Codex P1 on #461)', async () => {
    let releaseAdmit!: () => void;
    const admitGate = new Promise<void>((r) => { releaseAdmit = r; });
    let admitStarted!: () => void;
    const onAdmitStart = new Promise<void>((r) => { admitStarted = r; });
    const run = vi.fn(async () => ({ status: 'ok' as const, text: 'hi', unverified: [] }));
    const router = createPatchRouter({
      complete: async () => ({ text: 'ok' }),
      resolveClientIp: ipOf,
      llm: { acquire: async () => { admitStarted(); await admitGate; return { ok: true }; } },
      run,
    });
    const app = express();
    app.use(express.json());
    app.use(router);
    const srv = app.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const port = (srv.address() as AddressInfo).port;
    try {
      const ac = new AbortController();
      const reqPromise = fetch(`http://127.0.0.1:${port}/api/patch/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-ip': '10.8.0.1' },
        body: JSON.stringify({ question: '7.42 changed what?', lang: 'en', history: [] }),
        signal: ac.signal,
      }).catch(() => null);
      await onAdmitStart;
      ac.abort();
      await new Promise((r) => setTimeout(r, 30));
      releaseAdmit();
      await reqPromise;
      await new Promise((r) => setTimeout(r, 30));
      expect(run).not.toHaveBeenCalled();
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});
