import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  createReadOnlyParseStatusResolver,
  createReviewParseRequestHandler,
  rejectParseRequestGet,
} from '../../lib/matchReview/parseRequestEndpoint.js';
import { validateParseRequestPost } from '../../lib/matchReview/reviewRequestGuard.js';
import { createParseRequestSubmitter } from '../../lib/matchReview/parseRequestSubmit.js';
import {
  createParseRequestBudget,
  createParseRequestTracker,
} from '../../lib/matchReview/matchParse.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const parsedFixture = JSON.parse(
  readFileSync(path.join(fixturesDir, 'match9035042364.parsed.json'), 'utf8'),
);
const unparsedFixture = JSON.parse(
  readFileSync(path.join(fixturesDir, 'match9035042364.unparsed.json'), 'utf8'),
);

type FetchInitLike = { method?: string, signal?: AbortSignal };

// The repo has no @types/express; type just the surface the harness touches.
type ExpressApp = {
  use: (middleware: unknown) => void;
  post: (path: string, handler: unknown) => void;
  get: (path: string, handler: unknown) => void;
  listen: (port: number, host: string) => Server;
};

function okResponse(body: object) {
  return { ok: true, status: 200, json: async () => body };
}

/**
 * Builds the endpoint stack exactly the way server.js wires it (express.json,
 * POST handler, GET 405 guard) with every dependency injected and spied.
 * `options.budget` overrides the submitter's budget (dedupe/budget tests).
 */
function createHarness(options: { budget?: ReturnType<typeof createParseRequestBudget> } = {}) {
  const tracker = createParseRequestTracker();
  const budget = options.budget ?? createParseRequestBudget({ perClientMax: 100, globalMax: 100 });
  const fetchImpl = vi.fn(async (_url: string, _init?: FetchInitLike) =>
    okResponse({ job: { jobId: 42 } }));
  const getMatchDetail = vi.fn(
    async (_matchId: number, _opts?: { signal?: AbortSignal }) => unparsedFixture,
  );
  const submitParseRequest = createParseRequestSubmitter({
    tracker,
    budget,
    fetchImpl,
    baseUrl: 'https://api.opendota.com/api',
    apiKey: 'test-key',
    timeoutMs: 0,
  });
  // Client identity is injected in production (trusted-proxy XFF resolution);
  // tests steer it with a header so per-client budgets are observable.
  const resolveClientIp = vi.fn(
    (req: object) =>
      String((req as { headers?: Record<string, unknown> }).headers?.['x-test-client'] || '203.0.113.7'),
  );
  const handle = createReviewParseRequestHandler({
    submitParseRequest,
    getMatchDetail,
    resolveClientIp,
  });

  const express = createRequire(import.meta.url)('express') as
    (() => ExpressApp) & { json: () => unknown };
  const app = express();
  app.use(express.json());
  app.post('/api/review/:matchId/parse-request', handle);
  app.get('/api/review/:matchId/parse-request', rejectParseRequestGet);

  return { app, tracker, budget, fetchImpl, getMatchDetail, resolveClientIp };
}

describe('createReadOnlyParseStatusResolver (facts load never submits)', () => {
  it('reports unparsed for an unparsed match with no tracker entry — in zh and en', () => {
    const tracker = createParseRequestTracker();
    const resolve = createReadOnlyParseStatusResolver({ tracker });

    const zh = resolve(9035042364, unparsedFixture, 'zh');
    expect(zh.status).toBe('unparsed');
    expect(zh.jobId).toBeNull();
    expect(zh.retryAfterSec).toBeNull();
    expect(zh.message).toMatch(/解析/);

    const en = resolve(9035042364, unparsedFixture, 'en');
    expect(en.status).toBe('unparsed');
    expect(en.message).toMatch(/request a parse/i);
  });

  it('stays parsed for parsed matches', () => {
    const resolve = createReadOnlyParseStatusResolver({ tracker: createParseRequestTracker() });
    expect(resolve(9035042364, parsedFixture, 'en').status).toBe('parsed');
  });

  it('mirrors an active tracker entry read-only: pending and failed', () => {
    const tracker = createParseRequestTracker();
    const resolve = createReadOnlyParseStatusResolver({ tracker });

    tracker.markRequested(1);
    tracker.markResult(1, { jobId: 7 });
    const pending = resolve(1, unparsedFixture, 'en');
    expect(pending).toMatchObject({ status: 'pending', jobId: 7 });
    expect(pending.retryAfterSec).toBeGreaterThan(0);

    tracker.markRequested(2);
    tracker.markResult(2, { failed: true });
    expect(resolve(2, unparsedFixture, 'en').status).toBe('failed');
  });

  it('requires a tracker', () => {
    // Runtime guard on the JS side; the type-level requirement is bypassed
    // deliberately for this test.
    expect(() => createReadOnlyParseStatusResolver({} as never)).toThrow(TypeError);
  });
});

