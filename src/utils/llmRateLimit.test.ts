import { describe, it, expect, vi } from 'vitest';
import { createLlmRateLimit, RATE_LIMIT_LOG_INTERVAL_MS } from '../../lib/llmRateLimit.js';
import { createSlidingWindowLimiter } from '../../lib/rateLimiter.js';

/** Minimal Express-style req/res mocks — pure guard logic, no server needed. */
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

function createReqMock({ body, query, accept }: {
  body?: Record<string, unknown>; query?: Record<string, unknown>; accept?: string;
} = {}): ReqMock {
  return {
    method: 'POST',
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

function createFixedLimiter(result: { ok: boolean; retryAfterSec: number; reason?: 'global' | 'client' }) {
  return { tryConsume: vi.fn(() => result) };
}

/** Narrows a blocked gate so its reason/retryAfterSec are accessible. */
function expectBlocked(gate: { ok: true } | { ok: false; reason: string; retryAfterSec: number }) {
  if (gate.ok) throw new Error('expected the gate to block this request');
  return gate;
}

describe('createLlmRateLimit.acquire — allowed requests', () => {
  it('consumes one budget unit via rateLimitKey(resolveClientIp(req))', () => {
    const limiter = createFixedLimiter({ ok: true, retryAfterSec: 0 });
    const resolveClientIp = vi.fn(() => '9.9.9.9');
    const limit = createLlmRateLimit({ limiter, resolveClientIp, name: 'chat' });

    const gate = limit.acquire(createReqMock({ body: { message: 'hi' } }));

    expect(gate).toEqual({ ok: true });
    expect(resolveClientIp).toHaveBeenCalledTimes(1);
    expect(limiter.tryConsume).toHaveBeenCalledWith('9.9.9.9');
  });

  it('groups IPv6 addresses into their /64 key by default', () => {
    const limiter = createFixedLimiter({ ok: true, retryAfterSec: 0 });
    const limit = createLlmRateLimit({ limiter, resolveClientIp: () => '2001:db8:1:2::5', name: 'chat' });
    limit.acquire(createReqMock());
    expect(limiter.tryConsume).toHaveBeenCalledWith('2001:db8:1:2::/64');

    const limitMapped = createLlmRateLimit({ limiter, resolveClientIp: () => '::ffff:203.0.113.7', name: 'chat' });
    limitMapped.acquire(createReqMock());
    expect(limiter.tryConsume).toHaveBeenCalledWith('203.0.113.7');
  });

  it('shares one bucket for every address inside a /64 (end-to-end)', () => {
    let now = 0;
    const limiter = createSlidingWindowLimiter({ limit: 2, globalLimit: 100, windowMs: 60_000, now: () => now });
    const limit = createLlmRateLimit({
      limiter,
      resolveClientIp: (req: unknown) => String((req as { headers?: Record<string, unknown> }).headers?.['x-test-peer'] || ''),
      name: 'chat',
    });
    const req = (peer: string) => ({ ...createReqMock(), headers: { 'x-test-peer': peer } });

    expect(limit.acquire(req('2001:db8:1:2::1')).ok).toBe(true);
    now = 1000;
    expect(limit.acquire(req('2001:db8:1:2:ffff::99')).ok).toBe(true);
    now = 2000;
    // Third address in the same /64: same bucket, already at its limit.
    expect(limit.acquire(req('2001:db8:1:2::dead:beef'))).toEqual({
      ok: false,
      reason: 'rate_limited',
      retryAfterSec: 58,
    });
    // A different /64 is unaffected.
    expect(limit.acquire(req('2001:db8:1:3::1')).ok).toBe(true);
  });
});

describe('createLlmRateLimit — per-IP 429 responses', () => {
  it('respondRateLimited writes 429 with Retry-After header and localized JSON (en default)', () => {
    const limit = createLlmRateLimit({
      limiter: createFixedLimiter({ ok: false, retryAfterSec: 42, reason: 'client' }),
      resolveClientIp: () => '1.2.3.4',
      name: 'chat',
    });
    const res = createResMock();

    const gate = limit.acquire(createReqMock({ body: { lang: 'en' } }));
    expect(gate).toEqual({ ok: false, reason: 'rate_limited', retryAfterSec: 42 });

    limit.respondRateLimited(createReqMock({ body: { lang: 'en' } }), res, 42);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('42');
    expect(res.payload).toEqual({
      error: 'rate_limited',
      message: 'Too many requests, please retry in about 42s',
      retryAfter: 42,
    });
  });

  it('localizes to zh via body.lang, falling back to query.lang', () => {
    const limit = createLlmRateLimit({
      limiter: createFixedLimiter({ ok: false, retryAfterSec: 7, reason: 'client' }),
      resolveClientIp: () => '1.2.3.4',
    });
    const res = createResMock();
    limit.respondRateLimited(createReqMock({ body: { lang: 'zh' } }), res, 7);
    expect(res.payload).toEqual({
      error: 'rate_limited',
      message: '请求过于频繁，请约 7 秒后再试',
      retryAfter: 7,
    });

    const resQuery = createResMock();
    limit.respondRateLimited(createReqMock({ query: { lang: 'zh' } }), resQuery, 3);
    expect(resQuery.payload?.message).toContain('请求过于频繁');
    // Unknown languages normalize to English.
    const resEn = createResMock();
    limit.respondRateLimited(createReqMock({ query: { lang: 'fr' } }), resEn, 3);
    expect(resEn.payload?.message).toContain('Too many requests');
  });

  it('answers SSE-accepting requests with plain JSON 429 before any SSE headers', () => {
    const limit = createLlmRateLimit({
      limiter: createFixedLimiter({ ok: false, retryAfterSec: 5, reason: 'client' }),
      resolveClientIp: () => '1.2.3.4',
    });
    const res = createResMock();

    const gate = limit.acquire(createReqMock({ accept: 'text/event-stream', body: {} }));
    expect(gate.ok).toBe(false);
    limit.respondRateLimited(createReqMock({ accept: 'text/event-stream', body: {} }), res, 5);

    // Only Retry-After is set — acquire/respond run before the route handler
    // could write text/event-stream + SSE frames.
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
    const limit = createLlmRateLimit({ limiter, resolveClientIp: () => '5.6.7.8', name: 'review' });

    expect(limit.acquire(createReqMock()).ok).toBe(true);
    now = 1000;
    expect(limit.acquire(createReqMock()).ok).toBe(true);
    now = 2000;
    const blocked = createResMock();
    const gate = expectBlocked(limit.acquire(createReqMock()));
    expect(gate).toEqual({ ok: false, reason: 'rate_limited', retryAfterSec: 58 });
    limit.respondRateLimited(createReqMock(), blocked, gate.retryAfterSec);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['Retry-After']).toBe('58'); // oldest hit t=0 → 60s-2s, ceil
  });
});

describe('createLlmRateLimit — global cost guard (QA P1)', () => {
  it('turns a global rejection into a cost_guard result (never a 429)', () => {
    const limiter = createFixedLimiter({ ok: false, retryAfterSec: 12, reason: 'global' });
    const limit = createLlmRateLimit({ limiter, resolveClientIp: () => '203.0.113.7', name: 'chat' });

    expect(limit.acquire(createReqMock())).toEqual({
      ok: false,
      reason: 'cost_guard',
      retryAfterSec: 12,
    });
  });

  it('prefers cost_guard when both the global and per-IP buckets are full', () => {
    let now = 0;
    const limiter = createSlidingWindowLimiter({ limit: 1, globalLimit: 1, windowMs: 60_000, now: () => now });
    const limit = createLlmRateLimit({ limiter, resolveClientIp: () => '203.0.113.7', name: 'chat' });
    expect(limit.acquire(createReqMock()).ok).toBe(true);
    now = 1000;
    expect(expectBlocked(limit.acquire(createReqMock())).reason).toBe('cost_guard');
  });

  it('logs one aggregated llm_cost_guard_tripped WARNING per 60s per group', () => {
    let now = 0;
    const log = vi.fn();
    const warn = vi.fn();
    const limiter = createFixedLimiter({ ok: false, retryAfterSec: 30, reason: 'global' });
    const limit = createLlmRateLimit({
      limiter,
      resolveClientIp: () => '198.51.100.1',
      name: 'chat',
      now: () => now,
      log,
      warn,
    });

    for (let i = 0; i < 25; i += 1) limit.acquire(createReqMock() as never);
    expect(warn).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(String(warn.mock.calls[0][0]));
    expect(entry).toMatchObject({ severity: 'WARNING', event: 'llm_cost_guard_tripped', group: 'chat', retryAfterSec: 30, trips: 1 });
    // No client IP in the log.
    expect(String(warn.mock.calls[0][0])).not.toContain('198.51.100.1');

    now = RATE_LIMIT_LOG_INTERVAL_MS + 1;
    limit.acquire(createReqMock() as never);
    expect(warn).toHaveBeenCalledTimes(2);
    const second = JSON.parse(String(warn.mock.calls[1][0]));
    expect(second.trips).toBe(25); // 24 suppressed + the one that fired the log
  });

  it('guard-tripped requests consume no per-IP quota (window expiry proves it)', () => {
    let now = 0;
    const limiter = createSlidingWindowLimiter({ limit: 1, globalLimit: 1, windowMs: 60_000, now: () => now });
    const limit = createLlmRateLimit({ limiter, resolveClientIp: () => '198.51.100.9', name: 'review' });

    expect(limit.acquire(createReqMock()).ok).toBe(true); // global budget spent
    // Different client: guard tripped, and its own bucket must stay untouched.
    const other = createLlmRateLimit({ limiter, resolveClientIp: () => '198.51.100.10', name: 'review' });
    now = 1000;
    expect(expectBlocked(other.acquire(createReqMock())).reason).toBe('cost_guard');

    now = 60_001; // the t=0 global hit expired; had the trip counted per-IP at
    // t=1000, this client would still be inside its own 60s window → 429.
    expect(other.acquire(createReqMock()).ok).toBe(true);
  });
});

describe('createLlmRateLimit rejection log sampling (Codex P2)', () => {
  it('logs at most one aggregated line per interval per group', () => {
    let now = 0;
    const log = vi.fn();
    const limit = createLlmRateLimit({
      limiter: createFixedLimiter({ ok: false, retryAfterSec: 5, reason: 'client' }),
      resolveClientIp: () => '203.0.113.9',
      name: 'chat',
      now: () => now,
      log,
    });
    for (let i = 0; i < 50; i += 1) limit.acquire(createReqMock() as never);
    expect(log).toHaveBeenCalledTimes(1);
    now = 61_000;
    limit.acquire(createReqMock() as never);
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[1][0])).toContain('50 rejection(s)');
    expect(String(log.mock.calls[1][0])).not.toContain('203.0.113.9');
  });
});
