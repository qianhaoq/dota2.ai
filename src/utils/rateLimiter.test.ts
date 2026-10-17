import { describe, it, expect } from 'vitest';
import { createSlidingWindowLimiter } from '../../lib/rateLimiter.js';
import { createAnalyticsRateLimiter } from '../../lib/analyticsEvents.js';

describe('createSlidingWindowLimiter — per-client window', () => {
  it('allows up to the per-client limit, blocks after, and rejected attempts consume no budget', () => {
    let now = 0;
    const limiter = createSlidingWindowLimiter({ limit: 2, globalLimit: 100, windowMs: 60_000, now: () => now });
    expect(limiter.tryConsume('1.1.1.1', now)).toEqual({ ok: true, retryAfterSec: 0 });
    now = 1000;
    expect(limiter.tryConsume('1.1.1.1', now)).toEqual({ ok: true, retryAfterSec: 0 });
    now = 2000;
    expect(limiter.tryConsume('1.1.1.1', now).ok).toBe(false);
    // Still blocked, still no budget consumed by rejections.
    expect(limiter.tryConsume('1.1.1.1', now).ok).toBe(false);
    // Other clients are unaffected.
    expect(limiter.tryConsume('2.2.2.2', now)).toEqual({ ok: true, retryAfterSec: 0 });
  });

  it('slides: entries expire as the window passes them', () => {
    let now = 0;
    const limiter = createSlidingWindowLimiter({ limit: 1, globalLimit: 100, windowMs: 60_000, now: () => now });
    expect(limiter.tryConsume('1.1.1.1', now).ok).toBe(true);
    expect(limiter.tryConsume('1.1.1.1', 59_999).ok).toBe(false);
    expect(limiter.tryConsume('1.1.1.1', 60_000).ok).toBe(true); // hit at t=0 expired
  });

  it('normalizes the client key (empty/oversized ids share the trimmed bucket)', () => {
    const limiter = createSlidingWindowLimiter({ limit: 1, globalLimit: 100, windowMs: 60_000, now: () => 0 });
    expect(limiter.tryConsume('', 0).ok).toBe(true);
    expect(limiter.tryConsume(undefined as never, 0).ok).toBe(false); // same 'unknown' bucket
    const long = 'a'.repeat(100);
    expect(limiter.tryConsume(long, 0).ok).toBe(true);
    expect(limiter.tryConsume(long.slice(0, 64), 0).ok).toBe(false); // truncated to same key
    expect(limiter.tryConsume('b'.repeat(100), 0).ok).toBe(true); // different first 64 chars
  });
});

describe('createSlidingWindowLimiter — retryAfterSec', () => {
  it('rounds the wait up to whole seconds (min 1s) from the oldest blocking hit', () => {
    let now = 0;
    const limiter = createSlidingWindowLimiter({ limit: 1, globalLimit: 100, windowMs: 60_000, now: () => now });
    expect(limiter.tryConsume('1.1.1.1', now).ok).toBe(true);
    // Oldest (only) hit at t=0 expires at 60_000. At t=500 → 59.5s left → ceil 60.
    now = 500;
    expect(limiter.tryConsume('1.1.1.1', now)).toEqual({ ok: false, retryAfterSec: 60, reason: 'client' });
    now = 1000;
    expect(limiter.tryConsume('1.1.1.1', now)).toEqual({ ok: false, retryAfterSec: 59, reason: 'client' });
    // Exactly on the boundary → the hit has not expired yet (59_999-style), wait ≥ 1s.
    now = 60_000 - 1;
    expect(limiter.tryConsume('1.1.1.1', now)).toEqual({ ok: false, retryAfterSec: 1, reason: 'client' });
  });

  it('reports from the oldest hit still inside the window, not the most recent', () => {
    let now = 0;
    const limiter = createSlidingWindowLimiter({ limit: 2, globalLimit: 100, windowMs: 60_000, now: () => now });
    expect(limiter.tryConsume('1.1.1.1', now).ok).toBe(true);
    now = 30_000;
    expect(limiter.tryConsume('1.1.1.1', now).ok).toBe(true);
    now = 30_500;
    // Oldest hit t=0 expires at 60_000 → 29.5s → 30s (not 30_000-based 30s of the newer hit... which would also be 30 — use distinct offsets below).
    expect(limiter.tryConsume('1.1.1.1', now)).toEqual({ ok: false, retryAfterSec: 30, reason: 'client' });
    now = 59_999;
    // Oldest hit still blocks for 1 more ms → 1s; the newer one for another 30s.
    expect(limiter.tryConsume('1.1.1.1', now)).toEqual({ ok: false, retryAfterSec: 1, reason: 'client' });
  });
});

