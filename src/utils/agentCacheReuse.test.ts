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
const chapters = [
  { topic: 'midgame', title: '中期团战与大招时机', analysis: '27:27 吼进黑皇杖定住 3.4 秒。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 吼进黑皇杖，定住 3.4 秒' }] },
  { topic: 'skills_and_items', title: '大招留人思路', analysis: '幻影刺客开了 7 次黑皇杖，咆哮必须留给她。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 吼进黑皇杖，定住 3.4 秒' }] },
];
const submit = {
  verdict: '咆哮没有留给幻影刺客。',
  highlights: [],
  findings: [finding],
  chapters,
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

describe('review cache: the current prompt version only (owner, 2026-11-28; was cross-version reuse, #486)', () => {
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

  // Owner, 2026-11-28: every new prompt version voids the conclusions of every earlier review. Only the replay's facts
  // (the stored trace) carry over; a review is written again from them. This replaces the cross-version reuse of #486.
  it('an earlier version\'s review is never served: status is none, a start writes a new one from the stored trace', async () => {
    const dir = mkdtempSync(join(root, 'cross-ver-'));
    const docs = createJsonStore(createFileStore(join(dir, 'reviews')));
    const oldKey = `${MATCH}.beastmaster.zh.p${P - 2}.review.json`;
    await docs.put(oldKey, storedDoc('旧版 v-2 结论。'));
    await docs.put(`${MATCH}.beastmaster.p${P - 1}.review.json`, storedDoc('旧版 v-1 结论。'));

    const m = mockModel('全新最新版结论。');
    let traceReads = 0;
    const traces = { get: async () => { traceReads += 1; return JSON.parse(traceJson); } };
    const svc: any = createAgentService({ traces, docs, complete: m.complete, model: 'deepseek-flash' });

    const before = await svc.status(MATCH, 'beastmaster', 'zh');
    expect(before).toEqual({ status: 'none' });
    expect(m.calls).toBe(0);
    // Nor does the chat answer from an earlier review's conclusions.
    let seenPrompt = '';
    const chatSvc: any = createAgentService({ traces, docs, complete: async (o: any) => { seenPrompt = JSON.stringify(o.messages); return { text: '好的。' }; }, model: 'deepseek-flash' });
    await chatSvc.chat({ matchId: MATCH, hero: 'beastmaster', lang: 'zh', question: '为什么？', history: [] });
    expect(seenPrompt).not.toContain('旧版');

    const admit = vi.fn(() => null);
    expect(await svc.start(MATCH, 'beastmaster', 'zh', { admit })).toMatchObject({ status: 'running' });
    expect(admit).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => {
      const fresh = await svc.status(MATCH, 'beastmaster', 'zh');
      expect(fresh).toMatchObject({ status: 'ready', prompt_version: P, review: { verdict: '全新最新版结论。' } });
      expect(fresh.stale_version).toBeUndefined();
      expect(fresh.cached).toBeUndefined();
    }, { timeout: 5000 });
    expect(m.calls).toBe(2);
    // The replay's facts were the stored trace's: read, never parsed again. The earlier file is left as it was.
    expect(traceReads).toBeGreaterThan(0);
    expect((await docs.get(oldKey))?.review?.verdict).toBe('旧版 v-2 结论。');
  });

  it('over HTTP: an earlier version\'s review is none, and a start is charged and writes the current version', async () => {
    const dir = mkdtempSync(join(root, 'http-refresh-'));
    const docs = createJsonStore(createFileStore(dir));
    await docs.put(`${MATCH}.beastmaster.zh.p${P - 1}.review.json`, storedDoc('旧版 HTTP 缓存。'));
    let acquired = 0;
    const m = mockModel('HTTP 新版。');
    const service: any = createAgentService({ traces: { get: async () => JSON.parse(traceJson) }, docs, complete: m.complete, model: 'deepseek-flash' });
    const app = express();
    app.use(express.json());
    app.use(createAgentRouter({ service, resolveClientIp: () => '10.42.0.1', llm: { acquire: () => { acquired += 1; return { ok: true }; } } }));
    const srv = app.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const get = async () => (await fetch(`${base}/api/agent/${MATCH}/review?hero=beastmaster&lang=zh`)).json();
      expect(await get()).toMatchObject({ status: 'none' });
      const r = await fetch(`${base}/api/agent/${MATCH}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hero: 'beastmaster', lang: 'zh' }) });
      expect([r.status, (await r.json()).status]).toEqual([202, 'running']);
      expect(acquired).toBe(1);
      await vi.waitFor(async () => expect(await get()).toMatchObject({ status: 'ready', prompt_version: P, review: { verdict: 'HTTP 新版。' } }), { timeout: 5000 });
      expect(JSON.stringify(await get())).not.toContain('旧版');
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

  it('auto-invalidates malformed v84 cached reviews with 0 chapters (e.g. 9107883117 with 7 findings, 0 chapters) while keeping healthy v84 caches', async () => {
    const dir = mkdtempSync(join(root, 'malformed-v84-'));
    const docs = createJsonStore(createFileStore(join(dir, 'reviews')));
    const key = `${MATCH}.beastmaster.p${P}.review.json`;
    // 1) Malformed v84 review: 7 findings and 0 chapters.
    await docs.put(key, storedDoc('7 条问题无章节的畸形缓存。', {
      prompt_version: P,
      findings: Array.from({ length: 7 }, (_, i) => ({ ...finding, title: `问题 ${i + 1}` })),
      chapters: [],
    }));

    const m = mockModel('自动修复后的规范复盘。');
    const svc: any = createAgentService({ traces: { get: async () => JSON.parse(traceJson) }, docs, complete: m.complete, model: 'deepseek-flash' });
    expect(await svc.status(MATCH, 'beastmaster', 'zh')).toEqual({ status: 'none' });
    expect(m.calls).toBe(0);

    // 2) Also invalidates a v84 cached review with <= 3 findings but 0 chapters.
    await docs.put(key, storedDoc('缺章节的 v84 缓存。', {
      prompt_version: P,
      findings: [finding],
      chapters: [],
    }));
    expect(await svc.status(MATCH, 'beastmaster', 'zh')).toEqual({ status: 'none' });

    // 3) Starting now writes a valid v84 review with chapters, which is then served from cache with 0 extra model calls.
    expect((await svc.start(MATCH, 'beastmaster', 'zh')).status).toBe('running');
    await vi.waitFor(async () => expect((await svc.status(MATCH, 'beastmaster', 'zh')).status).toBe('ready'), { timeout: 5000 });
    expect(m.calls).toBe(2);
    const ready = await svc.status(MATCH, 'beastmaster', 'zh');
    expect(ready).toMatchObject({ status: 'ready', review: { verdict: '自动修复后的规范复盘。' } });
    expect(ready.review.chapters.length).toBeGreaterThanOrEqual(2);
    expect(ready.review.findings.length).toBeLessThanOrEqual(3);

    // 4) A fresh service instance (simulating restart or another Cloud Run instance) accepts the saved review identically.
    const freshSvc: any = createAgentService({ traces: { get: async () => JSON.parse(traceJson) }, docs, complete: m.complete, model: 'deepseek-flash' });
    const reloaded = await freshSvc.status(MATCH, 'beastmaster', 'zh');
    expect(reloaded).toMatchObject({ status: 'ready', review: { verdict: '自动修复后的规范复盘。' } });

    // 5) If a model refuses to supply chapters even after repair, the run fails as unverified and is NOT stored as ready.
    const dirBad = mkdtempSync(join(root, 'stubborn-no-chapters-'));
    const docsBad = createJsonStore(createFileStore(join(dirBad, 'reviews')));
    let badCalls = 0;
    const stubbornModel = async () => {
      badCalls += 1;
      if (badCalls === 1) return { toolCalls: [{ id: 'd', name: 'death_context', args: { hero: 'beastmaster', index: 9 } }] };
      return {
        toolCalls: [{
          id: `s${badCalls}`,
          name: 'submit_review',
          args: { verdict: '36:05 阵亡时咆哮未放出。', findings: [finding], chapters: [], blind_spots: [] },
        }],
      };
    };
    const svcBad: any = createAgentService({ traces: { get: async () => JSON.parse(traceJson) }, docs: docsBad, complete: stubbornModel, model: 'deepseek-flash' });
    expect((await svcBad.start(MATCH, 'beastmaster', 'zh')).status).toBe('running');
    await vi.waitFor(async () => expect((await svcBad.status(MATCH, 'beastmaster', 'zh')).status).toBe('failed'), { timeout: 5000 });
    expect(await svcBad.status(MATCH, 'beastmaster', 'zh')).toMatchObject({ status: 'failed', reason: 'unverified' });
    const freshBad: any = createAgentService({ traces: { get: async () => JSON.parse(traceJson) }, docs: docsBad, complete: stubbornModel, model: 'deepseek-flash' });
    expect((await freshBad.status(MATCH, 'beastmaster', 'zh')).status).not.toBe('ready');
  });

});
