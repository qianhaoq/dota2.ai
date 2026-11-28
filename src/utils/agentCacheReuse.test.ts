import { afterAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { DEEP_REVIEW_PROMPT_VERSION, DEEP_REVIEW_SCHEMA } from '../../lib/agent/deepReview.js';
import { createAgentRouter } from '../../lib/agent/router.js';
import { createAgentService, createFileTraceStore } from '../../lib/agent/service.js';
import { createBucketStore, createFileStore, createJsonStore, createTraceStore } from '../../lib/agent/stores.js';
import { createGcsBucket } from '../../lib/matchReview/replayIngest/gcs.js';
import { replayReview } from '../../lib/agent/replayTool.js';
import { warmShowcase } from '../../lib/agent/showcase.js';

const express = createRequire(import.meta.url)('express');
const MATCH = '9100904020';
const P = DEEP_REVIEW_PROMPT_VERSION;
const traceGzPath = new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url);
const traceJson = gunzipSync(readFileSync(traceGzPath)).toString('utf8');

const root = mkdtempSync(join(tmpdir(), 'agent-cache-reuse-'));
const traceDir = join(root, 'traces');
copyFileSync(traceGzPath, join(root, 'seed.trace.json.gz'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const call = (name: string, args: any, id: string) => ({ id, name, args });
const finding = {
  title: '咆哮',
  claim: '幻影刺客开了 7 次黑皇杖。',
  evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 吼进黑皇杖，定住 3.4 秒' }],
  fix: '留给她。',
};
const submit = {
  verdict: '咆哮没有留给幻影刺客。',
  mainline: [],
  findings: [finding],
  next_game: ['留咆哮'],
  blind_spots: ['视野'],
};

function mockModel(verdict = submit.verdict) {
  let calls = 0;
  const complete = async (o: any) => {
    calls += 1;
    const last = o.messages.at(-1);
    if (last.role === 'user') {
      return {
        toolCalls: [
          call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'a'),
          call('immunity_windows', { hero: 'phantom_assassin' }, 'b'),
        ],
      };
    }
    return { toolCalls: [call('submit_review', { ...submit, verdict }, 's')] };
  };
  return { get calls() { return calls; }, complete };
}

function storedDoc(verdict: string, extra: Record<string, any> = {}, meta: Record<string, any> = {}) {
  return {
    schema: 'dota2.ai/deep-review-bundle@1',
    model: 'deepseek-flash',
    tool_calls: 2,
    verification: { repaired: false, dropped: 0 },
    review: {
      schema: DEEP_REVIEW_SCHEMA,
      match_id: Number(MATCH),
      hero: 'beastmaster',
      lang: 'zh',
      verdict,
      mainline: [],
      findings: [finding],
      blind_spots: ['视野'],
      ...extra,
    },
    ...meta,
  };
}

describe('store prefix listing (file & GCS)', () => {
  it('createFileStore.list lists matching keys sorted and rejects path traversal prefixes', async () => {
    const dir = mkdtempSync(join(root, 'list-file-'));
    const store = createFileStore(dir);
    await store.put(`${MATCH}.beastmaster.zh.p74.review.json`, Buffer.from('{}'));
    await store.put(`${MATCH}.beastmaster.zh.p76.review.json`, Buffer.from('{}'));
    await store.put(`${MATCH}.axe.zh.p76.review.json`, Buffer.from('{}'));
    expect(await store.list!(`${MATCH}.beastmaster.`)).toEqual([
      `${MATCH}.beastmaster.zh.p74.review.json`,
      `${MATCH}.beastmaster.zh.p76.review.json`,
    ]);
    expect(await store.list!('../')).toEqual([]);
    expect(await store.list!('a..b')).toEqual([]);
    expect(await createFileStore(null).list!(`${MATCH}.`)).toEqual([]);
  });

  it('createGcsBucket.list paginates and createBucketStore.list strips prefix safely', async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: any) => {
      const u = String(input);
      requests.push(u);
      if (u.includes('pageToken=p2')) {
        return new Response(JSON.stringify({
          items: [{ name: `agent/${MATCH}.beastmaster.zh.p76.review.json` }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        items: [
          { name: `agent/${MATCH}.beastmaster.zh.p74.review.json` },
          { name: `other/${MATCH}.beastmaster.zh.p75.review.json` },
        ],
        nextPageToken: 'p2',
      }), { status: 200 });
    });
    const bucket = createGcsBucket('test-bucket', { fetchImpl: fetchImpl as any, tokenProvider: async () => 'tok' });
    const blobs = createBucketStore(bucket, 'agent/');
    const json = createJsonStore(blobs);
    expect(await json.list!(`${MATCH}.beastmaster.`)).toEqual([
      `${MATCH}.beastmaster.zh.p74.review.json`,
      `${MATCH}.beastmaster.zh.p76.review.json`,
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain(`prefix=agent%2F${MATCH}.beastmaster.`);
    expect(await json.list!('../escape')).toEqual([]);

    // A bucket without list() omits list on createBucketStore / createJsonStore so service falls back to bounded probing.
    const noListStore = createJsonStore(createBucketStore({ file: () => ({ download: async () => { throw { code: 404 }; }, save: async () => {} }) } as any, 'agent/'));
    expect(noListStore.list).toBeUndefined();
  });
});

describe('review cache reuse & cross-version fallback (#486)', () => {
  it('exact cache hit on reopen, refresh, and fresh service instance runs zero model calls and zero trace reparses', async () => {
    const dir = mkdtempSync(join(root, 'exact-hit-'));
    const tracesDir = join(dir, 'traces');
    const reviewsDir = join(dir, 'reviews');
    const outdatedTrace = { ...JSON.parse(traceJson), builder_version: 0 };
    const traceStore = createTraceStore(createFileStore(tracesDir));
    await traceStore.put(MATCH, gzipSync(Buffer.from(JSON.stringify(outdatedTrace))));

    const m1 = mockModel();
    const pipe1 = { run: vi.fn(async () => ({ ok: true })) };
    const svc1: any = createAgentService({
      traces: traceStore,
      reviewDir: reviewsDir,
      complete: m1.complete,
      model: 'deepseek-flash',
      pipeline: pipe1,
      reparseOldTraces: false,
    });
    expect((await svc1.start(MATCH, 'beastmaster', 'zh')).status).toBe('running');
    await vi.waitFor(async () => expect((await svc1.status(MATCH, 'beastmaster', 'zh')).status).toBe('ready'), { timeout: 5000 });
    expect(m1.calls).toBe(2);

    // Fresh service instance (new session / restart) with reparseOldTraces enabled & failing model/pipeline:
    const neverModel = vi.fn(async () => { throw new Error('model should not run on cache hit'); });
    const neverPipe = { run: vi.fn(async () => { throw new Error('pipeline should not run on cache hit'); }) };
    const svc2: any = createAgentService({
      traces: createFileTraceStore(tracesDir),
      reviewDir: reviewsDir,
      complete: neverModel,
      model: 'deepseek-flash',
      pipeline: neverPipe,
      reparseOldTraces: true,
    });

    const st = await svc2.status(MATCH, 'beastmaster', 'zh');
    expect(st).toMatchObject({ status: 'ready', prompt_version: P, review: { verdict: submit.verdict } });
    expect(st.stale_version).toBeUndefined();

    // POST / start (even with refresh: true on an already-current version) reuses cache with zero admission/model/parse calls.
    const admit = vi.fn(() => null);
    expect(await svc2.start(MATCH, 'beastmaster', 'zh', { admit })).toMatchObject({ status: 'ready', prompt_version: P });
    expect(await svc2.start(MATCH, 'beastmaster', 'zh', { admit, refresh: true })).toMatchObject({ status: 'ready', prompt_version: P });
    expect(admit).not.toHaveBeenCalled();
    expect(neverModel).not.toHaveBeenCalled();
    expect(neverPipe.run).not.toHaveBeenCalled();
  });

  it('reuses newest compatible older-version review on reopen (file store), strips handles, and regenerates only on explicit refresh', async () => {
    const dir = mkdtempSync(join(root, 'cross-ver-'));
    const reviewsDir = join(dir, 'reviews');
    const docs = createJsonStore(createFileStore(reviewsDir));
    const oldV = P - 5;
    const newerOldV = P - 2;

    // Seed older versions (including one with record handles in text and stored #493 usage telemetry) plus a corrupt even-newer older version.
    const storedUsage = {
      input: 12_400,
      output: 2100,
      input_uncached: 3300,
      cache_read: 9100,
      cache_write: null,
      source: 'provider_usage',
    };
    await docs.put(`${MATCH}.beastmaster.zh.p${oldV}.review.json`, storedDoc('旧版 v-5 结论。'));
    await docs.put(`${MATCH}.beastmaster.zh.p${newerOldV}.review.json`, storedDoc('旧版 v-2 结论（overview、fight:3）。', {}, {
      steps: 7,
      repair_rounds: 1,
      truncation_retries: 0,
      usage: storedUsage,
      usage_source: 'provider_usage',
    }));
    // Corrupt v-1 must be ignored cleanly rather than failing or being served.
    await docs.put(`${MATCH}.beastmaster.zh.p${P - 1}.review.json`, { review: { schema: 'dota2.ai/deep-review@99', verdict: 'bad', findings: [] } });
    // Corrupt JSON file on disk must also be skipped cleanly.
    writeFileSync(join(reviewsDir, `${MATCH}.beastmaster.zh.p${P - 3}.review.json`), '{not-json');

    const m = mockModel('全新最新版结论。');
    const traces = { get: async () => JSON.parse(traceJson) };
    const svc: any = createAgentService({ traces, docs, complete: m.complete, model: 'deepseek-flash' });

    // 1. status() returns newest valid older version with honest prompt_version + stale_version + handles stripped + preserved usage telemetry.
    const cached = await svc.status(MATCH, 'beastmaster', 'zh');
    expect(cached).toMatchObject({
      status: 'ready',
      prompt_version: newerOldV,
      latest_prompt_version: P,
      stale_version: true,
      cached: true,
      steps: 7,
      repair_rounds: 1,
      truncation_retries: 0,
      usage: storedUsage,
      usage_source: 'provider_usage',
      review: { verdict: '旧版 v-2 结论。' },
    });
    expect(m.calls).toBe(0);

    // 2. Default start() without refresh reuses the compatible cached review and spends nothing.
    const admit = vi.fn(() => null);
    const reused = await svc.start(MATCH, 'beastmaster', 'zh', { admit });
    expect(reused).toMatchObject({ status: 'ready', prompt_version: newerOldV, stale_version: true, cached: true });
    expect(admit).not.toHaveBeenCalled();
    expect(m.calls).toBe(0);

    // 3. Follow-up chat sees the cached review currently on screen.
    let seenPrompt = '';
    const chatSvc: any = createAgentService({
      traces,
      docs,
      complete: async (o: any) => { seenPrompt = o.messages[0].content; return { text: '好的。' }; },
      model: 'deepseek-flash',
    });
    await chatSvc.chat({ matchId: MATCH, hero: 'beastmaster', lang: 'zh', question: '为什么？', history: [] });
    expect(seenPrompt).toContain('旧版 v-2 结论。');

    // 4. peek() stays strictly current-version only, and feedback() still rejects stale versions.
    expect(await svc.peek(MATCH, 'beastmaster', 'zh')).toBeNull();
    const fbSvc: any = createAgentService({ traces, docs, feedback: { put: vi.fn() }, complete: m.complete, model: 'deepseek-flash' });
    expect(await fbSvc.feedback(MATCH, 'beastmaster', 'zh', {
      value: { version: newerOldV, finding: 0, title: finding.title, rating: 'right', reason: null, id: 'abcdefghij0123456789' },
    })).toEqual({ status: 'stale' });

    // 5. Explicit refresh: true regenerates under DEEP_REVIEW_PROMPT_VERSION.
    const started = await svc.start(MATCH, 'beastmaster', 'zh', { admit, refresh: true });
    expect(started).toMatchObject({ status: 'running' });
    expect(admit).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => {
      const fresh = await svc.status(MATCH, 'beastmaster', 'zh');
      expect(fresh.status).toBe('ready');
      expect(fresh.prompt_version).toBe(P);
      expect(fresh.stale_version).toBeUndefined();
      expect(fresh.review.verdict).toBe('全新最新版结论。');
    }, { timeout: 5000 });
    expect(m.calls).toBe(2);
  });

  it('enforces strict isolation across hero, lang, plan, and model (including dotted/shared-suffix model ids)', async () => {
    const dir = mkdtempSync(join(root, 'isolation-'));
    const docs = createJsonStore(createFileStore(dir));
    const oldV = P - 3;

    // Seed older reviews for specific combinations only.
    await docs.put(`${MATCH}.beastmaster.zh.p${oldV}.review.json`, storedDoc('默认模型无思路中文。'));
    await docs.put(`${MATCH}.beastmaster.zh.p${oldV}.plan-push.review.json`, storedDoc('推进思路中文。', { plan: 'push' }));
    await docs.put(`${MATCH}.beastmaster.zh.p${oldV}.m-bar.m-foo.review.json`, storedDoc('模型 bar.m-foo 中文。'));
    await docs.put(`${MATCH}.beastmaster.p${oldV - 1}.review.json`, {
      schema: 'dota2.ai/deep-review-bundle@1',
      model: 'deepseek-flash',
      tool_calls: 2,
      reviews: {
        en: storedDoc('Trilingual bundle English.', { lang: 'en' }).review,
        zh: storedDoc('旧三语包中文。', { lang: 'zh' }).review,
      },
    });

    const engines = {
      'deepseek-flash': { name: 'deepseek-flash', complete: async () => ({}) },
      foo: { name: 'foo', complete: async () => ({}) },
      'bar.m-foo': { name: 'bar.m-foo', complete: async () => ({}) },
    };
    const svc: any = createAgentService({
      traces: { get: async () => JSON.parse(traceJson) },
      docs,
      models: engines,
      defaultModel: 'deepseek-flash',
    });

    // zh hits newer per-lang p(P-3), en hits trilingual bundle p(P-4), ru misses (not in bundle).
    expect(await svc.status(MATCH, 'beastmaster', 'zh')).toMatchObject({ status: 'ready', prompt_version: oldV, stale_version: true, review: { verdict: '默认模型无思路中文。' } });
    expect(await svc.status(MATCH, 'beastmaster', 'en')).toMatchObject({ status: 'ready', prompt_version: oldV - 1, stale_version: true, review: { verdict: 'Trilingual bundle English.' } });
    expect(await svc.status(MATCH, 'beastmaster', 'ru')).toEqual({ status: 'none' });

    // Different hero misses.
    expect(await svc.status(MATCH, 'axe', 'zh')).toEqual({ status: 'none' });

    // Different plan is isolated.
    expect(await svc.status(MATCH, 'beastmaster', 'zh', 'push')).toMatchObject({ status: 'ready', prompt_version: oldV, review: { verdict: '推进思路中文。' } });
    expect(await svc.status(MATCH, 'beastmaster', 'zh', 'late')).toEqual({ status: 'none' });

    // Model with shared suffix `.m-foo` NEVER leaks into `foo`, and matches `bar.m-foo` exactly.
    expect(await svc.status(MATCH, 'beastmaster', 'zh', null, 'foo')).toEqual({ status: 'none' });
    expect(await svc.status(MATCH, 'beastmaster', 'zh', null, 'bar.m-foo')).toMatchObject({ status: 'ready', prompt_version: oldV, review: { verdict: '模型 bar.m-foo 中文。' } });

    // Incompatible payload (mismatched hero inside stored JSON) is rejected cleanly.
    await docs.put(`${MATCH}.axe.zh.p${oldV}.review.json`, storedDoc('放错英雄的文件。', { hero: 'beastmaster' }));
    expect(await svc.status(MATCH, 'axe', 'zh')).toEqual({ status: 'none' });
  });

  it('works on minimal { get, put } stores without list() and via queued run() refresh', async () => {
    const blobs = new Map<string, any>();
    blobs.set(`${MATCH}.beastmaster.zh.p${P - 2}.review.json`, storedDoc('内存存储旧版。'));
    const docs = {
      get: async (k: string) => blobs.get(k) ?? null,
      put: async (k: string, v: any) => { blobs.set(k, v); },
    };
    const queue: any[] = [];
    const m = mockModel('队列刷新新版。');
    const front: any = createAgentService({
      traces: { get: async () => JSON.parse(traceJson) },
      docs,
      complete: m.complete,
      dispatch: async (task: any) => { queue.push(task); },
    });
    const worker: any = createAgentService({
      traces: { get: async () => JSON.parse(traceJson) },
      docs,
      complete: m.complete,
    });

    expect(await front.status(MATCH, 'beastmaster', 'zh')).toMatchObject({
      status: 'ready',
      prompt_version: P - 2,
      stale_version: true,
      review: { verdict: '内存存储旧版。' },
    });

    // Queued refresh must run the model and write p${P} (not short-circuit on p${P-2}).
    expect(await front.start(MATCH, 'beastmaster', 'zh', { refresh: true })).toEqual({ status: 'running', steps: [] });
    expect(queue).toHaveLength(1);
    expect(await worker.status(MATCH, 'beastmaster', 'zh')).toMatchObject({ status: 'running' });
    expect(await worker.run(queue[0])).toEqual({ status: 'ready' });
    expect(m.calls).toBe(2);
    expect(await front.status(MATCH, 'beastmaster', 'zh')).toMatchObject({
      status: 'ready',
      prompt_version: P,
      review: { verdict: '队列刷新新版。' },
    });
    expect((await front.status(MATCH, 'beastmaster', 'zh')).stale_version).toBeUndefined();
  });

  it('HTTP POST /review reuses stale cache by default without charging budget, and regenerates with refresh/force', async () => {
    const dir = mkdtempSync(join(root, 'http-refresh-'));
    const docs = createJsonStore(createFileStore(dir));
    await docs.put(`${MATCH}.beastmaster.zh.p${P - 1}.review.json`, storedDoc('旧版 HTTP 缓存。'));

    let acquired = 0;
    const m = mockModel('HTTP 新版。');
    const service: any = createAgentService({
      traces: { get: async () => JSON.parse(traceJson) },
      docs,
      complete: m.complete,
      model: 'deepseek-flash',
    });
    const app = express();
    app.use(express.json());
    app.use(createAgentRouter({
      service,
      resolveClientIp: () => '10.42.0.1',
      llm: { acquire: () => { acquired += 1; return { ok: true }; } },
    }));
    const srv = app.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

    try {
      const post = async (body: any) => {
        const r = await fetch(`${base}/api/agent/${MATCH}/review`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: r.status, body: await r.json() };
      };
      // Default POST reuses stale cache: HTTP 200, zero budget spent, zero model calls.
      const hit = await post({ hero: 'beastmaster', lang: 'zh' });
      expect(hit).toMatchObject({
        status: 200,
        body: { status: 'ready', prompt_version: P - 1, latest_prompt_version: P, stale_version: true, cached: true },
      });
      expect([acquired, m.calls]).toEqual([0, 0]);

      // Explicit refresh: true charges once and regenerates under P.
      const started = await post({ hero: 'beastmaster', lang: 'zh', refresh: true });
      expect(started).toMatchObject({ status: 202, body: { status: 'running' } });
      expect(acquired).toBe(1);

      await vi.waitFor(async () => {
        const res = await (await fetch(`${base}/api/agent/${MATCH}/review?hero=beastmaster&lang=zh`)).json();
        expect(res).toMatchObject({ status: 'ready', prompt_version: P, review: { verdict: 'HTTP 新版。' } });
        expect(res.stale_version).toBeUndefined();
      }, { timeout: 5000 });

      // Refresh again once already on P spends nothing.
      const currentHit = await post({ hero: 'beastmaster', lang: 'zh', force: true });
      expect(currentHit).toMatchObject({ status: 200, body: { status: 'ready', prompt_version: P } });
      expect(acquired).toBe(1);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it('replayReview and warmShowcase handle stale-version cached reviews cleanly', async () => {
    const calls: string[] = [];
    const staleState = {
      status: 'ready',
      prompt_version: P - 2,
      latest_prompt_version: P,
      stale_version: true,
      cached: true,
      verification: { repaired: false, dropped: 0 },
      review: storedDoc('MCP 旧版缓存。').review,
    };
    const api = {
      read: () => ({ ok: true }),
      validMatch: (id: string) => /^[1-9]\d{0,12}$/.test(id),
      availability: async () => ({
        trace: true,
        can_parse: true,
        model_configured: true,
        heroes: [{ hero: 'beastmaster', team: 'dire', hero_id: 38, en: 'Beastmaster', zh: '兽王' }],
      }),
      status: async () => staleState,
      prepare: async () => { calls.push('prepare'); return { status: 200, body: { status: 'ready' } }; },
      start: async (_id: string, hero: string, lang: string, opts?: any) => {
        calls.push(`start:${hero}:${lang}:${opts?.refresh ? 'refresh' : 'normal'}`);
        return { status: 202, body: { status: 'running', steps: [] } };
      },
    };

    // Default replayReview call reuses stale cache and surfaces honest metadata.
    const cachedOut: any = await replayReview(api, { match_id: MATCH, hero: 'beastmaster', lang: 'zh' });
    expect(cachedOut).toMatchObject({
      status: 'ready',
      cached: true,
      stale_version: true,
      prompt_version: P - 2,
      latest_prompt_version: P,
      verdict: 'MCP 旧版缓存。',
    });
    expect(cachedOut.note).toContain(`coach v${P - 2}`);
    expect(cachedOut.note).toContain('refresh: true');
    expect(calls).toEqual([]);

    // Explicit refresh: true starts regeneration.
    const refreshedOut: any = await replayReview(api, { match_id: MATCH, hero: 'beastmaster', lang: 'zh', refresh: true });
    expect(refreshedOut).toMatchObject({ status: 'reviewing', hero: 'beastmaster', lang: 'zh' });
    expect(calls).toEqual(['start:beastmaster:zh:refresh']);

    // When start() returns 503 unavailable during refresh, replayReview keeps the cached review and exposes refresh_failed.
    const unavailApi = {
      ...api,
      start: async () => ({ status: 503, body: { status: 'unavailable', reason: 'model_out_of_credit', retry_in_sec: 240 } }),
    };
    const unavailOut: any = await replayReview(unavailApi, { match_id: MATCH, hero: 'beastmaster', lang: 'zh', refresh: true });
    expect(unavailOut).toMatchObject({
      status: 'ready',
      cached: true,
      stale_version: true,
      prompt_version: P - 2,
      refresh_failed: { reason: 'model_out_of_credit' },
      verdict: 'MCP 旧版缓存。',
    });
    expect(unavailOut.note).toContain('retry: true');

    // warmShowcase upgrades stale showcase reviews via start(..., { refresh: true }),
    // and skips stale ones whose last refresh failed so a failing refresh is not hammered on every boot.
    const warmed: any[] = [];
    const showcaseOut = await warmShowcase({
      status: async (id: string) => (id === '9091400302'
        ? { status: 'ready', stale_version: true }
        : { status: 'ready', stale_version: true, refresh_failed: { reason: 'timeout' } }),
      start: async (id: string, hero: string, lang: string, opts?: any) => {
        warmed.push({ id, hero, lang, opts });
        return { status: 'running' };
      },
    });
    expect(showcaseOut).toEqual(['started:running', 'ready']);
    expect(warmed).toEqual([{ id: '9091400302', hero: 'tidehunter', lang: 'en', opts: { refresh: true } }]);
  });

  it('replayReview requires explicit retry: true before restarting a failed cached-review refresh (Codex P1 #498)', async () => {
    const dir = mkdtempSync(join(root, 'replay-tool-refresh-fail-'));
    const docs = createJsonStore(createFileStore(dir));
    const oldV = P - 2;
    await docs.put(`${MATCH}.beastmaster.zh.p${oldV}.review.json`, storedDoc('旧版保底复盘。'));

    let shouldFail = true;
    let attempts = 0;
    const healthy = mockModel('显式重试后的最新版。');
    const complete = async (o: any) => {
      if (shouldFail) {
        attempts += 1;
        throw new DOMException('timed out', 'TimeoutError');
      }
      return healthy.complete(o);
    };
    const traces = { get: async () => JSON.parse(traceJson) };
    const clock = { t: 1_000_000 };
    const makeApi = () => {
      const svc: any = createAgentService({ traces, docs, complete, model: 'deepseek-flash', now: () => clock.t });
      const router: any = createAgentRouter({ service: svc, resolveClientIp: () => '4.4.4.4' });
      return { svc, api: router.forRequest({ headers: {} }) };
    };
    const a = makeApi();

    // 1. Initial refresh: true starts one generation.
    const started: any = await replayReview(a.api, { match_id: MATCH, hero: 'beastmaster', lang: 'zh', refresh: true });
    expect(started).toMatchObject({ status: 'reviewing', hero: 'beastmaster', lang: 'zh' });
    await vi.waitFor(async () => {
      const st = await a.svc.status(MATCH, 'beastmaster', 'zh');
      expect(st.refresh_failed).toEqual({ reason: 'timeout' });
    }, { timeout: 5000 });
    expect(attempts).toBe(1);

    // 2. Polling with the SAME arguments (refresh: true, no retry) MUST NOT start another generation.
    const polledSame: any = await replayReview(a.api, { match_id: MATCH, hero: 'beastmaster', lang: 'zh', refresh: true });
    expect(polledSame).toMatchObject({
      status: 'ready',
      cached: true,
      stale_version: true,
      prompt_version: oldV,
      latest_prompt_version: P,
      refresh_failed: { reason: 'timeout' },
      verdict: '旧版保底复盘。',
    });
    expect(polledSame.note).toContain('retry: true');
    await new Promise((r) => setTimeout(r, 40));
    expect(attempts).toBe(1);

    // 3. Even >60s later on another instance (where status() omits refresh_failed), lastFailure() still blocks silent restarts.
    clock.t += 61_000;
    const b = makeApi();
    expect((await b.svc.status(MATCH, 'beastmaster', 'zh')).refresh_failed).toBeUndefined();
    const polledPeer: any = await replayReview(b.api, { match_id: MATCH, hero: 'beastmaster', lang: 'zh', refresh: true });
    expect(polledPeer).toMatchObject({
      status: 'ready',
      cached: true,
      stale_version: true,
      prompt_version: oldV,
      refresh_failed: { reason: 'timeout' },
      verdict: '旧版保底复盘。',
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(attempts).toBe(1);

    // 4. Explicit refresh: true + retry: true starts one retry and instructs polling without retry: true.
    shouldFail = false;
    const retried: any = await replayReview(b.api, { match_id: MATCH, hero: 'beastmaster', lang: 'zh', refresh: true, retry: true });
    expect(retried).toMatchObject({ status: 'reviewing', hero: 'beastmaster', lang: 'zh' });
    expect(retried.message).toContain('without retry: true');
    await vi.waitFor(async () => {
      const done: any = await replayReview(b.api, { match_id: MATCH, hero: 'beastmaster', lang: 'zh', refresh: true });
      expect(done).toMatchObject({ status: 'ready', verdict: '显式重试后的最新版。' });
      expect(done.stale_version).toBeUndefined();
      expect(done.refresh_failed).toBeUndefined();
    }, { timeout: 5000 });
    expect(attempts).toBe(1);
    expect(healthy.calls).toBe(2);
  });

  it('failed explicit refresh keeps the older compatible review accessible on reopen and ordinary start (Codex P2 #498)', async () => {
    const dir = mkdtempSync(join(root, 'failed-refresh-'));
    const docs = createJsonStore(createFileStore(dir));
    const oldV = P - 2;
    await docs.put(`${MATCH}.beastmaster.zh.p${oldV}.review.json`, storedDoc('旧版保底复盘。'));

    let shouldFail = true;
    const healthy = mockModel('重试后的最新版。');
    let attempts = 0;
    const complete = async (o: any) => {
      if (shouldFail) {
        attempts += 1;
        throw new DOMException('timed out', 'TimeoutError');
      }
      return healthy.complete(o);
    };
    const traces = { get: async () => JSON.parse(traceJson) };
    const clock = { t: 1_000_000 };
    const svcA: any = createAgentService({ traces, docs, complete, model: 'deepseek-flash', now: () => clock.t });
    const svcB: any = createAgentService({ traces, docs, complete, model: 'deepseek-flash', now: () => clock.t });
    const admit = vi.fn(() => null);

    // Trigger explicit refresh that fails with timeout.
    expect(await svcA.start(MATCH, 'beastmaster', 'zh', { admit, refresh: true })).toMatchObject({ status: 'running' });
    await vi.waitFor(async () => {
      const s = await svcA.status(MATCH, 'beastmaster', 'zh');
      expect(s.refresh_failed).toEqual({ reason: 'timeout' });
    }, { timeout: 5000 });
    expect(attempts).toBe(1);
    expect(admit).toHaveBeenCalledTimes(1);

    // Reopening on the same instance (and another instance within 60s) still serves the cached review, not status='failed'.
    const afterSame = await svcA.status(MATCH, 'beastmaster', 'zh');
    expect(afterSame).toMatchObject({
      status: 'ready',
      prompt_version: oldV,
      latest_prompt_version: P,
      stale_version: true,
      cached: true,
      refresh_failed: { reason: 'timeout' },
      review: { verdict: '旧版保底复盘。' },
    });
    const afterPeer = await svcB.status(MATCH, 'beastmaster', 'zh');
    expect(afterPeer).toMatchObject({
      status: 'ready',
      prompt_version: oldV,
      stale_version: true,
      refresh_failed: { reason: 'timeout' },
      review: { verdict: '旧版保底复盘。' },
    });

    // An ordinary start() without refresh reuses the saved cache and spends zero admissions / model calls.
    const ordinary = await svcA.start(MATCH, 'beastmaster', 'zh', { admit });
    expect(ordinary).toMatchObject({
      status: 'ready',
      prompt_version: oldV,
      stale_version: true,
      refresh_failed: { reason: 'timeout' },
      review: { verdict: '旧版保底复盘。' },
    });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(1);

    // Once the model recovers, an explicit refresh: true succeeds and clears stale_version & refresh_failed.
    shouldFail = false;
    expect(await svcA.start(MATCH, 'beastmaster', 'zh', { admit, refresh: true })).toMatchObject({ status: 'running' });
    expect(admit).toHaveBeenCalledTimes(2);
    await vi.waitFor(async () => {
      const fresh = await svcA.status(MATCH, 'beastmaster', 'zh');
      expect(fresh).toMatchObject({ status: 'ready', prompt_version: P, review: { verdict: '重试后的最新版。' } });
      expect(fresh.stale_version).toBeUndefined();
      expect(fresh.refresh_failed).toBeUndefined();
    }, { timeout: 5000 });
  });

  it('shares the single-flight start claim between concurrent ordinary and refresh requests (Codex P2 #498)', async () => {
    const delayedTrace = () => ({
      get: async () => {
        await new Promise((r) => setTimeout(r, 25));
        return JSON.parse(traceJson);
      },
    });

    // 1. No cache exists + dispatch queue: simultaneous ordinary & refresh (both orderings) produce 1 admission and 1 queued task.
    for (const order of [['ordinary', 'refresh'], ['refresh', 'ordinary']] as const) {
      const dir = mkdtempSync(join(root, `claim-q-${order[0]}-`));
      const docs = createJsonStore(createFileStore(dir));
      const queue: any[] = [];
      const admit = vi.fn(() => null);
      const svc: any = createAgentService({
        traces: delayedTrace(),
        docs,
        complete: mockModel().complete,
        dispatch: async (task: any) => { queue.push(task); },
      });
      const reqs = order.map((kind) => svc.start(MATCH, 'beastmaster', 'zh', { admit, ...(kind === 'refresh' ? { refresh: true } : {}) }));
      const results = await Promise.all(reqs);
      expect(results.map((r: any) => r.status)).toEqual(['running', 'running']);
      expect(admit).toHaveBeenCalledTimes(1);
      expect(queue).toHaveLength(1);
    }

    // 2. No cache exists + in-process execution: simultaneous ordinary & refresh call the model once (2 turns total).
    {
      const dir = mkdtempSync(join(root, 'claim-exec-'));
      const docs = createJsonStore(createFileStore(dir));
      const m = mockModel('单次生成。');
      const admit = vi.fn(() => null);
      const svc: any = createAgentService({ traces: delayedTrace(), docs, complete: m.complete });
      const [a, b] = await Promise.all([
        svc.start(MATCH, 'beastmaster', 'zh', { admit }),
        svc.start(MATCH, 'beastmaster', 'zh', { admit, refresh: true }),
      ]);
      expect([a.status, b.status]).toEqual(['running', 'running']);
      await vi.waitFor(async () => expect((await svc.status(MATCH, 'beastmaster', 'zh')).status).toBe('ready'), { timeout: 5000 });
      expect(admit).toHaveBeenCalledTimes(1);
      expect(m.calls).toBe(2);
    }

    // 3. Stale cache exists: simultaneous ordinary (first) + refresh (second) gives ordinary the cached review and still starts refresh once.
    {
      const dir = mkdtempSync(join(root, 'claim-stale-ord-first-'));
      const docs = createJsonStore(createFileStore(dir));
      await docs.put(`${MATCH}.beastmaster.zh.p${P - 2}.review.json`, storedDoc('旧版缓存。'));
      const queue: any[] = [];
      const admit = vi.fn(() => null);
      const svc: any = createAgentService({
        traces: delayedTrace(),
        docs,
        complete: mockModel().complete,
        dispatch: async (task: any) => { queue.push(task); },
      });
      const [ord, ref] = await Promise.all([
        svc.start(MATCH, 'beastmaster', 'zh', { admit }),
        svc.start(MATCH, 'beastmaster', 'zh', { admit, refresh: true }),
      ]);
      expect(ord).toMatchObject({ status: 'ready', prompt_version: P - 2, stale_version: true });
      expect(ref).toMatchObject({ status: 'running' });
      expect(admit).toHaveBeenCalledTimes(1);
      expect(queue).toHaveLength(1);
    }

    // 4. Stale cache exists: simultaneous refused refresh (first) + ordinary (second) still hands ordinary the cached review.
    {
      const dir = mkdtempSync(join(root, 'claim-stale-ref-refused-'));
      const docs = createJsonStore(createFileStore(dir));
      await docs.put(`${MATCH}.beastmaster.zh.p${P - 2}.review.json`, storedDoc('旧版保底。'));
      const refusal = { status: 429, body: { code: 'rate_limited', retryAfterSec: 30 } };
      const svc: any = createAgentService({
        traces: delayedTrace(),
        docs,
        complete: mockModel().complete,
      });
      const [ref, ord] = await Promise.all([
        svc.start(MATCH, 'beastmaster', 'zh', { admit: () => refusal, refresh: true }),
        svc.start(MATCH, 'beastmaster', 'zh', { admit: () => null }),
      ]);
      expect(ref).toEqual({ status: 'refused', refusal });
      expect(ord).toMatchObject({ status: 'ready', prompt_version: P - 2, stale_version: true, review: { verdict: '旧版保底。' } });
    }
  });
});
