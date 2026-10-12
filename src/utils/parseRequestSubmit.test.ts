import { describe, it, expect, vi } from 'vitest';
import {
  createParseRequestSubmitter,
  isClientAbortError,
  isTimeoutAbortError,
} from '../../lib/matchReview/parseRequestSubmit.js';
import {
  createParseRequestBudget,
  createParseRequestTracker,
} from '../../lib/matchReview/matchParse.js';

// What undici's fetch rejects with when an AbortController.abort() (no reason)
// fires — the shape a client disconnect produces on the server side.
function abortError() {
  return Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
}

// What AbortSignal.timeout() aborts fetch with — a TimeoutError DOMException.
function timeoutError() {
  return Object.assign(new Error('The operation was aborted due to timeout'), {
    name: 'TimeoutError',
  });
}

type FetchInitLike = { method?: string, signal?: AbortSignal };

function okResponse(body: object) {
  return { ok: true, status: 200, json: async () => body };
}

function createHarness(overrides: Record<string, unknown> = {}) {
  const tracker = createParseRequestTracker();
  const budget = createParseRequestBudget({ perClientMax: 100, globalMax: 100 });
  const fetchImpl = vi.fn(async (_url: string, _init?: FetchInitLike) =>
    okResponse({ job: { jobId: 42 } }));
  const submit = createParseRequestSubmitter({
    tracker,
    budget,
    fetchImpl,
    baseUrl: 'https://api.opendota.com/api',
    apiKey: 'test-key',
    // 0 = no AbortSignal.timeout timer in tests; abort paths pass their own
    // signal or throw synchronously from the fake fetch.
    timeoutMs: 0,
    ...overrides,
  });
  // NOTE: when a test overrides fetchImpl, assert on its own local mock —
  // this fetchImpl is the default spy.
  return { tracker, budget, fetchImpl, submit };
}

describe('abort classification', () => {
  it('recognizes timeout aborts by name', () => {
    expect(isTimeoutAbortError(timeoutError())).toBe(true);
    expect(isTimeoutAbortError(abortError())).toBe(false);
    expect(isTimeoutAbortError(new Error('fetch failed'))).toBe(false);
    expect(isTimeoutAbortError(undefined)).toBe(false);
  });

  it('treats only an aborted caller signal as a client disconnect', () => {
    const controller = new AbortController();
    expect(isClientAbortError(abortError(), controller.signal)).toBe(false);
    controller.abort();
    expect(isClientAbortError(abortError(), controller.signal)).toBe(true);
    // A live caller signal is never a client abort, whatever the error.
    expect(isClientAbortError(abortError(), new AbortController().signal)).toBe(false);
    expect(isClientAbortError(abortError(), undefined)).toBe(false);
  });

  it('classifies a timeout racing a disconnect as a timeout, not a client abort', () => {
    const controller = new AbortController();
    controller.abort();
    expect(isClientAbortError(timeoutError(), controller.signal)).toBe(false);
  });
});

describe('submitParseRequest', () => {
  it('submits POST /request/{matchId} with the api key and records the job', async () => {
    const h = createHarness();
    const payload = await h.submit(9035042364, '203.0.113.7', { lang: 'en' });
    expect(payload).toMatchObject({ status: 'requested', jobId: 42 });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.opendota.com/api/request/9035042364?api_key=test-key');
    expect(init?.method).toBe('POST');
    expect(h.tracker.active(9035042364)).toMatchObject({ jobId: 42, failed: false });
  });

  it('dedupes within the cooldown window without fetching or consuming budget', async () => {
    const h = createHarness();
    await h.submit(1, '203.0.113.7');
    const payload = await h.submit(1, '198.51.100.9');
    expect(payload.status).toBe('pending');
    expect(payload.jobId).toBe(42);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    // The dedup path returns before the budget is touched.
    expect(h.budget.tryConsume('198.51.100.9')).toBeNull();
  });

  it('reports throttling without submitting or touching the tracker', async () => {
    const budget = createParseRequestBudget({ perClientMax: 1, globalMax: 100 });
    const h = createHarness({ budget });
    await h.submit(1, '203.0.113.7');
    const payload = await h.submit(2, '203.0.113.7');
    expect(payload.status).toBe('throttled');
    expect(payload.retryAfterSec).toBeGreaterThan(0);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.tracker.active(2)).toBeNull();
  });

  it('records a failure for a non-ok upstream response', async () => {
    const h = createHarness({
      fetchImpl: vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })),
    });
    const payload = await h.submit(1, '203.0.113.7');
    expect(payload.status).toBe('failed');
    expect(h.tracker.active(1)).toMatchObject({ failed: true });
  });

  it('records a failure for a network error', async () => {
    const h = createHarness({
      fetchImpl: vi.fn(async () => { throw new Error('fetch failed'); }),
    });
    const payload = await h.submit(1, '203.0.113.7');
    expect(payload.status).toBe('failed');
    expect(h.tracker.active(1)).toMatchObject({ failed: true });
  });

  it('records a failure for a submission timeout', async () => {
    const h = createHarness({
      fetchImpl: vi.fn(async () => { throw timeoutError(); }),
    });
    const payload = await h.submit(1, '203.0.113.7', { signal: new AbortController().signal });
    expect(payload.status).toBe('failed');
    expect(h.tracker.active(1)).toMatchObject({ failed: true });
  });

  it('rethrows client-disconnect aborts without recording a failure', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      throw abortError();
    });
    const h = createHarness({ fetchImpl });

    await expect(h.submit(1, '203.0.113.7', { signal: controller.signal }))
      .rejects.toThrow(/aborted/);
    // Not marked failed: the tracker keeps the requested/pending state, so a
    // later visitor is not shown a bogus 'failed' status for 60s.
    expect(h.tracker.active(1)).toMatchObject({ failed: false, jobId: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not treat a caller-side AbortError with a live signal as a client abort', async () => {
    // GET /api/review/:id passes no signal; a bare AbortError there is an
    // upstream failure and must still be recorded (previously-recorded path).
    const h = createHarness({
      fetchImpl: vi.fn(async () => { throw abortError(); }),
    });
    const payload = await h.submit(1, '203.0.113.7');
    expect(payload.status).toBe('failed');
    expect(h.tracker.active(1)).toMatchObject({ failed: true });
  });
});
