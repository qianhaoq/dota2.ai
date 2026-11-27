import { afterAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { createAgentRouter } from '../../lib/agent/router.js';
import { createAgentService } from '../../lib/agent/service.js';
import { createTaskAuth, createTaskDispatcher, RUN_PATH } from '../../lib/agent/tasks.js';

const express = createRequire(import.meta.url)('express');
const fixture = gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url)));
const ID = 9100904020;
const call = (name: string, args: any, id: string) => ({ id, name, args });
const finding = { title: '咆哮', claim: '幻影刺客开了 7 次黑皇杖。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 吼进黑皇杖，定住 3.4 秒' }], fix: '留给她。' };
const submit = { verdict: '咆哮没有留给幻影刺客。', mainline: [], findings: [finding], next_game: ['留咆哮'], blind_spots: ['视野'] };
/** A model that looks two things up (one turn) and submits a review (second); it would also translate, but a review is written in one language and asks for none. `calls` counts its turns. */
function model() {
  const m = { calls: 0, complete: async (o: any) => {
    m.calls += 1;
    if (!o.tools?.length && String(o.system ?? '').includes('Dota 2 coaching translator')) {
      return { text: JSON.stringify({ en: { verdict: 'Primal Roar was not held.', mainline: [], findings: [{ title: 'Roar', claim: 'PA used BKB 7 times.', evidence: ['27:27 stunned 3.4s'], fix: 'Hold it.' }], blind_spots: ['Vision'] }, ru: { verdict: 'Primal Roar не был сохранён.', mainline: [], findings: [{ title: 'Рёв', claim: 'PA нажала BKB 7 раз.', evidence: ['27:27 оглушение 3.4 с'], fix: 'Берегите.' }], blind_spots: ['Обзор'] }, zh: { verdict: submit.verdict, mainline: [], findings: [{ title: finding.title, claim: finding.claim, evidence: [finding.evidence[0].fact], fix: finding.fix }], blind_spots: submit.blind_spots } }) };
    }
    return o.messages.at(-1).role === 'user' ? { toolCalls: [call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'a'), call('immunity_windows', { hero: 'phantom_assassin' }, 'b')] } : { toolCalls: [call('submit_review', submit, 's')] };
  } };
  return m;
}
/** One bucket shared by every "instance", and a queue that only collects what was put on it. */
function world() {
  const blobs = new Map<string, any>();
  const docs = { get: async (k: string) => blobs.get(k) ?? null, put: async (k: string, v: any) => { blobs.set(k, v); } };
  const trace = JSON.parse(fixture.toString());
  const queue: any[] = [];
  const marker = () => blobs.get([...blobs.keys()].find((k) => k.endsWith('.job.json'))!);
  return { blobs, docs, traces: { get: async () => trace }, queue, dispatch: async (task: any) => { queue.push(task); }, marker };
}

