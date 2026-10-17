import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { normalizeUiLang } from '../../lib/aiLanguage.js';
import { validateChatRequest, chatRequestErrorMessage } from '../../lib/chatRequest.js';
import { sanitizeLlmErrorForClient } from '../../lib/llmErrors.js';
import { resolveClientIp as resolveClientIpFromParts } from '../../lib/clientIp.js';
import { createLlmRateLimit } from '../../lib/llmRateLimit.js';
import { createSlidingWindowLimiter } from '../../lib/rateLimiter.js';
import {
  validateReviewFollowUp,
} from '../../lib/matchReview/reviewRequestGuard.js';

// The repo has no @types/express; type just the surface the harness touches.
type ExpressApp = {
  use: (middleware: unknown) => void;
  post: (path: string, handler: unknown) => void;
  listen: (port: number, host: string) => Server;
};

interface HarnessReq {
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  socket?: { remoteAddress?: string };
}

interface HarnessRes {
  headersSent?: boolean;
  statusCode?: number;
  body?: unknown;
  setHeader(key: string, value: string): HarnessRes;
  status(code: number): HarnessRes;
  json(payload: unknown): HarnessRes;
}

// Client identity resolved exactly like server.js does: private TCP peer
// (127.0.0.1 in tests) → trusted-proxy XFF selection. Tests steer the client
// with the XFF header the way GFE appends the real client in production.
function resolveClientIp(req: unknown) {
  const r = req as HarnessReq;
  return resolveClientIpFromParts({
    peerAddress: r.socket?.remoteAddress,
    forwardedFor: r.headers?.['x-forwarded-for'] as string | undefined,
    trustedProxyHops: 1,
  });
}

/**
 * POST /api/chat wired the way server.js wires it (express.json, then the
 * handler: validate → acquire → LLM), with the LLM mocked. `options` override
 * the per-IP / global budgets.
 */
function createChatHarness(options: { perIp?: number; global?: number } = {}) {
  const llmCreate = vi.fn(async (_body: unknown) => ({ choices: [{ message: { content: 'shopkeeper says hi' } }] }));
  const openai = { chat: { completions: { create: llmCreate } } };
  const warn = vi.fn();
  const chatLlmLimit = createLlmRateLimit({
    limiter: createSlidingWindowLimiter({
      limit: options.perIp ?? 10,
      globalLimit: options.global ?? 600,
      windowMs: 60_000,
    }),
    resolveClientIp,
    name: 'chat',
    warn,
  });

  const express = createRequire(import.meta.url)('express') as
    (() => ExpressApp) & { json: () => unknown };
  const app = express();
  app.use(express.json());
  app.post('/api/chat', async (req: HarnessReq, res: HarnessRes) => {
    try {
      const validated = validateChatRequest(req.body);
      if (!validated.ok) {
        const lang = normalizeUiLang((req.body as { lang?: unknown } | undefined)?.lang);
        return res.status(validated.status).json({
          error: validated.error,
          message: chatRequestErrorMessage(validated.error, lang),
        });
      }
      const { message, history, lang } = validated;

      const llmGate = chatLlmLimit.acquire(req);
      if (!llmGate.ok) {
        if (llmGate.reason === 'cost_guard') {
          return res.status(502).json(sanitizeLlmErrorForClient(lang));
        }
        return chatLlmLimit.respondRateLimited(req, res as never, llmGate.retryAfterSec);
      }

      const response = await openai.chat.completions.create({
        messages: [{ role: 'user', content: message }, ...(history ?? [])],
      });
      return res.json({ text: response.choices[0].message.content });
    } catch {
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  return { app, llmCreate, warn };
}

/**
 * POST /api/review/:matchId validation head wired the way handleMatchReview
 * validates (matchId → trimmed followUp cap) with a marker for "reached the
 * LLM-bound section".
 */
function createReviewValidationHarness() {
  const reachedLlmSection = vi.fn();
  const express = createRequire(import.meta.url)('express') as
    (() => ExpressApp) & { json: () => unknown };
  const app = express();
  app.use(express.json());
  app.post('/api/review/:matchId', (req: HarnessReq, res: HarnessRes) => {
    const lang = normalizeUiLang((req.body as { lang?: unknown } | undefined)?.lang ?? req.query?.lang ?? 'en');
    const isZh = lang === 'zh';
    const followUp = typeof (req.body as { followUp?: unknown } | undefined)?.followUp === 'string'
      ? (req.body as { followUp: string }).followUp.trim()
      : '';
    const matchId = Number(req.params?.matchId);

    if (!Number.isFinite(matchId) || matchId <= 0) {
      return res.status(400).json({ error: isZh ? '无效的比赛 ID' : 'Invalid match ID' });
    }

    const followUpGuard = validateReviewFollowUp(followUp);
    if (!followUpGuard.ok) {
      return res.status(followUpGuard.status).json({
        error: followUpGuard.error,
        message: chatRequestErrorMessage(followUpGuard.error, lang),
      });
    }

    reachedLlmSection();
    return res.json({ ok: true });
  });

  return { app, reachedLlmSection };
}

describe('LLM rate limit wiring at HTTP level (QA P1 repro)', () => {
  let server: Server | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    const harness = createChatHarness();
    server = harness.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
    const addr = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    server?.closeAllConnections?.();
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    server = null;
  });

  const post = (path: string, peer: string, body: unknown) => fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': peer },
    body: JSON.stringify(body ?? {}),
  });

  it('310 invalid requests from 310 addresses in one /64 do not lock out anyone', async () => {
    // The QA attack: '{}' bodies (400) from 310 rotating IPv6 addresses inside
    // one /64 used to exhaust the global cap and 429 every later user.
    for (let i = 1; i <= 310; i += 1) {
      const res = await post('/api/chat', `2001:db8:1:2::${i.toString(16)}`, {});
      expect(res.status).toBe(400);
      const body = await res.json() as { error?: string };
      expect(body.error).toBe('invalid_message');
    }

    // An innocent IPv4 user is NOT 429'd and reaches the (mocked) LLM.
    const res = await post('/api/chat', '203.0.113.7', { message: 'hello shopkeeper' });
    expect(res.status).toBe(200);
    const body = await res.json() as { text?: string };
    expect(body.text).toBe('shopkeeper says hi');
  });

  it('400s never consume quota: 50 invalid then one valid from the same IP', async () => {
    for (let i = 0; i < 50; i += 1) {
      const res = await post('/api/chat', '203.0.113.50', {});
      expect(res.status).toBe(400);
    }
    const res = await post('/api/chat', '203.0.113.50', { message: 'still here' });
    expect(res.status).toBe(200);
  });
});

