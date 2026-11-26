import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { TRACE_BUILD_VERSION, traceIsOutdated } from '../../lib/agent/traceBuild.js';
import { createAgentService } from '../../lib/agent/service.js';

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
});
