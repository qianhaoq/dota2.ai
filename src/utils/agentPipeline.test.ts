import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createRemotePipeline, createTracePipeline, replayUrlIsFor } from '../../lib/agent/tracePipeline.js';
import { createBucketStore, createFileStore, createJsonStore, createTraceStore } from '../../lib/agent/stores.js';
import { createAgentService } from '../../lib/agent/service.js';

const root = mkdtempSync(join(tmpdir(), 'agent-pipe-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fixture = gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url)));
const ID = 9100904020;
const URL_OK = `http://replay413.dota2.com.cn/570/${ID}_1851930271.dem.bz2`;
const body = (bytes: Buffer) => new Response(new Uint8Array(bytes)).body;

/** A pipeline whose network and extractor are faked; the builder returns the real fixture trace. */
function harness(over: any = {}) {
  const work = mkdtempSync(join(root, 'work-'));
  const put = vi.fn(async () => {});
  const stages: string[] = [];
  const seen: any = {};
  const pipeline = createTracePipeline({
    getMatchDetail: async () => ({ match_id: ID, replay_url: URL_OK }),
    extractorBin: '/bin/extract',
    store: { put },
    workRoot: work,
    fetchReplayImpl: async (url: string) => { seen.url = url; return { ok: true, status: 200, body: body(Buffer.alloc(4096, 7)) }; },
    runExtractorImpl: async (bin: string, args: string[]) => { seen.bin = bin; seen.args = args; seen.demoBytes = readFileSync(args[0]).length; return { ok: true, match_id: ID, trace_version: 4, clock: { zero: 'horn' } }; },
    buildImpl: async (_dir: string, meta: any) => ({ ...JSON.parse(fixture.toString()), source: { extractor: meta.extractor } }),
    ...over,
  } as any);
  return { pipeline, put, stages, seen, work, run: (id: any = ID) => pipeline.run(id, { onStage: (s: string) => stages.push(s) }) };
}

describe('trace pipeline', () => {
  it('replay → trace: every stage in order, the trace stored gzipped, the work directory removed', async () => {
    const h = harness();
    const out = await h.run();
    expect(out).toMatchObject({ ok: true });
    expect(h.stages).toEqual(['locating', 'downloading', 'extracting', 'building', 'storing']);
    expect(h.seen.url).toBe(URL_OK);
    expect(h.seen.bin).toBe('/bin/extract');
    expect(h.seen.args.slice(2)).toEqual(['--max-bytes', '512000000', '--max-output-bytes', '1500000000', '--quiet']);
    expect(h.seen.demoBytes).toBe(4096);
    const [id, stored] = h.put.mock.calls[0] as any[];
    expect(id).toBe(ID);
    expect(JSON.parse(gunzipSync(stored).toString())).toMatchObject({ schema: 'dota2.ai/match-trace@1', match_id: ID, source: { extractor: { trace_version: 4, clock: { zero: 'horn' } } } });
    expect(readdirSync(h.work)).toEqual([]);
  });

  it('builds the address from cluster and salt when the record has no replay_url', async () => {
    const h = harness({ getMatchDetail: async () => ({ match_id: ID, cluster: 413, replay_salt: 1851930271 }) });
    expect((await h.run()).ok).toBe(true);
    expect(h.seen.url).toBe(`https://replay413.valve.net/570/${ID}_1851930271.dem.bz2`);
  });

  it('every way it can fail is a reason, and nothing is stored or left behind', async () => {
    const cases: [string, any][] = [
      ['no_match', { getMatchDetail: async () => { throw new Error('upstream'); } }],
      ['no_replay_url', { getMatchDetail: async () => ({ match_id: ID }) }],
      // Only Valve / Perfect World replay hosts are ever fetched.
      ['no_replay_url', { getMatchDetail: async () => ({ match_id: ID, replay_url: 'http://169.254.169.254/latest/meta-data' }) }],
      ['no_replay_url', { getMatchDetail: async () => ({ match_id: ID, replay_url: 'http://replay1.valve.net.evil.example/570/1_1.dem.bz2' }) }],
      ['replay_gone', { fetchReplayImpl: async () => ({ ok: false, status: 404, body: body(Buffer.from('x')) }) }],
      ['download_failed', { fetchReplayImpl: async () => ({ ok: false, status: 503, body: body(Buffer.from('x')) }) }],
      ['download_failed', { fetchReplayImpl: async () => { throw new Error('socket'); } }],
      ['download_failed', { fetchReplayImpl: async () => ({ ok: true, status: 200, body: body(Buffer.alloc(10)) }) }],
      ['too_large', { maxDownloadBytes: 2048 }],
      ['extract_failed', { runExtractorImpl: async () => { throw new Error('extractor_failed'); } }],
      ['wrong_match', { runExtractorImpl: async () => ({ ok: true, match_id: 42 }) }],
      ['extract_failed', { buildImpl: async () => { throw new Error('bad rows'); } }],
      ['extract_failed', { buildImpl: async () => ({ heroes: [1, 2], n: 2000 }) }],
      ['store_failed', { store: { put: async () => { throw new Error('gcs'); } } }],
    ];
    for (const [reason, over] of cases) {
      const h = harness(over);
      expect(await h.run(), reason).toEqual({ ok: false, reason });
      if (reason !== 'store_failed') expect(h.put).not.toHaveBeenCalled();
      expect(readdirSync(h.work), reason).toEqual([]);
    }
    for (const bad of [0, -1, 'abc', 1.5]) expect(await harness().run(bad)).toEqual({ ok: false, reason: 'no_match' });
  });

  it('remote: finds the replay address here, posts it to the worker with the auth header, relays the answer', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, bytes: 246397 }), { status: 200 }));
    const stages: string[] = [];
    const getMatchDetail = async () => ({ match_id: ID, replay_url: URL_OK });
    const remote = createRemotePipeline({ url: 'https://trace-worker.example', getMatchDetail, auth: async () => 'Bearer token', fetchImpl: fetchImpl as any });
    expect(await remote.run(ID, { onStage: (s: string) => stages.push(s) })).toEqual({ ok: true, bytes: 246397 });
    const [url, init] = fetchImpl.mock.calls[0] as any[];
    expect(url).toBe('https://trace-worker.example/run');
    expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer token' } });
    expect(JSON.parse(init.body)).toEqual({ match_id: ID, replay_url: URL_OK });
    expect(stages).toEqual(['locating', 'downloading']);
    const answers: [any, any][] = [[new Response('{"ok":false,"reason":"replay_gone"}', { status: 200 }), 'replay_gone'], [new Response('oops', { status: 500 }), 'worker_failed'], [null, 'worker_failed']];
    for (const [res, reason] of answers) expect(await createRemotePipeline({ url: 'https://w.example', getMatchDetail, fetchImpl: (async () => { if (!res) throw new Error('down'); return res; }) as any }).run(ID)).toEqual({ ok: false, reason });
    // No address, or not a replay host: the worker is never called.
    const never = vi.fn();
    expect(await createRemotePipeline({ url: 'https://w.example', getMatchDetail: async () => ({ match_id: ID }), fetchImpl: never as any }).run(ID)).toEqual({ ok: false, reason: 'no_replay_url' });
    expect(await createRemotePipeline({ url: 'https://w.example', getMatchDetail: async () => ({ replay_url: 'http://10.0.0.1/570/1_1.dem.bz2' }), fetchImpl: never as any }).run(ID)).toEqual({ ok: false, reason: 'no_replay_url' });
    expect(never).not.toHaveBeenCalled();
  });

  it('a replay address must be for the match it is said to be for', () => {
    expect(replayUrlIsFor(URL_OK, ID)).toBe(true);
    expect(replayUrlIsFor(`https://replay413.valve.net/570/${ID}_1851930271.dem.bz2`, ID)).toBe(true);
    for (const bad of [`http://replay413.dota2.com.cn/570/1234_1851930271.dem.bz2`, `http://example.com/570/${ID}_1.dem.bz2`, `http://replay413.dota2.com.cn/570/${ID}_1.dem.bz2/../x`, '', null, 42]) expect(replayUrlIsFor(bad as any, ID)).toBe(false);
  });
});

