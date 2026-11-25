import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import { createRemotePipeline, createTracePipeline, replayPastKeeping, LONGEST_GAME_HOURS, REPLAY_KEPT_DAYS } from '../../lib/agent/tracePipeline.js';
import { createAgentService, reviewFailure, MODEL_DOWN_MS, PARSE_BACKOFF_DEFAULT_MS, PARSE_BACKOFF_MS } from '../../lib/agent/service.js';

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