describe('LLM per-IP limit keys IPv6 by /64 at HTTP level', () => {
  let server: Server | null = null;
  let baseUrl = '';
  let llmCreate: ReturnType<typeof createChatHarness>['llmCreate'];

  beforeEach(async () => {
    const harness = createChatHarness({ perIp: 3 });
    llmCreate = harness.llmCreate;
    server = harness.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
    const addr = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    server?.closeAllConnections?.();
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    server = null;
  });

  const post = (peer: string, body: unknown) => fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': peer },
    body: JSON.stringify(body),
  });

  it('429s the (limit+1)-th valid request from the same /64, other blocks unaffected', async () => {
    for (let i = 1; i <= 3; i += 1) {
      const res = await post(`2001:db8:9:a::${i.toString(16)}`, { message: `q${i}` });
      expect(res.status).toBe(200);
    }
    expect(llmCreate).toHaveBeenCalledTimes(3);

    // Fourth address in the SAME /64 shares the bucket → 429, LLM not called.
    const blocked = await post('2001:db8:9:a:ffff::1', { message: 'over limit' });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    const payload = await blocked.json() as { error?: string; message?: string; retryAfter?: number };
    expect(payload.error).toBe('rate_limited');
    expect(typeof payload.retryAfter).toBe('number');
    expect(llmCreate).toHaveBeenCalledTimes(3);

    // A different /64 and an IPv4 client are unaffected.
    expect((await post('2001:db8:9:b::1', { message: 'next block' })).status).toBe(200);
    expect((await post('203.0.113.7', { message: 'v4 fine' })).status).toBe(200);
    expect(llmCreate).toHaveBeenCalledTimes(5);
  });
});

describe('LLM global cost guard degrades to fallback at HTTP level (QA P1)', () => {
  let server: Server | null = null;
  let baseUrl = '';
  let llmCreate: ReturnType<typeof createChatHarness>['llmCreate'];
  let warn: ReturnType<typeof createChatHarness>['warn'];

  beforeEach(async () => {
    const harness = createChatHarness({ perIp: 10, global: 2 });
    llmCreate = harness.llmCreate;
    warn = harness.warn;
    server = harness.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
    const addr = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    server?.closeAllConnections?.();
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    server = null;
  });

  const post = (peer: string, body: unknown) => fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': peer },
    body: JSON.stringify(body),
  });

  it('serves the fallback response instead of 429 and skips the LLM call', async () => {
    expect((await post('203.0.113.1', { message: 'one' })).status).toBe(200);
    expect((await post('203.0.113.2', { message: 'two' })).status).toBe(200);
    expect(llmCreate).toHaveBeenCalledTimes(2);

    // Global guard tripped: a fresh, under-limit client still gets served —
    // the ai_unavailable fallback, never a 429 — and no LLM call happens.
    const tripped = await post('203.0.113.3', { message: 'three' });
    expect(tripped.status).toBe(502);
    const payload = await tripped.json() as { error?: string; message?: string };
    expect(payload.error).toBe('ai_unavailable');
    expect(llmCreate).toHaveBeenCalledTimes(2);

    // One aggregated WARNING per 60s (three trips → one line).
    const trippedAgain = await post('203.0.113.4', { message: 'four' });
    expect(trippedAgain.status).not.toBe(429);
    expect(warn).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(String(warn.mock.calls[0][0])) as { event?: string };
    expect(entry.event).toBe('llm_cost_guard_tripped');
  });
});

describe('review follow-up length cap at HTTP level (QA P2)', () => {
  let server: Server | null = null;
  let baseUrl = '';
  let reachedLlmSection: ReturnType<typeof createReviewValidationHarness>['reachedLlmSection'];

  beforeEach(async () => {
    const harness = createReviewValidationHarness();
    reachedLlmSection = harness.reachedLlmSection;
    server = harness.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
    const addr = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    server?.closeAllConnections?.();
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    server = null;
  });

  const post = (body: unknown) => fetch(`${baseUrl}/api/review/9035042364`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('rejects followUp > 2000 chars with 400 message_too_long (localized like chat)', async () => {
    const res = await post({ followUp: '为'.repeat(2001), lang: 'zh' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string; message?: string };
    expect(body.error).toBe('message_too_long');
    expect(body.message).toContain('2000');

    const resEn = await post({ followUp: 'x'.repeat(2001), lang: 'en' });
    const bodyEn = await resEn.json() as { message?: string };
    expect(bodyEn.message).toContain('2000 characters');
    expect(reachedLlmSection).not.toHaveBeenCalled();
  });

  it('accepts a 2000-char followUp (cap is inclusive) and card requests', async () => {
    expect((await post({ followUp: 'x'.repeat(2000) })).status).toBe(200);
    expect((await post({})).status).toBe(200);
    expect(reachedLlmSection).toHaveBeenCalledTimes(2);
  });
});