describe('stores', () => {
  it('file blobs: atomic writes, safe keys, misses are null', async () => {
    const dir = join(root, 'blobs');
    const store = createFileStore(dir);
    expect(await store.get('a.json')).toBeNull();
    await store.put('a.json', Buffer.from('1'));
    expect((await store.get('a.json'))!.toString()).toBe('1');
    expect(readdirSync(dir)).toEqual(['a.json']);
    await expect(store.put('../x', Buffer.from('1'))).rejects.toThrow('invalid_key');
    expect(await store.get('../a.json')).toBeNull();
    expect(await createFileStore(null).get('a.json')).toBeNull();
  });
  it('bucket blobs sit under a prefix; a failed download is a miss', async () => {
    const objects = new Map<string, Buffer>();
    const bucket = { file: (key: string) => ({ download: async () => { if (!objects.has(key)) throw Object.assign(new Error('gcs'), { code: 404 }); return [objects.get(key)]; }, save: async (b: Buffer) => { objects.set(key, b); } }) };
    const store = createBucketStore(bucket, 'agent/');
    await store.put('x.json', Buffer.from('{"a":1}'));
    expect([...objects.keys()]).toEqual(['agent/x.json']);
    expect(await createJsonStore(store).get('x.json')).toEqual({ a: 1 });
    expect(await store.get('missing')).toBeNull();
  });
  it('trace store: validates what it reads, caches a few, and forgets a match on put', async () => {
    const dir = join(root, 'traces'); mkdirSync(dir, { recursive: true });
    const blobs = createFileStore(dir);
    const store = createTraceStore(blobs, { keep: 1 });
    expect(await store.get(ID)).toBeNull();
    await store.put(ID, gzipSync(fixture));
    const t = await store.get(ID);
    expect(t.heroes).toHaveLength(10);
    expect(await store.get(String(ID))).toBe(t);
    writeFileSync(join(dir, '77.trace.json.gz'), gzipSync(fixture));
    expect(await store.get(77)).toBeNull();
    writeFileSync(join(dir, '78.trace.json.gz'), 'not gzip');
    expect(await store.get(78)).toBeNull();
    await expect(store.put('x/../y', Buffer.from(''))).rejects.toThrow('invalid_match');
    expect(existsSync(join(dir, `${ID}.trace.json.gz`))).toBe(true);
  });
});

