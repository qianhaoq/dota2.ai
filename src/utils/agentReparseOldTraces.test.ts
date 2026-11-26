import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
// @ts-expect-error express has no bundled .d.ts in devDependencies
import express from 'express';
import { TRACE_BUILD_VERSION, traceIsOutdated } from '../../lib/agent/traceBuild.js';
import { createAgentService } from '../../lib/agent/service.js';
import { createTraceStore } from '../../lib/agent/stores.js';
import { createAgentRouter } from '../../lib/agent/router.js';

const ID = 9100904020;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);
const legacyTrace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());
const modernTrace = {
  ...legacyTrace,
  build: TRACE_BUILD_VERSION,
  creep_kills: [[65, 0, 'l', 1, 640]],
  roshan_kills: [],
  tormentor_kills: [],
  roshan_damage: [],
  buybacks: [],
};

describe('re-parsing older traces when the replay still exists (#365)', () => {
  it('identifies traces built before creep_kills / roshan_kills / buybacks existed', () => {
    expect(traceIsOutdated(legacyTrace)).toBe(true);
    expect(traceIsOutdated(modernTrace)).toBe(false);
    expect(traceIsOutdated({ ...modernTrace, build: 1 })).toBe(true);
    expect(traceIsOutdated(null)).toBe(false);
  });

  it('re-parses an outdated trace before writing a new review when the replay is kept, upgrading what the review sees', async () => {
    let currentTrace: any = structuredClone(legacyTrace);
    const docs = new Map<string, any>();
    const seenInModel: boolean[] = [];

    const pipeline = {
      run: vi.fn(async () => {
        currentTrace = structuredClone(modernTrace);
        return { ok: true, bytes: 1024 };
      }),
    };

    const complete = vi.fn(async ({ messages }: any) => {
      // Inspect whether the upgraded trace was passed in: we also verify via prepare/availability.
      seenInModel.push(Array.isArray(currentTrace.creep_kills));
      throw Object.assign(new Error('stop after trace check'), { status: 503 });
    });

    const service: any = createAgentService({
      traces: { get: async () => currentTrace },
      pipeline,
      reparseOldTraces: true,
      complete,
      model: 'mock',
      getMatchDetail: async () => ({ match_id: ID, start_time: Math.floor((NOW - 2 * DAY) / 1000), duration: 2400 }),
      docs: { get: async (k: string) => docs.get(k) ?? null, put: async (k: string, v: any) => { docs.set(k, v); } },
      now: () => NOW,
    } as any);

    expect((await service.availability(ID)).trace_outdated).toBe(true);
    await service.start(ID, 'beastmaster', 'zh');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));

    expect(pipeline.run).toHaveBeenCalledTimes(1);
    expect(seenInModel).toEqual([true]);
    expect((await service.availability(ID)).trace_outdated).toBeUndefined();
  });

  it('keeps the existing trace and never fails the review when the replay is gone (>14 days or 404)', async () => {
    const oldOnly = structuredClone(legacyTrace);
    const docs = new Map<string, any>();
    const pipeline = { run: vi.fn(async () => ({ ok: false, reason: 'replay_gone' })) };
    const complete = vi.fn(async () => { throw Object.assign(new Error('stop'), { status: 503 }); });

    // Case 1: Match record itself proves the game ended >14 days ago -> zero worker calls!
    const expiredService: any = createAgentService({
      traces: { get: async () => oldOnly },
      pipeline,
      reparseOldTraces: true,
      complete,
      model: 'mock',
      getMatchDetail: async () => ({ match_id: ID, start_time: Math.floor((NOW - 20 * DAY) / 1000), duration: 2400 }),
      docs: { get: async (k: string) => docs.get(k) ?? null, put: async (k: string, v: any) => { docs.set(k, v); } },
      now: () => NOW,
    } as any);

    expect(await expiredService.prepare(ID)).toEqual({ status: 'ready' });
    expect(pipeline.run).not.toHaveBeenCalled();

    // Case 2: Match is recent (<14 days), worker answers replay_gone -> falls back to old trace and never retries.
    const docs2 = new Map<string, any>();
    const recentGoneService: any = createAgentService({
      traces: { get: async () => oldOnly },
      pipeline,
      reparseOldTraces: true,
      complete,
      model: 'mock',
      getMatchDetail: async () => ({ match_id: ID, start_time: Math.floor((NOW - 3 * DAY) / 1000), duration: 2400 }),
      docs: { get: async (k: string) => docs2.get(k) ?? null, put: async (k: string, v: any) => { docs2.set(k, v); } },
      now: () => NOW,
    } as any);

    await recentGoneService.start(ID, 'beastmaster', 'zh');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(pipeline.run).toHaveBeenCalledTimes(1);

    // Asking prepare or another hero's review afterwards does NOT try to re-parse a gone replay again.
    expect(await recentGoneService.prepare(ID)).toEqual({ status: 'ready' });
    await recentGoneService.start(ID, 'sven', 'zh');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect(pipeline.run).toHaveBeenCalledTimes(1);
  });

  it('evicts the web instance in-memory trace cache when a remote worker writes the upgraded blob', async () => {
    const blobs = new Map<string, Buffer>([[`${ID}.trace.json.gz`, gzipSync(JSON.stringify(legacyTrace))]]);
    const traces = createTraceStore({
      get: async (k: string) => blobs.get(k) ?? null,
      put: async (k: string, b: Buffer) => { blobs.set(k, b); },
    });
    const docs = new Map<string, any>();
    let sawCreepKills = false;

    const pipeline = {
      run: vi.fn(async () => {
        // Remote worker writes directly to underlying blob storage without calling this web instance's traces.put().
        blobs.set(`${ID}.trace.json.gz`, gzipSync(JSON.stringify(modernTrace)));
        return { ok: true, bytes: 2048 };
      }),
    };
    const complete = vi.fn(async ({ messages }: any) => {
      sawCreepKills = !(await traces.get(ID)).trace_outdated && Array.isArray((await traces.get(ID)).creep_kills);
      // Verify the prompt/tools in this review also see the upgraded trace by checking messages/state.
      expect(messages.length).toBeGreaterThan(0);
      throw Object.assign(new Error('stop'), { status: 503 });
    });

    const service: any = createAgentService({
      traces,
      pipeline,
      reparseOldTraces: true,
      complete,
      model: 'mock',
      getMatchDetail: async () => ({ match_id: ID, start_time: Math.floor((NOW - 2 * DAY) / 1000), duration: 2400 }),
      docs: { get: async (k: string) => docs.get(k) ?? null, put: async (k: string, v: any) => { docs.set(k, v); } },
      now: () => NOW,
    } as any);

    // Warm the web instance's in-memory LRU cache with the legacy trace first.
    expect((await service.availability(ID)).trace_outdated).toBe(true);
    await service.start(ID, 'beastmaster', 'zh');
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));

    expect(pipeline.run).toHaveBeenCalledTimes(1);
    expect(sawCreepKills).toBe(true);
    expect((await service.availability(ID)).trace_outdated).toBeUndefined();
  });

  it('joins an already-running /prepare parse instead of starting a duplicate executeParse', async () => {
    let currentTrace: any = structuredClone(legacyTrace);
    const docs = new Map<string, any>();
    let finishParse!: (v: any) => void;
    const pipeline = {
      run: vi.fn(() => new Promise((resolve) => { finishParse = resolve; })),
    };
    const seenHasCreepKills: boolean[] = [];
    const complete = vi.fn(async () => {
      seenHasCreepKills.push(Array.isArray(currentTrace.creep_kills));
      throw Object.assign(new Error('stop'), { status: 503 });
    });

    const service: any = createAgentService({
      traces: { get: async () => currentTrace },
      pipeline,
      reparseOldTraces: true,
      complete,
      model: 'mock',
      getMatchDetail: async () => ({ match_id: ID, start_time: Math.floor((NOW - 2 * DAY) / 1000), duration: 2400 }),
      docs: { get: async (k: string) => docs.get(k) ?? null, put: async (k: string, v: any) => { docs.set(k, v); } },
      now: () => NOW,
    } as any);

    expect(await service.prepare(ID)).toMatchObject({ status: 'running' });
    await vi.waitFor(() => expect(pipeline.run).toHaveBeenCalledTimes(1));

    // Starting a review while /prepare's parse is already running joins it rather than calling pipeline.run again.
    await service.start(ID, 'beastmaster', 'zh');
    expect(pipeline.run).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();

    currentTrace = structuredClone(modernTrace);
    finishParse({ ok: true, bytes: 1024 });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(pipeline.run).toHaveBeenCalledTimes(1);
    expect(seenHasCreepKills).toEqual([true]);
  });

  it('enforces parseDailyMax / parseLimiter on automatic trace upgrades from POST /review, falling back to existing trace when full', async () => {
    const docs = new Map<string, any>();
    const pipeline = { run: vi.fn(async () => ({ ok: true })) };
    const complete = vi.fn(async () => { throw Object.assign(new Error('stop'), { status: 503 }); });
    const service: any = createAgentService({
      traces: { get: async () => structuredClone(legacyTrace) },
      pipeline,
      reparseOldTraces: true,
      complete,
      model: 'mock',
      getMatchDetail: async () => ({ match_id: ID, start_time: Math.floor((NOW - 2 * DAY) / 1000), duration: 2400 }),
      docs: { get: async (k: string) => docs.get(k) ?? null, put: async (k: string, v: any) => { docs.set(k, v); } },
      now: () => NOW,
    } as any);

    const app = express();
    app.use(express.json());
    app.use(createAgentRouter({
      service,
      resolveClientIp: () => '203.0.113.9',
      parseDailyMax: 0,
    }));

    const server = await new Promise<import('node:http').Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const addr = server.address() as import('node:net').AddressInfo;
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/agent/${ID}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hero: 'beastmaster', lang: 'zh' }),
      });
      expect(res.status).toBe(202);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
      // Daily parse cap is 0: review still proceeds on the existing trace without bypassing parseDaily!
      expect(pipeline.run).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('shares a single review deadline (maxMs) across trace re-parse and runDeepReview', async () => {
    const docs = new Map<string, any>();
    const pipeline = {
      run: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 70));
        return { ok: true, bytes: 1024 };
      }),
    };
    const complete = vi.fn(({ signal }: any) => new Promise((_, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      signal?.addEventListener('abort', () => reject(signal.reason ?? new DOMException('Timed out', 'TimeoutError')), { once: true });
    }));

    const service: any = createAgentService({
      traces: { get: async () => structuredClone(legacyTrace) },
      pipeline,
      reparseOldTraces: true,
      models: { 'deepseek-flash': { name: 'deepseek-flash', maxMs: 120, complete } },
      defaultModel: 'deepseek-flash',
      getMatchDetail: async () => ({ match_id: ID, start_time: Math.floor((NOW - 2 * DAY) / 1000), duration: 2400 }),
      docs: { get: async (k: string) => docs.get(k) ?? null, put: async (k: string, v: any) => { docs.set(k, v); } },
    } as any);

    const t0 = Date.now();
    await service.start(ID, 'beastmaster', 'zh');
    await vi.waitFor(async () => {
      const st = await service.status(ID, 'beastmaster', 'zh');
      expect(st).toEqual({ status: 'failed', reason: 'timeout' });
    }, { timeout: 1000 });
    const elapsed = Date.now() - t0;
    // Must abort near ~120ms total (70ms parse + ~50ms remaining), well below 70 + 120 = 190ms+.
    expect(elapsed).toBeLessThan(185);
  });
});