describe('createSlidingWindowLimiter — global cap', () => {
  it('blocks across all clients once the global budget is spent', () => {
    let now = 0;
    const limiter = createSlidingWindowLimiter({ limit: 100, globalLimit: 2, windowMs: 60_000, now: () => now });
    expect(limiter.tryConsume('1.1.1.1', now)).toEqual({ ok: true, retryAfterSec: 0 });
    now = 10_000;
    expect(limiter.tryConsume('2.2.2.2', now)).toEqual({ ok: true, retryAfterSec: 0 });
    now = 20_000;
    // Global window is full; retry waits for the OLDEST global hit (t=0 → 40s left → 40s).
    expect(limiter.tryConsume('3.3.3.3', now)).toEqual({ ok: false, retryAfterSec: 40, reason: 'global' });
    now = 60_001;
    expect(limiter.tryConsume('3.3.3.3', now).ok).toBe(true); // both old hits expired
  });

  it('global rejections do not consume per-client budget', () => {
    let now = 0;
    const limiter = createSlidingWindowLimiter({ limit: 1, globalLimit: 1, windowMs: 60_000, now: () => now });
    expect(limiter.tryConsume('1.1.1.1', now).ok).toBe(true); // global budget spent by 1.1.1.1
    expect(limiter.tryConsume('2.2.2.2', 1000).ok).toBe(false); // blocked globally, not recorded
    now = 61_000;
    expect(limiter.tryConsume('2.2.2.2', now).ok).toBe(true); // fresh global + fresh client budget
  });
});

describe('createSlidingWindowLimiter — tracked-client cap', () => {
  it('evicts (expired first, then oldest) when maxTrackedClients is exceeded', () => {
    let now = 1000;
    const limiter = createSlidingWindowLimiter({
      limit: 1,
      globalLimit: 10_000,
      windowMs: 60_000,
      maxTrackedClients: 2,
      now: () => now,
    });
    expect(limiter.tryConsume('a', now).ok).toBe(true);
    now = 2000;
    expect(limiter.tryConsume('b', now).ok).toBe(true);
    now = 3000;
    expect(limiter.tryConsume('c', now).ok).toBe(true); // map full → oldest ('a') evicted
    // 'b' is still tracked and at its limit (check before re-adding 'a', which
    // would evict 'b' in turn).
    expect(limiter.tryConsume('b', now).ok).toBe(false);
    // 'a' was evicted → starts a fresh bucket and passes again.
    expect(limiter.tryConsume('a', now).ok).toBe(true);
  });
});

describe('createAnalyticsRateLimiter stays a boolean facade over the shared limiter', () => {
  it('returns booleans and keeps the analytics defaults', () => {
    let now = 0;
    const limiter = createAnalyticsRateLimiter({ limit: 1, globalLimit: 1, windowMs: 60_000, now: () => now });
    expect(limiter.tryConsume('1.1.1.1', now)).toBe(true);
    expect(limiter.tryConsume('1.1.1.1', now)).toBe(false);
    expect(limiter.tryConsume('2.2.2.2', now)).toBe(false); // global limit 1
  });
});

describe('createSlidingWindowLimiter retryAfter when both buckets are full (Codex P2)', () => {
  it('reports the longest applicable wait', () => {
    let now = 0;
    const limiter = createSlidingWindowLimiter({ limit: 1, globalLimit: 2, windowMs: 60_000, now: () => now });
    expect(limiter.tryConsume('other', now).ok).toBe(true); // global hit at t=0
    now = 30_000;
    expect(limiter.tryConsume('me', now).ok).toBe(true); // global full, my bucket full (hit at t=30s)
    now = 31_000;
    const r = limiter.tryConsume('me', now);
    expect(r.ok).toBe(false);
    // global frees at t=60s (29s), my bucket frees at t=90s (59s) -> 59
    expect(r.retryAfterSec).toBe(59);
  });
});

describe('createSlidingWindowLimiter rejection reason (QA P1 cost guard)', () => {
  it('labels client-only rejections as client', () => {
    const limiter = createSlidingWindowLimiter({ limit: 1, globalLimit: 100, windowMs: 60_000, now: () => 0 });
    expect(limiter.tryConsume('1.1.1.1', 0).ok).toBe(true);
    expect(limiter.tryConsume('1.1.1.1', 1).reason).toBe('client');
  });

  it('labels global-only rejections as global', () => {
    const limiter = createSlidingWindowLimiter({ limit: 100, globalLimit: 1, windowMs: 60_000, now: () => 0 });
    expect(limiter.tryConsume('1.1.1.1', 0).ok).toBe(true);
    expect(limiter.tryConsume('2.2.2.2', 1).reason).toBe('global');
  });

  it('prefers global when both buckets are full (cost guard degrades, never 429)', () => {
    let now = 0;
    const limiter = createSlidingWindowLimiter({ limit: 1, globalLimit: 1, windowMs: 60_000, now: () => now });
    expect(limiter.tryConsume('1.1.1.1', now).ok).toBe(true);
    now = 1000;
    expect(limiter.tryConsume('1.1.1.1', now).reason).toBe('global');
  });

  it('successful consumes stay shape-compatible (no reason field)', () => {
    const limiter = createSlidingWindowLimiter({ limit: 1, globalLimit: 1, windowMs: 60_000, now: () => 0 });
    expect(limiter.tryConsume('1.1.1.1', 0)).toEqual({ ok: true, retryAfterSec: 0 });
  });
});