describe('a started review is queued and done inside the request that delivers it', () => {
  it('the instance that takes the click calls no model; the one that gets the task does the review; both report it', async () => {
    const w = world();
    const front = model(); const back = model();
    const a: any = createAgentService({ traces: w.traces, docs: w.docs, complete: front.complete, dispatch: w.dispatch });
    const b: any = createAgentService({ traces: w.traces, docs: w.docs, complete: back.complete, dispatch: w.dispatch });
    const admit = vi.fn(() => null);
    expect(await a.start(ID, 'Beastmaster', 'zh', { admit })).toEqual({ status: 'running', steps: [] });
    expect(w.queue).toEqual([{ kind: 'review', matchId: String(ID), hero: 'beastmaster', lang: 'zh' }]);
    // Queued, not started: every instance says "running", and a second click neither queues nor charges again.
    expect(await b.status(ID, 'beastmaster', 'zh')).toMatchObject({ status: 'running' });
    expect(await b.start(ID, 'beastmaster', 'zh', { admit })).toMatchObject({ status: 'running' });
    expect(w.queue).toHaveLength(1);
    expect(admit).toHaveBeenCalledTimes(1);
    // The delivery: answered only when the review is there.
    expect(await b.run(w.queue[0])).toEqual({ status: 'ready' });
    expect(front.calls).toBe(0);
    expect(back.calls).toBe(2);
    expect(await a.status(ID, 'beastmaster', 'zh')).toMatchObject({ status: 'ready', review: { hero: 'beastmaster', lang: 'zh', verdict: submit.verdict } });
    // The task wrote the language it was asked in, and only that: English or Russian is a review of its own, started on request.
    expect(await a.status(ID, 'beastmaster', 'en')).toEqual({ status: 'none' });
    expect(await a.status(ID, 'beastmaster', 'ru')).toEqual({ status: 'none' });
    // Delivered twice (the queue promises at least once): the second finds the review and calls no model.
    expect(await a.run(w.queue[0])).toEqual({ status: 'ready' });
    expect(front.calls + back.calls).toBe(2);
  });

  it('when the task cannot be queued the review runs where it was started, as before', async () => {
    const w = world();
    const m = model();
    const log = vi.fn();
    const a: any = createAgentService({ traces: w.traces, docs: w.docs, complete: m.complete, log, dispatch: async () => { throw new Error('tasks_enqueue_failed'); } });
    expect(await a.start(ID, 'beastmaster', 'en')).toMatchObject({ status: 'running' });
    await vi.waitFor(async () => expect((await a.status(ID, 'beastmaster', 'en')).status).toBe('ready'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('review not queued'));
  });

  it('a task does not start a review somebody is doing: here, or elsewhere while it still reports in', async () => {
    const w = world();
    const clock = { t: 1000 };
    const thinking = () => new Promise(() => {});
    const a: any = createAgentService({ traces: w.traces, docs: w.docs, now: () => clock.t, complete: thinking, beatMs: 2 ** 30 });
    const m = model();
    const b: any = createAgentService({ traces: w.traces, docs: w.docs, now: () => clock.t, complete: m.complete, beatMs: 2 ** 30 });
    const task = { kind: 'review', matchId: String(ID), hero: 'beastmaster', lang: 'en' };
    void a.run(task);
    await vi.waitFor(() => expect(w.marker()?.runner).toBeTypeOf('string'));
    expect(await a.run(task)).toEqual({ status: 'busy' });
    expect(await b.run(task)).toEqual({ status: 'busy' });
    // The other runner has been silent for three beats: it is gone (a crash), and the delivery does the review.
    clock.t += 46_000;
    expect(await b.run(task)).toEqual({ status: 'ready' });
    expect(m.calls).toBe(2);
  });

  it('two deliveries of one review arriving together on one instance are one review', async () => {
    const w = world();
    const m = model();
    const a: any = createAgentService({ traces: w.traces, docs: w.docs, complete: m.complete });
    const task = { kind: 'review', matchId: String(ID), hero: 'beastmaster', lang: 'en' };
    // The same seat under another spelling is the same job.
    const out = await Promise.all([a.run(task), a.run({ ...task, hero: 'Beastmaster' }), a.run(task)]);
    expect(out.map((o: any) => o.status).sort()).toEqual(['busy', 'busy', 'ready']);
    expect(m.calls).toBe(2);
    // The claim is given back: a later delivery is answered from what is stored.
    expect(await a.run(task)).toEqual({ status: 'ready' });
    expect(m.calls).toBe(2);
    // A parse likewise: one run of the pipeline.
    const store = new Map<string, any>();
    const ran = vi.fn(async (id: any) => { await new Promise((r) => setTimeout(r, 10)); store.set(String(id), JSON.parse(fixture.toString())); return { ok: true }; });
    const p: any = createAgentService({ traces: { get: async (id: any) => store.get(String(id)) ?? null }, docs: world().docs, complete: null, pipeline: { run: ran } });
    const parsed = await Promise.all([p.run({ kind: 'parse', matchId: String(ID) }), p.run({ kind: 'parse', matchId: ID })]);
    expect(parsed.map((o: any) => o.status).sort()).toEqual(['busy', 'ready']);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('an instance told to stop answers "interrupted" and leaves the review running for the next delivery', async () => {
    const w = world();
    const a: any = createAgentService({ traces: w.traces, docs: w.docs, complete: () => new Promise(() => {}), beatMs: 5 });
    const m = model();
    const b: any = createAgentService({ traces: w.traces, docs: w.docs, complete: m.complete });
    const task = { kind: 'review', matchId: String(ID), hero: 'beastmaster', lang: 'en' };
    const first = a.run(task);
    await vi.waitFor(() => expect(w.marker()?.runner).toBeTypeOf('string'));
    await a.shutdown();
    expect(await first).toEqual({ status: 'interrupted' });
    // Not offered to the reader again (the queue has it), and no beat of the stopped instance claims it back.
    await new Promise((r) => setTimeout(r, 30));
    expect(w.marker()).toMatchObject({ state: 'running' });
    expect(w.marker().runner).toBeUndefined();
    expect(await b.status(ID, 'beastmaster', 'en')).toMatchObject({ status: 'running' });
    expect(await b.run(task)).toEqual({ status: 'ready' });
  });

  it('a task that names nothing to do is answered, not delivered again', async () => {
    const w = world();
    const a: any = createAgentService({ traces: w.traces, docs: w.docs, complete: model().complete });
    expect(await a.run({ kind: 'review', matchId: String(ID), hero: 'pudge', lang: 'en' })).toEqual({ status: 'gone' });
    expect(await a.run({ kind: 'review', matchId: '../x', hero: 'beastmaster' })).toEqual({ status: 'invalid' });
    expect(await a.run({ kind: 'sweep', matchId: String(ID) })).toEqual({ status: 'invalid' });
    expect(await a.run(null)).toEqual({ status: 'invalid' });
    const noModel: any = createAgentService({ traces: w.traces, docs: w.docs, complete: null });
    expect(await noModel.run({ kind: 'review', matchId: String(ID), hero: 'beastmaster' })).toEqual({ status: 'unavailable' });
    const noTrace: any = createAgentService({ traces: { get: async () => null }, docs: w.docs, complete: model().complete });
    expect(await noTrace.run({ kind: 'review', matchId: String(ID), hero: 'beastmaster' })).toEqual({ status: 'gone' });
  });
});

describe('a started parse is queued the same way', () => {
  it('prepare queues; the delivery parses and answers when the trace is there', async () => {
    const w = world();
    const store = new Map<string, any>();
    const traces = { get: async (id: any) => store.get(String(id)) ?? null };
    const ran: string[] = [];
    const pipeline = { run: async (id: any, o: any) => { ran.push(String(id)); o.onStage('extracting'); store.set(String(id), JSON.parse(fixture.toString())); return { ok: true }; } };
    const a: any = createAgentService({ traces, docs: w.docs, complete: null, pipeline, dispatch: w.dispatch });
    const b: any = createAgentService({ traces, docs: w.docs, complete: null, pipeline, dispatch: w.dispatch });
    const admit = vi.fn(() => null);
    expect(await a.prepare(ID, { admit })).toEqual({ status: 'running', stage: 'locating' });
    expect(w.queue).toEqual([{ kind: 'parse', matchId: String(ID) }]);
    expect(ran).toEqual([]);
    expect((await b.availability(ID)).parse).toMatchObject({ status: 'running' });
    expect(await b.prepare(ID, { admit })).toMatchObject({ status: 'running' });
    expect(w.queue).toHaveLength(1);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(await b.run(w.queue[0])).toEqual({ status: 'ready' });
    expect(ran).toEqual([String(ID)]);
    expect((await a.availability(ID)).trace).toBe(true);
    // Delivered again: the trace is there, nothing is parsed twice.
    expect(await a.run(w.queue[0])).toEqual({ status: 'ready' });
    expect(ran).toHaveLength(1);
  });

  it('a parse that fails is reported as failed; one already running here is not started twice', async () => {
    const w = world();
    const traces = { get: async () => null };
    let release: any;
    const slow = { run: () => new Promise<{ ok: boolean; reason?: string }>((r) => { release = () => r({ ok: false, reason: 'replay_gone' }); }) };
    const a: any = createAgentService({ traces, docs: w.docs, complete: null, pipeline: slow });
    const task = { kind: 'parse', matchId: String(ID) };
    const first = a.run(task);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(await a.run(task)).toEqual({ status: 'busy' });
    release();
    expect(await first).toEqual({ status: 'failed', reason: 'replay_gone' });
    expect((await a.availability(ID)).parse).toMatchObject({ status: 'failed', reason: 'replay_gone', final: true });
    const none: any = createAgentService({ traces, docs: w.docs, complete: null, pipeline: null });
    expect(await none.run(task)).toEqual({ status: 'unavailable' });
    // Queueing failed: parsed where it was asked for.
    const ran = vi.fn(async () => ({ ok: false, reason: 'download_failed' }));
    const w2 = world();
    const local: any = createAgentService({ traces, docs: w2.docs, complete: null, pipeline: { run: ran }, dispatch: async () => { throw new Error('down'); } });
    expect(await local.prepare(ID)).toMatchObject({ status: 'running' });
    await vi.waitFor(() => expect(ran).toHaveBeenCalledTimes(1));
  });
});

describe('the run route', () => {
  const servers: any[] = [];
  afterAll(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));
  async function serve(deps: any) {
    const app = express();
    app.use(express.json());
    app.use(createAgentRouter({ resolveClientIp: () => '10.0.0.1', ...deps }));
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return async (body: any, token?: string) => { const r = await fetch(base + RUN_PATH, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }); return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null }; };
  }

  it('does not exist unless the queue is configured', async () => {
    const w = world();
    const service = createAgentService({ traces: w.traces, docs: w.docs, complete: model().complete });
    const post = await serve({ service });
    expect((await post({ kind: 'review', matchId: String(ID), hero: 'beastmaster' }, 'good')).status).toBe(404);
  });

  it('only the queue may call it; 200 ends the task, 503 has it delivered again', async () => {
    const w = world();
    const m = model();
    const service: any = createAgentService({ traces: w.traces, docs: w.docs, complete: m.complete });
    const run = vi.fn((task: any) => service.run(task));
    const post = await serve({ service: { ...service, run }, runAuth: async (req: any) => req.headers.authorization === 'Bearer good' });
    const task = { kind: 'review', matchId: String(ID), hero: 'beastmaster', lang: 'zh' };
    expect(await post(task)).toMatchObject({ status: 403 });
    expect(await post(task, 'bad')).toMatchObject({ status: 403 });
    expect(run).not.toHaveBeenCalled();
    expect(m.calls).toBe(0);
    expect(await post(task, 'good')).toEqual({ status: 200, body: { status: 'ready' } });
    expect((await service.status(ID, 'beastmaster', 'zh')).status).toBe('ready');
    expect(await post({ kind: 'review', matchId: String(ID), hero: 'pudge' }, 'good')).toEqual({ status: 200, body: { status: 'gone' } });
    run.mockResolvedValueOnce({ status: 'busy' });
    expect(await post(task, 'good')).toEqual({ status: 503, body: { status: 'busy' } });
    run.mockResolvedValueOnce({ status: 'interrupted' });
    expect(await post(task, 'good')).toEqual({ status: 503, body: { status: 'interrupted' } });
    run.mockRejectedValueOnce(new Error('boom'));
    expect(await post(task, 'good')).toEqual({ status: 503, body: { status: 'interrupted' } });
  });
});

