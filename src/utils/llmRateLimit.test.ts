import { describe, it, expect, vi } from 'vitest';
import { createLlmRateLimitMiddleware } from '../../lib/llmRateLimit.js';
import { createSlidingWindowLimiter } from '../../lib/rateLimiter.js';

/** Minimal Express-style req/res mocks — pure middleware, no server needed. */
interface ReqMock {
  method: string;
  headers: Record<string, string>;
  body?: { lang?: unknown; [key: string]: unknown };
  query: Record<string, unknown>;
}

interface ResMock {
  headers: Record<string, string>;
  statusCode?: number;
  payload?: { error?: string; message?: string; retryAfter?: number };
  setHeader(key: string, value: string): ResMock;
  status(code: number): ResMock;
  json(payload: unknown): ResMock;
}

function createReqMock({ method = 'POST', body, query, accept }: {
  method?: string; body?: Record<string, unknown>; query?: Record<string, unknown>; accept?: string;
} = {}): ReqMock {
  return {
    method,
    headers: accept ? { accept } : {},
    body,
    query: query ?? {},
  };
}

function createResMock(): ResMock {
  const res: ResMock = {
    headers: {},
    setHeader(key, value) { res.headers[key] = value; return res; },
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.payload = payload as ResMock['payload']; return res; },
  };
  return res;
}

function createFixedLimiter(result: { ok: boolean; retryAfterSec: number }) {
  return { tryConsume: vi.fn(() => result) };
}

describe('createLlmRateLimitMiddleware — allowed requests', () => {
  it('consumes one budget unit via resolveClientIp(req) and calls next()', () => {
    const limiter = createFixedLimiter({ ok: true, retryAfterSec: 0 });
    const resolveClientIp = vi.fn(() => '9.9.9.9');
    const middleware = createLlmRateLimitMiddleware({ limiter, resolveClientIp, name: 'chat' });
    const req = createReqMock({ body: { message: 'hi' } });
    const res = createResMock();
    const next = vi.fn();

    middleware(req, res, next);

    expect(resolveClientIp).toHaveBeenCalledWith(req);
    expect(limiter.tryConsume).toHaveBeenCalledWith('9.9.9.9');
    expect(next).toHaveBeenCalledTimes(1);
    // Nothing written: no status, no headers, no body.
    expect(res.statusCode).toBeUndefined();
    expect(res.headers).toEqual({});
    expect(res.payload).toBeUndefined();
  });
});

describe('createLlmRateLimitMiddleware — 429 responses', () => {
  it('responds 429 with Retry-After header and localized JSON (en default)', () => {
    const middleware = createLlmRateLimitMiddleware({
      limiter: createFixedLimiter({ ok: false, retryAfterSec: 42 }),
      resolveClientIp: () => '1.2.3.4',
      name: 'chat',
    });
    const res = createResMock();

    middleware(createReqMock({ body: { lang: 'en' } }), res, vi.fn());

    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('42');
    expect(res.payload).toEqual({
      error: 'rate_limited',
      message: 'Too many requests, please retry in about 42s',
      retryAfter: 42,
    });
  });

  it('localizes to zh via body.lang', () => {
    const middleware = createLlmRateLimitMiddleware({
      limiter: createFixedLimiter({ ok: false, retryAfterSec: 7 }),
      resolveClientIp: () => '1.2.3.4',
    });
    const res = createResMock();

    middleware(createReqMock({ body: { lang: 'zh' } }), res, vi.fn());

    expect(res.statusCode).toBe(429);
    expect(res.payload).toEqual({
      error: 'rate_limited',
      message: '请求过于频繁，请约 7 秒后再试',
      retryAfter: 7,
    });
  });

  it('falls back to query.lang (zh) when the body has no lang', () => {
    const middleware = createLlmRateLimitMiddleware({
      limiter: createFixedLimiter({ ok: false, retryAfterSec: 3 }),
      resolveClientIp: () => '1.2.3.4',
    });
    const res = createResMock();

    middleware(createReqMock({ query: { lang: 'zh' } }), res, vi.fn());

    expect(res.payload).toEqual({
      error: 'rate_limited',
      message: '请求过于频繁，请约 3 秒后再试',
      retryAfter: 3,
    });
    // Unknown languages normalize to English.
    const resEn = createResMock();
    middleware(createReqMock({ query: { lang: 'fr' } }), resEn, vi.fn());
    expect(resEn.payload?.message).toContain('Too many requests');
  });

  it('answers SSE-accepting requests with plain JSON 429 before any SSE headers', () => {
    const middleware = createLlmRateLimitMiddleware({
      limiter: createFixedLimiter({ ok: false, retryAfterSec: 5 }),
      resolveClientIp: () => '1.2.3.4',
    });
    const res = createResMock();

    middleware(createReqMock({ accept: 'text/event-stream', body: {} }), res, vi.fn());

    // Runs before the route handler, so only Retry-After is set — the handler
    // never gets to write text/event-stream + SSE frames.
    expect(res.statusCode).toBe(429);
    expect(res.headers).toEqual({ 'Retry-After': '5' });
    expect(res.payload).toEqual({
      error: 'rate_limited',
      message: 'Too many requests, please retry in about 5s',
      retryAfter: 5,
    });
  });

  it('works end-to-end with a real sliding-window limiter (limit 2)', () => {
    let now = 0;
    const limiter = createSlidingWindowLimiter({ limit: 2, globalLimit: 100, windowMs: 60_000, now: () => now });
    const middleware = createLlmRateLimitMiddleware({ limiter, resolveClientIp: () => '5.6.7.8', name: 'review' });

    const next = vi.fn();
    middleware(createReqMock(), createResMock(), next);
    now = 1000;
    middleware(createReqMock(), createResMock(), next);
    expect(next).toHaveBeenCalledTimes(2);

    now = 2000;
    const blocked = createResMock();
    middleware(createReqMock(), blocked, next);
    expect(next).toHaveBeenCalledTimes(2); // third call still limited
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['Retry-After']).toBe('58'); // oldest hit t=0 → 60s-2s, ceil
  });
});

describe('createLlmRateLimitMiddleware log sampling (Codex P2)', () => {
  it('logs at most one aggregated line per interval per group', () => {
    let now = 0;
    const log = vi.fn();
    const mw = createLlmRateLimitMiddleware({
      limiter: createFixedLimiter({ ok: false, retryAfterSec: 5 }),
      resolveClientIp: () => '203.0.113.9',
      name: 'chat',
      now: () => now,
      log,
    });
    for (let i = 0; i < 50; i += 1) mw(createReqMock() as never, createResMock() as never, vi.fn());
    expect(log).toHaveBeenCalledTimes(1);
    now = 61_000;
    mw(createReqMock() as never, createResMock() as never, vi.fn());
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[1][0])).toContain('50 rejection(s)');
    expect(String(log.mock.calls[1][0])).not.toContain('203.0.113.9');
  });
});