describe('POST /api/review/:matchId/parse-request (only submission path)', () => {
  /** Started per test (some tests need custom budgets before the app exists). */
  let server: Server | null = null;
  let baseUrl = '';

  async function startApp(harness: ReturnType<typeof createHarness>) {
    server = harness.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
    const addr = server!.address();
    baseUrl = `http://127.0.0.1:${(addr as { port: number }).port}`;
  }

  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  const jsonPost = (matchId: number | string, extra: RequestInit = {}) => {
    const { headers: extraHeaders, ...rest } = extra;
    return fetch(`${baseUrl}/api/review/${matchId}/parse-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...((extraHeaders as Record<string, string>) || {}) },
      body: JSON.stringify({}),
      ...rest,
    });
  };

  it('submits exactly once for a JSON POST and returns the parse payload', async () => {
    const h = createHarness();
    await startApp(h);

    const res = await jsonPost(9035042364);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'requested', jobId: 42 });
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(typeof body.message).toBe('string');
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.opendota.com/api/request/9035042364?api_key=test-key');
    expect(init?.method).toBe('POST');
  });

  it('threads lang through to the i18n message', async () => {
    const h = createHarness();
    await startApp(h);

    const res = await fetch(`${baseUrl}/api/review/9035042364/parse-request?lang=zh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang: 'zh' }),
    });
    const body = await res.json();
    expect(body.status).toBe('requested');
    expect(body.message).toMatch(/解析|重试/);
  });

  it('dedupes repeated requests for the same match (cooldown, no second submission)', async () => {
    const h = createHarness();
    await startApp(h);

    const first = await (await jsonPost(9035042364)).json();
    expect(first.status).toBe('requested');
    const second = await (await jsonPost(9035042364)).json();
    expect(second.status).toBe('pending');
    expect(second.jobId).toBe(42);
    expect(second.retryAfterSec).toBeGreaterThan(0);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('enforces the per-client budget across matches (rate-limited, no submission)', async () => {
    const h = createHarness({
      budget: createParseRequestBudget({ perClientMax: 1, globalMax: 100 }),
    });
    await startApp(h);

    const headers = { 'X-Test-Client': '198.51.100.9' };
    const first = await (await jsonPost(9035042364, { headers })).json();
    expect(first.status).toBe('requested');
    // Different match, same client → per-client budget exhausted.
    const second = await (await jsonPost(8985182860, { headers })).json();
    expect(second.status).toBe('throttled');
    expect(second.retryAfterSec).toBeGreaterThan(0);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('enforces the global budget across clients', async () => {
    const h = createHarness({
      budget: createParseRequestBudget({ perClientMax: 100, globalMax: 1 }),
    });
    await startApp(h);

    const first = await (await jsonPost(9035042364, { headers: { 'X-Test-Client': 'a' } })).json();
    expect(first.status).toBe('requested');
    const second = await (await jsonPost(8985182860, { headers: { 'X-Test-Client': 'b' } })).json();
    expect(second.status).toBe('throttled');
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('answers parsed without consuming budget or submitting', async () => {
    const h = createHarness();
    await startApp(h);
    h.getMatchDetail.mockResolvedValue(parsedFixture);

    const body = await (await jsonPost(9035042364)).json();
    expect(body).toMatchObject({ status: 'parsed', jobId: null, retryAfterSec: null });
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a failed submission as a non-fatal payload (not an HTTP error)', async () => {
    const h = createHarness();
    await startApp(h);
    h.fetchImpl.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });

    const res = await jsonPost(9035042364);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('failed');
    expect(body.message).toMatch(/retry/i);
  });

  it('rejects GET with a JSON 405 (never the SPA HTML fallback)', async () => {
    const h = createHarness();
    await startApp(h);

    const res = await fetch(`${baseUrl}/api/review/9035042364/parse-request`);
    expect(res.status).toBe(405);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.error).toBe('Use POST');
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a POST without JSON content-type and without X-Requested-With', async () => {
    const h = createHarness();
    await startApp(h);

    const res = await fetch(`${baseUrl}/api/review/9035042364/parse-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    });
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.getMatchDetail).not.toHaveBeenCalled();
  });

  it('accepts a POST with X-Requested-With even without a JSON content-type', async () => {
    const h = createHarness();
    await startApp(h);

    const res = await fetch(`${baseUrl}/api/review/9035042364/parse-request`, {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('requested');
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid match id with 400', async () => {
    const h = createHarness();
    await startApp(h);

    const res = await jsonPost('not-a-number');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid match ID');
  });

  it('maps upstream match-fetch failures (404) through the OpenDota error mapper', async () => {
    const h = createHarness();
    await startApp(h);
    h.getMatchDetail.mockRejectedValue(
      Object.assign(new Error('HTTP 404'), { status: 404, upstream: 'opendota' }),
    );

    const res = await jsonPost(9035042364);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ upstream: 'opendota', upstreamStatus: 404 });
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('aborts the upstream fetch and never submits when the client disconnects', async () => {
    const h = createHarness();
    await startApp(h);
    h.getMatchDetail.mockImplementation(
      (_matchId: number, opts?: { signal?: AbortSignal }): Promise<object> =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })),
          );
        }),
    );

    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/api/review/9035042364/parse-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    await expect(pending).rejects.toThrow();

    // Give the server a beat to run its disconnect cleanup, then confirm the
    // parse was never submitted and the server survived.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(server?.listening).toBe(true);
  });
});

describe('validateParseRequestPost', () => {
  it('requires a JSON content-type or the X-Requested-With header', () => {
    expect(
      validateParseRequestPost({ headers: { 'content-type': 'application/json; charset=utf-8' } }).ok,
    ).toBe(true);
    expect(
      validateParseRequestPost({ headers: { 'x-requested-with': 'XMLHttpRequest' } }).ok,
    ).toBe(true);
    const rejected = validateParseRequestPost({ headers: { 'content-type': 'text/plain' } });
    expect(rejected.ok).toBe(false);
    expect(rejected.status).toBe(415);
  });

  it('rejects cross-origin posts regardless of content-type', () => {
    const rejected = validateParseRequestPost({
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
        host: 'dota2.ai',
      },
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.status).toBe(403);
  });
});