describe('Cloud Tasks: queueing and recognising a delivery', () => {
  const queue = 'projects/p/locations/asia-east1/queues/agent';
  const url = 'https://site.example.run.app';
  const serviceAccount = 'site@p.iam.gserviceaccount.com';

  it('queues a task that calls this service back, as its service account, with the job as the body', async () => {
    const seen: any[] = [];
    const fetchImpl: any = async (u: string, o: any) => { seen.push({ u, o }); return u.includes('metadata') ? { ok: true, json: async () => ({ access_token: 'at' }) } : { ok: true, json: async () => ({}) }; };
    const job = { kind: 'review', matchId: '1', hero: 'axe', lang: 'zh' };
    await createTaskDispatcher({ queue, url: `${url}/`, serviceAccount, fetchImpl })(job);
    expect(seen[0].o.headers).toEqual({ 'Metadata-Flavor': 'Google' });
    expect(seen[1].u).toBe(`https://cloudtasks.googleapis.com/v2/${queue}/tasks`);
    expect(seen[1].o.headers.Authorization).toBe('Bearer at');
    const { task } = JSON.parse(seen[1].o.body);
    expect(task.dispatchDeadline).toBe('1800s');
    expect(task.httpRequest).toMatchObject({ url: `${url}${RUN_PATH}`, httpMethod: 'POST', oidcToken: { serviceAccountEmail: serviceAccount, audience: url } });
    expect(JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString())).toEqual(job);
  });

  it('a queue that says no, or no identity, is an error for the caller to act on', async () => {
    const refuse: any = async (u: string) => (u.includes('metadata') ? { ok: true, json: async () => ({ access_token: 'at' }) } : { ok: false, status: 403 });
    await expect(createTaskDispatcher({ queue, url, serviceAccount, fetchImpl: refuse })({})).rejects.toMatchObject({ message: 'tasks_enqueue_failed', code: 403 });
    await expect(createTaskDispatcher({ queue, url, serviceAccount, fetchImpl: (async () => ({ ok: false })) as any })({})).rejects.toThrow('tasks_identity_failed');
    await expect(createTaskDispatcher({ queue, url, serviceAccount, fetchImpl: (async () => ({ ok: true, json: async () => ({}) })) as any })({})).rejects.toThrow('tasks_identity_failed');
  });

  it('accepts only Google\'s token for this service account and this audience, not expired', async () => {
    const good = { aud: url, email: serviceAccount, email_verified: 'true', iss: 'https://accounts.google.com', exp: '2000' };
    const asked: string[] = [];
    const auth = (claims: any, ok = true) => createTaskAuth({ audience: url, serviceAccount, now: () => 1_000_000, fetchImpl: (async (u: string) => { asked.push(u); return { ok, json: async () => claims }; }) as any });
    const req = { headers: { authorization: 'Bearer abc.def.ghi' } };
    expect(await auth(good)(req)).toBe(true);
    expect(asked[0]).toBe('https://oauth2.googleapis.com/tokeninfo?id_token=abc.def.ghi');
    for (const wrong of [{ aud: 'https://other.example' }, { email: 'someone@gmail.com' }, { email_verified: 'false' }, { iss: 'https://evil.example' }, { exp: '999' }]) expect(await auth({ ...good, ...wrong })(req)).toBe(false);
    expect(await auth(good, false)(req)).toBe(false);
    // No token, or something that is not one: Google is not even asked.
    const before = asked.length;
    for (const headers of [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer a b' }]) expect(await auth(good)({ headers })).toBe(false);
    expect(await auth(good)(undefined as any)).toBe(false);
    expect(asked).toHaveLength(before);
    expect(await createTaskAuth({ audience: url, serviceAccount, fetchImpl: (async () => { throw new Error('offline'); }) as any })(req)).toBe(false);
  });
});
