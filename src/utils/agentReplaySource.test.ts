import { describe, expect, it, vi } from 'vitest';
import { classifyGcFailure, createReplaySource } from '../../lib/agent/replaySource.js';
import { replayUrl } from '../../lib/matchReview/replayIngest/discovery.js';
import { createTracePipeline } from '../../lib/agent/tracePipeline.js';

const ID = 9101399999;
describe('replay source', () => {
  it('uses the match record when it has an address, and never asks the game coordinator then', async () => {
    const gc = { fetchMatch: vi.fn() };
    const src = createReplaySource({ getMatchDetail: async () => ({ match_id: ID, replay_url: `http://replay1.valve.net/570/${ID}_5.dem.bz2` }), gc });
    expect(replayUrl(await src(ID))).toBe(`http://replay1.valve.net/570/${ID}_5.dem.bz2`);
    expect(gc.fetchMatch).not.toHaveBeenCalled();
  });

  it('asks the game coordinator when the record has none, or when the record cannot be fetched', async () => {
    const gc = { fetchMatch: vi.fn(async () => ({ match_id: ID, cluster: 153, replay_salt: 77, players: [{ account_id: 1 }] })) };
    const none = createReplaySource({ getMatchDetail: async () => ({ match_id: ID, players: [] }), gc });
    const got = await none(ID);
    expect(replayUrl(got)).toBe(`https://replay153.valve.net/570/${ID}_77.dem.bz2`);
    // Only what the address needs is passed on.
    expect(got).toEqual({ match_id: ID, cluster: 153, replay_salt: 77 });
    const down = createReplaySource({ getMatchDetail: async () => { throw new Error('opendota 520'); }, gc });
    expect(replayUrl(await down(ID))).toBe(`https://replay153.valve.net/570/${ID}_77.dem.bz2`);
  });

  it('no address anywhere: the record as it was; no source at all: the error', async () => {
    const record = { match_id: ID, players: [] };
    expect(await createReplaySource({ getMatchDetail: async () => record })(ID)).toBe(record);
    expect(await createReplaySource({ getMatchDetail: async () => record, gc: { fetchMatch: async () => ({ match_id: ID }) } })(ID)).toBe(record);
    expect(await createReplaySource({ getMatchDetail: async () => record, gc: { fetchMatch: async () => { throw Object.assign(new Error('x'), { code: 'gc_budget' }); } } })(ID)).toBe(record);
    await expect(createReplaySource({ getMatchDetail: async () => { throw new Error('down'); } })(ID)).rejects.toThrow('down');
    await expect(createReplaySource({ getMatchDetail: async () => { throw new Error('down'); }, gc: { fetchMatch: async () => { throw new Error('gc down'); } } })(ID)).rejects.toThrow('down');
  });

  it('the pipeline downloads from the coordinator\'s address', async () => {
    const seen: string[] = [];
    const pipeline = createTracePipeline({
      getMatchDetail: createReplaySource({ getMatchDetail: async () => ({ match_id: ID }), gc: { fetchMatch: async () => ({ cluster: 153, replay_salt: 77 }) } }),
      extractorBin: '/bin/x', store: { put: async () => {} },
      fetchReplayImpl: (async (url: string) => { seen.push(url); return { ok: false, status: 404, body: null }; }) as any,
    } as any);
    expect(await pipeline.run(ID)).toEqual({ ok: false, reason: 'replay_gone' });
    expect(seen).toEqual([`https://replay153.valve.net/570/${ID}_77.dem.bz2`]);
  });

  it('logs structured GC outcomes without leaking upstream text', async () => {
    const logs: string[] = [];
    const record = { match_id: ID, players: [] };
    await createReplaySource({ getMatchDetail: async () => record, log: (m) => logs.push(m) })(ID);
    await createReplaySource({ getMatchDetail: async () => record, gc: { fetchMatch: async () => ({ match_id: ID }) }, log: (m) => logs.push(m) })(ID);
    await createReplaySource({ getMatchDetail: async () => record, gc: { fetchMatch: async () => { throw Object.assign(new Error('secret'), { code: 'gc_budget' }); } }, log: (m) => logs.push(m) })(ID);
    await createReplaySource({ getMatchDetail: async () => record, gc: { fetchMatch: async () => ({ cluster: 153, replay_salt: 77 }) }, log: (m) => logs.push(m) })(ID);
    expect(logs).toEqual([
      `replay_source match=${ID} outcome=gc_not_configured`,
      `replay_source match=${ID} outcome=gc_no_replay`,
      `replay_source match=${ID} outcome=gc_rate_limited detail=gc_budget`,
      `replay_source match=${ID} outcome=gc_ok`,
    ]);
    expect(classifyGcFailure({ status: 429 })).toBe('gc_rate_limited');
    expect(classifyGcFailure({ status: 404 })).toBe('gc_not_found');
    expect(classifyGcFailure({ status: 503 })).toBe('gc_unavailable');
  });
});