describe('parse jobs in the service', () => {
  const makeService = (run: any, clock = { t: 1_000_000 }) => {
    const dir = mkdtempSync(join(root, 'svc-'));
    const blobs = createFileStore(dir);
    const traces = createTraceStore(blobs);
    const docs = createJsonStore(blobs);
    const pipeline = { run: vi.fn(async (id: any, o: any) => run(id, o, traces)) };
    const service = (p: any = pipeline): any => createAgentService({ traces, complete: null, pipeline: p, docs, now: () => clock.t });
    return { service, pipeline, clock, traces, dir };
  };
  // A job's markers are written in the background: the tick lets them start, and what is then expected of them is waited for
  // (vi.waitFor), not assumed to have landed in 15 ms — a loaded machine takes longer to write a file.
  const settle = () => new Promise((r) => setTimeout(r, 15));

  it('prepare: running with its stage, then the trace is there', async () => {
    let release: any;
    const h = makeService(async (id: any, o: any, traces: any) => { o.onStage('downloading'); await new Promise((r) => { release = r; }); await traces.put(id, gzipSync(fixture)); return { ok: true }; });
    const svc = h.service();
    expect(await svc.availability(ID)).toMatchObject({ trace: false, can_parse: true, parse: { status: 'none' } });
    expect(await svc.prepare(ID)).toMatchObject({ status: 'running' });
    await settle();
    await vi.waitFor(async () => expect((await svc.availability(ID)).parse).toEqual({ status: 'running', stage: 'downloading' }));
    // A second caller joins the same job.
    expect(await svc.prepare(ID)).toMatchObject({ status: 'running' });
    expect(h.pipeline.run).toHaveBeenCalledTimes(1);
    // Another instance (same store, no local job) also reports it running.
    await vi.waitFor(async () => expect((await h.service(null).availability(ID)).parse).toEqual({ status: 'running', stage: 'downloading' }));
    release();
    await vi.waitFor(async () => expect((await svc.availability(ID)).trace).toBe(true), { timeout: 5000 });
    expect(await svc.availability(ID)).toMatchObject({ trace: true, heroes: expect.arrayContaining([expect.objectContaining({ hero: 'beastmaster' })]) });
    expect(await svc.prepare(ID)).toEqual({ status: 'ready' });
  });

  it('a replay that is gone stays failed; a transient failure can be retried after a while; a dead job expires', async () => {
    const gone = makeService(async () => ({ ok: false, reason: 'replay_gone' }));
    const a = gone.service();
    await a.prepare(ID); await settle();
    await vi.waitFor(async () => expect((await a.availability(ID)).parse).toEqual({ status: 'failed', reason: 'replay_gone', final: true }));
    gone.clock.t += 3_600_000;
    expect(await a.prepare(ID)).toMatchObject({ status: 'failed', final: true });
    expect(gone.pipeline.run).toHaveBeenCalledTimes(1);

    const flaky = makeService(async () => ({ ok: false, reason: 'download_failed' }));
    const b = flaky.service();
    await b.prepare(ID); await settle();
    await vi.waitFor(async () => expect((await b.availability(ID)).parse).toEqual({ status: 'failed', reason: 'download_failed', final: false }));
    flaky.clock.t += 6 * 60_000;
    expect((await b.availability(ID)).parse).toEqual({ status: 'none' });
    expect(await b.prepare(ID)).toMatchObject({ status: 'running' });

    // A running marker whose instance died: after 15 minutes it no longer blocks a new start.
    const dead = makeService(async () => new Promise(() => {}));
    await dead.service().prepare(ID);
    const other = dead.service(null);
    expect((await other.availability(ID)).parse.status).toBe('running');
    dead.clock.t += 16 * 60_000;
    expect((await other.availability(ID)).parse).toEqual({ status: 'none' });
  });

  it('a game with no replay address yet can be tried again; two prepares arriving together fetch once', async () => {
    let answer: any = { ok: false, reason: 'no_replay_url' };
    const h = makeService(async (id: any, _o: any, traces: any) => { if (answer.ok) await traces.put(id, gzipSync(fixture)); return answer; });
    const svc = h.service();
    await svc.prepare(ID); await settle();
    await vi.waitFor(async () => expect((await svc.availability(ID)).parse).toEqual({ status: 'failed', reason: 'no_replay_url', final: false }));
    // Minutes later the address exists: the same match parses, without waiting out anything.
    answer = { ok: true };
    const [a, b] = await Promise.all([svc.prepare(ID), svc.prepare(ID)]);
    expect([a.status, b.status]).toEqual(['running', 'running']);
    await vi.waitFor(async () => expect((await svc.availability(ID)).trace).toBe(true), { timeout: 5000 });
    expect(h.pipeline.run).toHaveBeenCalledTimes(2);
  });

  it('a slow stage marker cannot land after the terminal one', async () => {
    const blobs = new Map<string, any>();
    let slowDone: any;
    const docs = {
      get: async (k: string) => blobs.get(k) ?? null,
      // The "downloading" marker takes long; everything else is immediate.
      put: async (k: string, v: any) => { if (v.stage === 'downloading' && v.state === 'running') await new Promise((r) => { slowDone = r; }); blobs.set(k, v); },
    };
    const traces = { get: async () => null };
    const pipeline = { run: async (_id: any, o: any) => { o.onStage('downloading'); return { ok: false, reason: 'worker_failed' }; } };
    const a: any = createAgentService({ traces, complete: null, pipeline, docs });
    const b: any = createAgentService({ traces, complete: null, pipeline: null, docs });
    await a.prepare(ID);
    await vi.waitFor(() => expect(slowDone).toBeTypeOf('function'));
    slowDone();
    await vi.waitFor(async () => expect((await b.availability(ID)).parse.status).toBe('failed'));
    await settle();
    // Another instance sees the failure, not a parse still "running".
    await vi.waitFor(async () => expect((await b.availability(ID)).parse).toMatchObject({ status: 'failed', reason: 'worker_failed' }));
  });

  it('a parse retried on another instance is what both instances report', async () => {
    const blobs = new Map<string, any>();
    const docs = { get: async (k: string) => blobs.get(k) ?? null, put: async (k: string, v: any) => { blobs.set(k, v); } };
    const traces = { get: async () => null };
    const clock = { t: 1000 };
    const a: any = createAgentService({ traces, complete: null, docs, now: () => clock.t, pipeline: { run: async () => ({ ok: false, reason: 'download_failed' }) } });
    const b: any = createAgentService({ traces, complete: null, docs, now: () => clock.t, pipeline: { run: async (_id: any, o: any) => { o.onStage('downloading'); return new Promise(() => {}); } } });
    await a.prepare(ID); await settle();
    await vi.waitFor(async () => expect((await a.availability(ID)).parse.status).toBe('failed'));
    clock.t += 1000;
    await b.prepare(ID); await settle();
    // A's own attempt failed, but the newer one on B is running: A says running too.
    await vi.waitFor(async () => expect((await a.availability(ID)).parse).toEqual({ status: 'running', stage: 'downloading' }));
    await vi.waitFor(async () => expect((await b.availability(ID)).parse).toEqual({ status: 'running', stage: 'downloading' }));
  });

  it('a parse whose instance died is offered again after a minute and a half, not while it still reports in', async () => {
    const blobs = new Map<string, any>();
    const docs = { get: async (k: string) => blobs.get(k) ?? null, put: async (k: string, v: any) => { blobs.set(k, v); } };
    const traces = { get: async () => null };
    const clock = { t: 1000 };
    const reading = { run: async (_id: any, o: any) => { o.onStage('extracting'); return new Promise<any>(() => {}); } };
    // Alive: the extractor has been on one stage for five minutes, and the job keeps saying it is running.
    const alive: any = createAgentService({ traces, complete: null, docs, now: () => clock.t, pipeline: reading, beatMs: 5 });
    const other: any = createAgentService({ traces, complete: null, docs, now: () => clock.t, pipeline: reading, beatMs: 5 });
    expect(await alive.prepare(ID)).toMatchObject({ status: 'running' });
    clock.t += 5 * 60_000;
    await vi.waitFor(() => expect(blobs.get(`${ID}.parse.json`).at).toBe(clock.t));
    expect((await other.availability(ID)).parse).toEqual({ status: 'running', stage: 'extracting' });
    expect((await alive.availability(ID)).parse).toEqual({ status: 'running', stage: 'extracting' });

    // Dead: nothing reports in any more. Still "running" a minute later, startable after 90 s.
    const blobs2 = new Map<string, any>();
    const docs2 = { get: async (k: string) => blobs2.get(k) ?? null, put: async (k: string, v: any) => { blobs2.set(k, v); } };
    const dead: any = createAgentService({ traces, complete: null, docs: docs2, now: () => clock.t, pipeline: reading, beatMs: 2 ** 30 });
    const ran = vi.fn(() => new Promise<any>(() => {}));
    const next: any = createAgentService({ traces, complete: null, docs: docs2, now: () => clock.t, pipeline: { run: ran }, beatMs: 2 ** 30 });
    await dead.prepare(ID); await settle();
    clock.t += 60_000;
    expect((await next.availability(ID)).parse).toEqual({ status: 'running', stage: 'extracting' });
    expect(await next.prepare(ID)).toMatchObject({ status: 'running' });
    expect(ran).not.toHaveBeenCalled();
    clock.t += 31_000;
    expect((await next.availability(ID)).parse).toEqual({ status: 'none' });
    // The one doing it does not take a late timer for its own death: it is running until it ends.
    expect((await dead.availability(ID)).parse).toEqual({ status: 'running', stage: 'extracting' });
    expect(await next.prepare(ID)).toMatchObject({ status: 'running' });
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('an instance told to stop hands its running parse back at once; a queued one stays running for its next delivery', async () => {
    const blobs = new Map<string, any>();
    const docs = { get: async (k: string) => blobs.get(k) ?? null, put: async (k: string, v: any) => { blobs.set(k, v); } };
    const traces = { get: async () => null };
    let stage: any;
    const reading = { run: async (_id: any, o: any) => { stage = o.onStage; o.onStage('downloading'); return new Promise<any>(() => {}); } };
    const a: any = createAgentService({ traces, complete: null, docs, pipeline: reading, beatMs: 5 });
    const b: any = createAgentService({ traces, complete: null, docs, pipeline: reading });
    await a.prepare(ID); await settle();
    expect((await b.availability(ID)).parse).toEqual({ status: 'running', stage: 'downloading' });
    await a.shutdown();
    expect((await b.availability(ID)).parse).toEqual({ status: 'none' });
    // A stage reported after the stop, and the beats, do not take it again.
    stage('extracting');
    await new Promise((r) => setTimeout(r, 30));
    expect((await b.availability(ID)).parse).toEqual({ status: 'none' });

    // From the queue: the delivery answers "interrupted" (so it is made again) and the marker stays "running".
    const blobs2 = new Map<string, any>();
    const docs2 = { get: async (k: string) => blobs2.get(k) ?? null, put: async (k: string, v: any) => { blobs2.set(k, v); } };
    const q: any = createAgentService({ traces, complete: null, docs: docs2, pipeline: reading, beatMs: 5 });
    const delivery = q.run({ kind: 'parse', matchId: String(ID) });
    await vi.waitFor(() => expect(blobs2.get(`${ID}.parse.json`)).toMatchObject({ state: 'running', stage: 'downloading' }));
    // Another instance gets the same task while this one is reporting in: it does not parse beside it.
    const ran = vi.fn(() => new Promise<any>(() => {}));
    const second: any = createAgentService({ traces, complete: null, docs: docs2, pipeline: { run: ran } });
    expect(await second.run({ kind: 'parse', matchId: String(ID) })).toEqual({ status: 'busy' });
    expect(ran).not.toHaveBeenCalled();
    await q.shutdown();
    expect(await delivery).toEqual({ status: 'interrupted' });
    expect(blobs2.get(`${ID}.parse.json`)).toMatchObject({ state: 'running', stage: 'downloading' });
  });

  it('a slow progress marker cannot land after a review\'s terminal one', async () => {
    const blobs = new Map<string, any>();
    let slowDone: any;
    const docs = {
      get: async (k: string) => blobs.get(k) ?? null,
      // The marker written for the first tool step takes long; everything else is immediate.
      put: async (k: string, v: any) => { if (k.endsWith('.job.json') && v.state === 'running' && v.steps?.length === 1) await new Promise((r) => { slowDone = r; }); blobs.set(k, v); },
    };
    const trace = JSON.parse(fixture.toString());
    const traces = { get: async () => trace };
    // One lookup, then plain text instead of a submitted review: the job fails with no_review.
    let i = 0;
    const complete = async () => (i++ === 0 ? { toolCalls: [{ id: 'a', name: 'match_overview', args: {} }] } : { text: 'no review' });
    const a: any = createAgentService({ traces, complete, docs });
    const b: any = createAgentService({ traces, complete: null, docs });
    await a.start(ID, 'beastmaster', 'en');
    await vi.waitFor(() => expect(slowDone).toBeTypeOf('function'));
    slowDone();
    await vi.waitFor(async () => expect((await b.status(ID, 'beastmaster', 'en')).status).toBe('failed'));
    await settle();
    await vi.waitFor(async () => expect(await b.status(ID, 'beastmaster', 'en')).toMatchObject({ status: 'failed', reason: 'no_review' }));
  });

  it('a review whose instance died is offered again after a minute and a half, not while it still reports in', async () => {
    const blobs = new Map<string, any>();
    const docs = { get: async (k: string) => blobs.get(k) ?? null, put: async (k: string, v: any) => { blobs.set(k, v); } };
    const trace = JSON.parse(fixture.toString());
    const traces = { get: async () => trace };
    const clock = { t: 1000 };
    const thinking = () => new Promise(() => {});
    // Alive: the model has been thinking for five minutes, and the job keeps saying it is running.
    const alive: any = createAgentService({ traces, docs, now: () => clock.t, complete: thinking, beatMs: 5 });
    const other: any = createAgentService({ traces, docs, now: () => clock.t, complete: thinking, beatMs: 5 });
    expect(await alive.start(ID, 'beastmaster', 'en')).toMatchObject({ status: 'running' });
    clock.t += 5 * 60_000;
    await vi.waitFor(() => expect(blobs.get([...blobs.keys()].find((k) => k.endsWith('.job.json'))!).at).toBe(clock.t));
    expect(await other.status(ID, 'beastmaster', 'en')).toMatchObject({ status: 'running' });

    // Dead: nothing reports in any more (the instance is gone). Still "running" a minute later, startable after 90 s.
    const blobs2 = new Map<string, any>();
    const docs2 = { get: async (k: string) => blobs2.get(k) ?? null, put: async (k: string, v: any) => { blobs2.set(k, v); } };
    const dead: any = createAgentService({ traces, docs: docs2, now: () => clock.t, complete: thinking, beatMs: 2 ** 30 });
    const next: any = createAgentService({ traces, docs: docs2, now: () => clock.t, complete: thinking, beatMs: 2 ** 30 });
    await dead.start(ID, 'beastmaster', 'en');
    clock.t += 60_000;
    expect(await next.status(ID, 'beastmaster', 'en')).toMatchObject({ status: 'running' });
    clock.t += 31_000;
    expect(await next.status(ID, 'beastmaster', 'en')).toEqual({ status: 'none' });
    const admit = vi.fn(() => null);
    expect(await next.start(ID, 'beastmaster', 'en', { admit })).toMatchObject({ status: 'running' });
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it('an instance told to stop hands its running review back at once, and a late step does not take it again', async () => {
    const blobs = new Map<string, any>();
    const docs = { get: async (k: string) => blobs.get(k) ?? null, put: async (k: string, v: any) => { blobs.set(k, v); } };
    const trace = JSON.parse(fixture.toString());
    const traces = { get: async () => trace };
    let answer: any; let turns = 0;
    // The first model turn is in flight when the instance is stopped; it then asks for a lookup (a progress marker).
    const complete = () => { turns += 1; return turns === 1 ? new Promise((r) => { answer = () => r({ toolCalls: [{ id: 'a', name: 'match_overview', args: {} }] }); }) : new Promise(() => {}); };
    const a: any = createAgentService({ traces, docs, complete, beatMs: 5 });
    const b: any = createAgentService({ traces, docs, complete: () => new Promise(() => {}) });
    await a.start(ID, 'beastmaster', 'en');
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    expect(await b.status(ID, 'beastmaster', 'en')).toMatchObject({ status: 'running' });
    await a.shutdown();
    expect(await b.status(ID, 'beastmaster', 'en')).toEqual({ status: 'none' });
    answer();
    await vi.waitFor(() => expect(turns).toBe(2));
    await new Promise((r) => setTimeout(r, 30));
    expect(await b.status(ID, 'beastmaster', 'en')).toEqual({ status: 'none' });
    // Nothing running here: stopping is a no-op, not an error.
    await expect(b.shutdown()).resolves.toBeUndefined();
  });

  it('a review retried on another instance is what both instances report', async () => {
    const blobs = new Map<string, any>();
    const docs = { get: async (k: string) => blobs.get(k) ?? null, put: async (k: string, v: any) => { blobs.set(k, v); } };
    const trace = JSON.parse(fixture.toString());
    const traces = { get: async () => trace };
    const clock = { t: 1000 };
    const a: any = createAgentService({ traces, docs, now: () => clock.t, complete: async () => ({ text: 'no review' }) });
    const b: any = createAgentService({ traces, docs, now: () => clock.t, complete: () => new Promise(() => {}) });
    await a.start(ID, 'beastmaster', 'en');
    await vi.waitFor(async () => expect((await a.status(ID, 'beastmaster', 'en')).status).toBe('failed'));
    clock.t += 1000;
    expect(await b.start(ID, 'beastmaster', 'en')).toMatchObject({ status: 'running' });
    // A's own attempt failed, but the newer one on B is running: A says running, and a start on A joins it.
    expect(await a.status(ID, 'beastmaster', 'en')).toMatchObject({ status: 'running' });
    expect(await a.start(ID, 'beastmaster', 'en')).toMatchObject({ status: 'running' });
  });

  it('only the request that starts a parse is charged; a refusal starts nothing', async () => {
    const h = makeService(async () => new Promise(() => {}));
    const svc = h.service();
    let asked = 0;
    const admit = () => { asked += 1; return null; };
    const all = await Promise.all(Array.from({ length: 20 }, () => svc.prepare(ID, { admit })));
    expect(all.every((r: any) => r.status === 'running')).toBe(true);
    expect(asked).toBe(1);
    expect(await svc.prepare(ID, { admit })).toMatchObject({ status: 'running' });
    expect(asked).toBe(1);
    const other = makeService(async () => ({ ok: true }));
    const no = { status: 429, body: { code: 'rate_limited' } };
    // Two requests share the refused start: both get the refusal back.
    const shared = other.service();
    expect(await Promise.all([shared.prepare(ID, { admit: () => no }), shared.prepare(ID, { admit: () => no })])).toEqual([{ status: 'refused', refusal: no }, { status: 'refused', refusal: no }]);
    expect(other.pipeline.run).not.toHaveBeenCalled();
  });

  it('a pipeline that throws is a failed parse, not a crash; without a pipeline prepare is unavailable', async () => {
    const h = makeService(async () => { throw new Error('boom'); });
    const svc = h.service();
    await svc.prepare(ID); await settle();
    await vi.waitFor(async () => expect((await svc.availability(ID)).parse).toMatchObject({ status: 'failed', reason: 'error' }));
    expect(await h.service(null).prepare(123)).toEqual({ status: 'unavailable' });
  });
});
