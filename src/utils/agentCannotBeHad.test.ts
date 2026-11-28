import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import { createRemotePipeline, createTracePipeline, replayPastKeeping, LONGEST_GAME_HOURS, REPLAY_KEPT_DAYS } from '../../lib/agent/tracePipeline.js';
import { createAgentService, reviewFailure, MODEL_DOWN_MS, PARSE_BACKOFF_DEFAULT_MS, PARSE_BACKOFF_MS, PARSE_BACKOFF_MULTIPLIER, parseBackoffMs } from '../../lib/agent/service.js';

/**
 * A review that cannot be had: the reader is told so once, and the log says why.
 * Three readers of 2026-11-25: one asked nine times for a game whose replay no longer exists and got "not ready
 * yet" each time; one waited on a review that failed in a second, twice, because the model account was empty —
 * and the log said "Error".
 */

const ID = 9100904020;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 25, 2, 15, 0);
const trace = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());

describe('a game with no replay address', () => {
  const started = (daysAgo: number, duration = 2400) => ({ match_id: ID, start_time: Math.floor((NOW - daysAgo * DAY) / 1000) - duration, duration });

  it('is past keeping when it ended more than two weeks ago — by the match record\'s own times, and only by those', () => {
    expect(REPLAY_KEPT_DAYS).toBe(14);
    expect(replayPastKeeping(started(15), NOW)).toBe(true);
    expect(replayPastKeeping(started(14.01), NOW)).toBe(true);
    expect(replayPastKeeping(started(13.99), NOW)).toBe(false);
    expect(replayPastKeeping(started(0.01), NOW)).toBe(false);
    // The end is start + duration: a long game that started 14 days and an hour ago ended inside the two weeks.
    expect(replayPastKeeping({ start_time: Math.floor((NOW - 14 * DAY) / 1000) - 3600, duration: 2 * 3600 }, NOW)).toBe(false);
    // No start time: not known, so not said.
    for (const m of [null, undefined, {}, { start_time: null }, { start_time: 0 }, { start_time: 'yesterday' }, { duration: 2400 }]) expect([m, replayPastKeeping(m as any, NOW)]).toEqual([m, false]);
  });

  it('with a start but no duration, "gone" is said only when even the longest game would have ended two weeks ago', () => {
    expect(LONGEST_GAME_HOURS).toBe(24);
    const began = (daysAgo: number, duration: any = undefined) => ({ match_id: ID, start_time: Math.floor((NOW - daysAgo * DAY) / 1000), ...(duration === undefined ? {} : { duration }) });
    // Began 14 days and ten minutes ago, length unknown: an hour-long game ended inside the two weeks. Not said.
    for (const d of [undefined, null, 0, 'long']) expect([d, replayPastKeeping(began(14 + 10 / 1440, d), NOW)]).toEqual([d, false]);
    expect(replayPastKeeping(began(14.9), NOW)).toBe(false);
    // Began more than fifteen days ago: whatever its length, it ended more than fourteen days ago.
    expect(replayPastKeeping(began(15.01), NOW)).toBe(true);
    expect(replayPastKeeping(began(300), NOW)).toBe(true);
    // The same start with its length known is judged by its real end.
    expect(replayPastKeeping(began(14 + 10 / 1440, 300), NOW)).toBe(true);
    expect(replayPastKeeping(began(14 + 10 / 1440, 3600), NOW)).toBe(false);
    expect(replayPastKeeping(started(30), NaN)).toBe(false);
  });

  it('the pipeline says "gone" for an old game and "not yet" for a new one or one whose age it cannot tell', async () => {
    const run = (match: any) => createTracePipeline({ getMatchDetail: async () => match, extractorBin: '/nonexistent', store: { put: async () => {} }, now: () => NOW }).run(ID);
    expect(await run(started(300))).toMatchObject({ ok: false, reason: 'replay_gone' });
    // A record with no duration (the STRATZ and game-coordinator mappings can give none): gone when it began months
    // ago, "not yet" when it began 14 days and ten minutes ago.
    expect(await run({ match_id: ID, start_time: Math.floor((NOW - 300 * DAY) / 1000), duration: null })).toMatchObject({ reason: 'replay_gone' });
    expect(await run({ match_id: ID, start_time: Math.floor((NOW - 14 * DAY - 600_000) / 1000), duration: null })).toMatchObject({ reason: 'no_replay_url' });
    expect(await run(started(0.002))).toMatchObject({ ok: false, reason: 'no_replay_url' });
    expect(await run({ match_id: ID })).toMatchObject({ ok: false, reason: 'no_replay_url' });
    // An address that is not a replay host is still no address: old game, gone; new game, not yet.
    expect(await run({ ...started(300), replay_url: 'http://169.254.169.254/latest/meta-data' })).toMatchObject({ reason: 'replay_gone' });
    expect(await run({ ...started(1), replay_url: 'http://169.254.169.254/latest/meta-data' })).toMatchObject({ reason: 'no_replay_url' });
    // The same on the web side of a worker: nothing is posted for either.
    const fetchImpl = vi.fn();
    const remote = (match: any) => createRemotePipeline({ url: 'https://worker.example', getMatchDetail: async () => match, fetchImpl: fetchImpl as any, now: () => NOW }).run(ID);
    expect(await remote(started(300))).toMatchObject({ ok: false, reason: 'replay_gone' });
    expect(await remote(started(1))).toMatchObject({ ok: false, reason: 'no_replay_url' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('an expired match that still has a replay_url upgrades a failed download to replay_gone without hitting the fallback worker (#487)', async () => {
    const expiredUrl = `http://replay132.valve.net/570/${ID}_123456789.dem.bz2`;
    const oldMatch = { ...started(300), replay_url: expiredUrl };
    const recentMatch = { ...started(2), replay_url: expiredUrl };

    // Local pipeline: expired match failing download (edge download_failed or HTTP 503 or tiny body) → replay_gone.
    const localFail = (match: any, over: any) => createTracePipeline({
      getMatchDetail: async () => match,
      extractorBin: '/nonexistent',
      store: { put: async () => {} },
      now: () => NOW,
      ...over,
    }).run(ID);
    expect(await localFail(oldMatch, { downloadImpl: async () => { throw Object.assign(new Error('download_failed'), { code: 'download_failed', why: 'every_edge_failed' }); } })).toEqual({ ok: false, reason: 'replay_gone' });
    expect(await localFail(oldMatch, { fetchReplayImpl: async () => ({ ok: false, status: 503, body: null }) })).toEqual({ ok: false, reason: 'replay_gone' });
    // Local disk write_error is NOT replay_gone.
    expect(await localFail(oldMatch, { downloadImpl: async () => { throw Object.assign(new Error('download_failed'), { code: 'download_failed', why: 'write_error' }); } })).toEqual({ ok: false, reason: 'download_failed' });
    // Recent match failing download stays retryable download_failed.
    expect(await localFail(recentMatch, { downloadImpl: async () => { throw Object.assign(new Error('download_failed'), { code: 'download_failed', why: 'every_edge_failed' }); } })).toEqual({ ok: false, reason: 'download_failed' });

    // Remote pipeline: expired match failing on primary worker with download_failed or timeout returns replay_gone immediately and NEVER calls fallback worker.
    for (const workerReason of ['download_failed', 'timeout']) {
      const hosts: string[] = [];
      const stageLines: string[] = [];
      const res = await createRemotePipeline({
        url: 'https://tw.example',
        fallback: { url: 'https://hk.example' },
        getMatchDetail: async () => oldMatch,
        now: () => NOW,
        stageLog: (l: string) => stageLines.push(l),
        fetchImpl: (async (u: string) => {
          hosts.push(new URL(u).host);
          return new Response(JSON.stringify({ ok: false, reason: workerReason }), { status: 200 });
        }) as any,
      }).run(ID);
      expect(res).toEqual({ ok: false, reason: 'replay_gone' });
      expect(hosts).toEqual(['tw.example']);
      expect(JSON.parse(stageLines[0])).toMatchObject({ event: 'trace_pipeline', match: ID, host: 'replay132.valve.net', worker: 'primary', reason: 'replay_gone', detail: 'past_keeping' });
    }

    // Rare pro/TI archive replay that DOES download still succeeds even when past keeping!
    const archive = await createRemotePipeline({
      url: 'https://tw.example',
      fallback: { url: 'https://hk.example' },
      getMatchDetail: async () => oldMatch,
      now: () => NOW,
      fetchImpl: (async () => new Response(JSON.stringify({ ok: true, bytes: 99_999 }), { status: 200 })) as any,
    }).run(ID);
    expect(archive).toEqual({ ok: true, bytes: 99_999 });

    // Worker 500 (worker_failed) on an expired match still tries fallback; if fallback says download_failed, upgrades to replay_gone.
    const hosts2: string[] = [];
    const afterWorkerErr = await createRemotePipeline({
      url: 'https://tw.example',
      fallback: { url: 'https://hk.example' },
      getMatchDetail: async () => oldMatch,
      now: () => NOW,
      fetchImpl: (async (u: string) => {
        const host = new URL(u).host;
        hosts2.push(host);
        return host === 'tw.example'
          ? new Response('boom', { status: 500 })
          : new Response(JSON.stringify({ ok: false, reason: 'download_failed' }), { status: 200 });
      }) as any,
    }).run(ID);
    expect(hosts2).toEqual(['tw.example', 'hk.example']);
    expect(afterWorkerErr).toEqual({ ok: false, reason: 'replay_gone' });

    // Worker-to-remote write_error on an expired archived replay: primary falls back to second worker, and if both
    // hit local disk write_error, stays retryable download_failed instead of permanently marking replay_gone (Codex P1).
    const runWorkerSim = async (replayUrlInput: string, downloadImpl: any) => {
      let metrics: any = null;
      const wp = createTracePipeline({
        getMatchDetail: async () => ({ match_id: ID, replay_url: replayUrlInput }),
        extractorBin: '/nonexistent',
        store: { put: async () => {} },
        downloadImpl,
        onMetrics: (m: any) => { metrics = m; },
      } as any);
      const out = await wp.run(ID);
      return new Response(JSON.stringify({
        ...out,
        ...(typeof metrics?.detail === 'string' && metrics.detail ? { detail: metrics.detail } : {}),
        ...(metrics ? { metrics: { downloading_ms: metrics.downloading_ms, extracting_ms: metrics.extracting_ms, building_ms: metrics.building_ms, storing_ms: metrics.storing_ms, demo_bytes: metrics.demo_bytes } } : {}),
      }), { status: 200 });
    };
    const writeErrHosts: string[] = [];
    const writeErrLogs: string[] = [];
    const writeErrBoth = await createRemotePipeline({
      url: 'https://tw.example',
      fallback: { url: 'https://hk.example' },
      getMatchDetail: async () => oldMatch,
      now: () => NOW,
      stageLog: (l: string) => writeErrLogs.push(l),
      fetchImpl: (async (u: string, init: any) => {
        writeErrHosts.push(new URL(u).host);
        const { replay_url } = JSON.parse(String(init.body));
        return runWorkerSim(replay_url, async () => { throw Object.assign(new Error('download_failed'), { code: 'download_failed', why: 'write_error' }); });
      }) as any,
    }).run(ID);
    expect(writeErrHosts).toEqual(['tw.example', 'hk.example']);
    expect(writeErrBoth).toEqual({ ok: false, reason: 'download_failed' });
    expect(JSON.parse(writeErrLogs[0])).toMatchObject({ worker: 'fallback', fallback_tried: true, reason: 'download_failed', detail: 'write_error' });

    // Primary write_error on an expired archive replay falls back to a healthy second worker and succeeds.
    const writeErrRecoveredHosts: string[] = [];
    const writeErrRecovered = await createRemotePipeline({
      url: 'https://tw.example',
      fallback: { url: 'https://hk.example' },
      getMatchDetail: async () => oldMatch,
      now: () => NOW,
      fetchImpl: (async (u: string, init: any) => {
        const host = new URL(u).host;
        writeErrRecoveredHosts.push(host);
        if (host === 'tw.example') {
          const { replay_url } = JSON.parse(String(init.body));
          return runWorkerSim(replay_url, async () => { throw Object.assign(new Error('download_failed'), { code: 'download_failed', why: 'write_error' }); });
        }
        return new Response(JSON.stringify({ ok: true, bytes: 88_888 }), { status: 200 });
      }) as any,
    }).run(ID);
    expect(writeErrRecoveredHosts).toEqual(['tw.example', 'hk.example']);
    expect(writeErrRecovered).toEqual({ ok: true, bytes: 88_888 });
  });
});

describe('asking again after a parse failed', () => {
  const make = (reason: string) => {
    const clock = { t: NOW }; const docs = new Map<string, any>();
    const pipeline = { run: vi.fn(async () => ({ ok: false, reason })) };
    const service: any = createAgentService({ traces: { get: async () => null }, complete: null, pipeline, docs: { get: async (k: string) => docs.get(k) ?? null, put: async (k: string, v: any) => { docs.set(k, v); } }, now: () => clock.t } as any);
    return { clock, pipeline, service };
  };
  const failedBy = async (h: ReturnType<typeof make>) => { await h.service.prepare(ID); await vi.waitFor(async () => expect((await h.service.availability(ID)).parse.status).toBe('failed')); };

  it('a replay address that was not there a second ago is not asked for again for a minute — the same answer, with how long is left', async () => {
    const h = make('no_replay_url');
    await failedBy(h);
    expect(PARSE_BACKOFF_MS.no_replay_url).toBe(60_000);
    // Seven clicks in fifteen seconds, as one reader did: one parse.
    for (let i = 0; i < 7; i += 1) { h.clock.t += 2000; expect(await h.service.prepare(ID)).toEqual({ status: 'failed', reason: 'no_replay_url', final: false, retry_in_sec: 60 - 2 * (i + 1) }); }
    expect(h.pipeline.run).toHaveBeenCalledTimes(1);
    // A refused start is never charged: `admit` is not asked while the back-off lasts.
    const admit = vi.fn(() => null);
    await h.service.prepare(ID, { admit });
    expect(admit).not.toHaveBeenCalled();
    // Once the minute is over the next ask starts a parse, and is charged for it.
    h.clock.t = NOW + 61_000;
    expect((await h.service.availability(ID)).parse).toEqual({ status: 'failed', reason: 'no_replay_url', final: false, retry_in_sec: 0 });
    expect(await h.service.prepare(ID, { admit })).toMatchObject({ status: 'running' });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(h.pipeline.run).toHaveBeenCalledTimes(2);
  });

  it('any other failure can be tried again after ten seconds: a double click does not start two downloads', async () => {
    const h = make('download_failed');
    await failedBy(h);
    expect(PARSE_BACKOFF_DEFAULT_MS).toBe(10_000);
    h.clock.t += 1000;
    expect(await h.service.prepare(ID)).toEqual({ status: 'failed', reason: 'download_failed', final: false, retry_in_sec: 9 });
    expect(h.pipeline.run).toHaveBeenCalledTimes(1);
    h.clock.t += 10_000;
    expect(await h.service.prepare(ID)).toMatchObject({ status: 'running' });
    expect(h.pipeline.run).toHaveBeenCalledTimes(2);
  });

  it('a replay that is gone has no "again": final, with no time to wait for', async () => {
    const h = make('replay_gone');
    await failedBy(h);
    h.clock.t += 3_600_000;
    expect(await h.service.prepare(ID)).toEqual({ status: 'failed', reason: 'replay_gone', final: true });
    expect(h.pipeline.run).toHaveBeenCalledTimes(1);
  });

  it('consecutive parse failures escalate backoff (10s → 30s → 90s → 270s → 300s) and survive Cloud Tasks dispatch; stale deliveries never re-run (#487)', async () => {
    expect(PARSE_BACKOFF_MULTIPLIER).toBe(3);
    expect([1, 2, 3, 4, 5].map((n) => parseBackoffMs('download_failed', n))).toEqual([10_000, 30_000, 90_000, 270_000, 300_000]);
    expect([1, 2, 3].map((n) => parseBackoffMs('no_replay_url', n))).toEqual([60_000, 180_000, 300_000]);

    // Simulate two Cloud Run instances sharing GCS docs and a Cloud Tasks queue.
    const clock = { t: NOW };
    const docsMap = new Map<string, any>();
    const docs = { get: async (k: string) => docsMap.get(k) ?? null, put: async (k: string, v: any) => { docsMap.set(k, v); } };
    const queue: any[] = [];
    const pipelineRun = vi.fn(async () => ({ ok: false, reason: 'download_failed' }));
    const makeInst = () => createAgentService({
      traces: { get: async () => null },
      complete: null,
      pipeline: { run: pipelineRun },
      docs,
      dispatch: async (task: any) => { queue.push(task); },
      now: () => clock.t,
    } as any);
    const front = makeInst();
    const worker = makeInst();

    // Attempt 1 fails → 10s backoff.
    expect(await front.prepare(ID)).toEqual({ status: 'running', stage: 'locating' });
    expect(await worker.run(queue.shift())).toEqual({ status: 'failed', reason: 'download_failed' });
    expect((await front.availability(ID)).parse).toEqual({ status: 'failed', reason: 'download_failed', final: false, retry_in_sec: 10 });

    // A duplicate Cloud Task delivery arriving while inside backoff is ignored (200-equivalent), not re-run.
    clock.t += 4_000;
    expect(await worker.run({ kind: 'parse', matchId: String(ID) })).toEqual({ status: 'failed', reason: 'download_failed' });
    expect(pipelineRun).toHaveBeenCalledTimes(1);

    // After 10s, Attempt 2 runs and fails → escalates to 30s backoff!
    clock.t += 7_000;
    expect(await front.prepare(ID)).toEqual({ status: 'running', stage: 'locating' });
    expect(await worker.run(queue.shift())).toEqual({ status: 'failed', reason: 'download_failed' });
    expect(pipelineRun).toHaveBeenCalledTimes(2);
    expect((await front.availability(ID)).parse).toEqual({ status: 'failed', reason: 'download_failed', final: false, retry_in_sec: 30 });

    // 15s later (previously enough to trigger a 3rd loop!), prepare is STILL blocked for 15s more.
    clock.t += 15_000;
    const admit = vi.fn(() => null);
    expect(await front.prepare(ID, { admit })).toEqual({ status: 'failed', reason: 'download_failed', final: false, retry_in_sec: 15 });
    expect(admit).not.toHaveBeenCalled();
    expect(queue).toHaveLength(0);

    // After 30s total, Attempt 3 runs and fails → escalates to 90s backoff!
    clock.t += 16_000;
    expect(await front.prepare(ID)).toEqual({ status: 'running', stage: 'locating' });
    expect(await worker.run(queue.shift())).toEqual({ status: 'failed', reason: 'download_failed' });
    expect(pipelineRun).toHaveBeenCalledTimes(3);
    expect((await front.availability(ID)).parse).toEqual({ status: 'failed', reason: 'download_failed', final: false, retry_in_sec: 90 });

    // After PARSE_RETRY_MS (5 minutes), failure history resets back to 10s.
    clock.t += 301_000;
    expect((await front.availability(ID)).parse).toEqual({ status: 'none' });
    expect(await front.prepare(ID)).toEqual({ status: 'running', stage: 'locating' });
    expect(await worker.run(queue.shift())).toEqual({ status: 'failed', reason: 'download_failed' });
    expect((await front.availability(ID)).parse).toEqual({ status: 'failed', reason: 'download_failed', final: false, retry_in_sec: 10 });

    // Duplicate delivery for a final replay_gone parse NEVER re-runs, even hours later.
    const goneRun = vi.fn(async () => ({ ok: false, reason: 'replay_gone' }));
    const goneDocs = new Map<string, any>();
    const goneSvc: any = createAgentService({
      traces: { get: async () => null },
      complete: null,
      pipeline: { run: goneRun },
      docs: { get: async (k: string) => goneDocs.get(k) ?? null, put: async (k: string, v: any) => { goneDocs.set(k, v); } },
      now: () => clock.t,
    } as any);
    expect(await goneSvc.run({ kind: 'parse', matchId: String(ID) })).toEqual({ status: 'failed', reason: 'replay_gone' });
    clock.t += 3_600_000;
    expect(await goneSvc.run({ kind: 'parse', matchId: String(ID) })).toEqual({ status: 'failed', reason: 'replay_gone' });
    expect(goneRun).toHaveBeenCalledTimes(1);
  });
});

describe('why a review\'s model call failed', () => {
  const err = (status: number | undefined, name = 'Error', message = 'Insufficient Balance for key sk-secret-abc') => Object.assign(new Error(message), { name, ...(status === undefined ? {} : { status }) });

  it('is read off the status and the error\'s name', () => {
    expect(reviewFailure(err(402))).toEqual({ reason: 'model_out_of_credit', status: 402 });
    expect(reviewFailure(err(401))).toEqual({ reason: 'model_refused_the_key', status: 401 });
    expect(reviewFailure(err(403))).toEqual({ reason: 'model_refused_the_key', status: 403 });
    expect(reviewFailure(err(429))).toEqual({ reason: 'model_rate_limited', status: 429 });
    expect(reviewFailure(err(500))).toEqual({ reason: 'model_unavailable', status: 500 });
    expect(reviewFailure(err(503))).toEqual({ reason: 'model_unavailable', status: 503 });
    expect(reviewFailure(err(undefined, 'TimeoutError'))).toEqual({ reason: 'timeout', status: null });
    expect(reviewFailure(err(undefined, 'AbortError'))).toEqual({ reason: 'timeout', status: null });
    // The SDK's own errors, as it makes them (openai 4.x): every one of these has the name "Error".
    const sdk = { timeout: new APIConnectionTimeoutError(), connection: new APIConnectionError({ message: 'socket hang up' }), aborted: new APIUserAbortError(), credit: APIError.generate(402, { error: { message: 'Insufficient Balance' } }, '402 Insufficient Balance', {} as any), limited: APIError.generate(429, {}, '429', {} as any), down: APIError.generate(503, {}, '503', {} as any) };
    expect(Object.values(sdk).map((e) => e.name)).toEqual(['Error', 'Error', 'Error', 'Error', 'Error', 'Error']);
    expect(reviewFailure(sdk.timeout)).toEqual({ reason: 'timeout', status: null });
    expect(reviewFailure(sdk.connection)).toEqual({ reason: 'model_unavailable', status: null });
    // The service's own deadline firing reaches it as the SDK's abort error.
    expect(reviewFailure(sdk.aborted)).toEqual({ reason: 'timeout', status: null });
    expect(reviewFailure(sdk.credit)).toEqual({ reason: 'model_out_of_credit', status: 402 });
    expect(reviewFailure(sdk.limited)).toEqual({ reason: 'model_rate_limited', status: 429 });
    expect(reviewFailure(sdk.down)).toEqual({ reason: 'model_unavailable', status: 503 });
    expect(reviewFailure(err(undefined))).toEqual({ reason: 'error', status: null });
    expect(reviewFailure(err(400))).toEqual({ reason: 'error', status: 400 });
    for (const not of [null, undefined, 'boom', {}]) expect(reviewFailure(not)).toEqual({ reason: 'error', status: null });
  });

  const make = (complete: any) => {
    const clock = { t: NOW }; const docs = new Map<string, any>(); const lines: string[] = [];
    const service: any = createAgentService({ traces: { get: async () => trace }, complete, model: 'mock', docs: { get: async (k: string) => docs.get(k) ?? null, put: async (k: string, v: any) => { docs.set(k, v); } }, now: () => clock.t, log: (m: string) => lines.push(m) } as any);
    return { clock, service, lines };
  };
  const failedReview = async (h: ReturnType<typeof make>) => vi.waitFor(async () => { const s = await h.service.status(ID, 'beastmaster', 'zh'); expect(s.status).toBe('failed'); return s; });

  it('an empty account: the review fails with that reason, the log says so without the provider\'s words, and no further review is started for five minutes', async () => {
    const complete = vi.fn(async () => { throw err(402); });
    const h = make(complete);
    expect(await h.service.start(ID, 'beastmaster', 'zh')).toMatchObject({ status: 'running' });
    expect(await failedReview(h)).toEqual({ status: 'failed', reason: 'model_out_of_credit' });
    const line = h.lines.find((l) => l.startsWith('deep-review error'))!;
    expect(line).toBe(`deep-review error match=${ID} hero=beastmaster plan=none: reason=model_out_of_credit status=402 (Error)`);
    expect(h.lines.join('\\n')).not.toMatch(/Insufficient|sk-secret/);
    // The reader who tries again, and the next reader, are told at once — no slot charged, no model called.
    const admit = vi.fn(() => null);
    // With how long is left: the page keeps a way to try again.
    expect(await h.service.start(ID, 'beastmaster', 'zh', { admit })).toEqual({ status: 'unavailable', reason: 'model_out_of_credit', retry_in_sec: 300 });
    h.clock.t += 60_000;
    expect(await h.service.start(ID, 'sven', 'zh', { admit })).toEqual({ status: 'unavailable', reason: 'model_out_of_credit', retry_in_sec: 240 });
    h.clock.t -= 60_000;
    expect(admit).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    // Five minutes on (time to top the account up) a review is tried again.
    expect(MODEL_DOWN_MS).toBe(300_000);
    h.clock.t += MODEL_DOWN_MS + 1000;
    expect(await h.service.start(ID, 'sven', 'zh', { admit })).toMatchObject({ status: 'running' });
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it('a rate limit or a timeout fails that review with its reason and holds nobody else back', async () => {
    // The SDK's real timeout and connection errors among them: the log names the class, since their name is "Error".
    for (const [e, reason, tail] of [[err(429), 'model_rate_limited', 'reason=model_rate_limited status=429 (Error)'], [new APIConnectionTimeoutError(), 'timeout', 'reason=timeout (APIConnectionTimeoutError)'], [new APIUserAbortError(), 'timeout', 'reason=timeout (APIUserAbortError)'], [new APIConnectionError({ message: 'getaddrinfo ENOTFOUND secret-host' }), 'model_unavailable', 'reason=model_unavailable (APIConnectionError)']] as const) {
      const h = make(vi.fn(async () => { throw e; }));
      await h.service.start(ID, 'beastmaster', 'zh');
      expect(await failedReview(h)).toEqual({ status: 'failed', reason });
      expect(h.lines.find((l) => l.startsWith('deep-review error'))).toContain(tail);
      expect(h.lines.join('\n')).not.toMatch(/ENOTFOUND|secret-host/);
      expect(await h.service.start(ID, 'sven', 'zh')).toMatchObject({ status: 'running' });
    }
  });
});
