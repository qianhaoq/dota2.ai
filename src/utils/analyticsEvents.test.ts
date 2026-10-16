import { describe, it, expect } from 'vitest';
import {
  ANALYTICS_EVENTS,
  ANALYTICS_MAX_PROPS,
  validateAnalyticsEvent,
  sanitizeAnalyticsProps,
  normalizeAnalyticsAnonId,
  createAnalyticsRateLimiter,
} from '../../lib/analyticsEvents.js';

describe('validateAnalyticsEvent', () => {
  it('accepts every whitelisted event with props and anonId', () => {
    for (const event of ANALYTICS_EVENTS) {
      expect(validateAnalyticsEvent({
        event,
        props: { preset: 'why_this_item', custom: true, position: 2 },
        anonId: 'anon-42',
      })).toEqual({
        ok: true,
        event,
        props: { preset: 'why_this_item', custom: true, position: 2 },
        anonId: 'anon-42',
      });
    }
  });

  it('accepts a bare event without props or anonId', () => {
    expect(validateAnalyticsEvent({ event: 'review_viewed' })).toEqual({
      ok: true,
      event: 'review_viewed',
      props: {},
      anonId: null,
    });
  });

  it('rejects non-object bodies and unknown or missing events', () => {
    expect(validateAnalyticsEvent(null)).toEqual({ ok: false, error: 'invalid_body' });
    expect(validateAnalyticsEvent('review_viewed' as never)).toEqual({ ok: false, error: 'invalid_body' });
    expect(validateAnalyticsEvent([1, 2] as never)).toEqual({ ok: false, error: 'invalid_body' });
    expect(validateAnalyticsEvent({})).toEqual({ ok: false, error: 'invalid_event' });
    expect(validateAnalyticsEvent({ event: 'page_viewed' })).toEqual({ ok: false, error: 'invalid_event' });
    expect(validateAnalyticsEvent({ event: ' review_viewed ' }).ok).toBe(true);
  });

  it('defaults props to {} for non-object props', () => {
    const result = validateAnalyticsEvent({ event: 'return_visit', props: 'nope' as never });
    expect(result).toEqual({ ok: true, event: 'return_visit', props: {}, anonId: null });
  });
});

describe('sanitizeAnalyticsProps — PII and free-text stripping', () => {
  it('keeps identifier strings, booleans and finite numbers only', () => {
    expect(sanitizeAnalyticsProps({
      preset: 'why_build_this_item',
      custom: false,
      count: 3,
      ratio: -1.5,
      junkObject: { a: 1 },
      junkArray: [1],
      junkNull: null,
      freeText: 'Why did we lose that fight at 29:00?',
      chineseText: '辅助这段该怎么站',
      email: 'user@example.com',
      nan: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
      huge: 1e12,
    })).toEqual({
      preset: 'why_build_this_item',
      custom: false,
      count: 3,
      ratio: -1.5,
    });
  });

  it('caps the number of kept keys', () => {
    const props: Record<string, number> = {};
    for (let i = 0; i < ANALYTICS_MAX_PROPS + 5; i += 1) props[`k${i}`] = i;
    const sanitized = sanitizeAnalyticsProps(props);
    expect(Object.keys(sanitized)).toHaveLength(ANALYTICS_MAX_PROPS);
    // The first keys in insertion order survive.
    expect(sanitized.k0).toBe(0);
    expect(sanitized[`k${ANALYTICS_MAX_PROPS - 1}`]).toBe(ANALYTICS_MAX_PROPS - 1);
  });

  it('returns {} for non-object props', () => {
    expect(sanitizeAnalyticsProps(null)).toEqual({});
    expect(sanitizeAnalyticsProps(undefined)).toEqual({});
    expect(sanitizeAnalyticsProps('preset' as never)).toEqual({});
    expect(sanitizeAnalyticsProps([] as never)).toEqual({});
  });
});

describe('normalizeAnalyticsAnonId', () => {
  it('keeps short identifier-like ids', () => {
    expect(normalizeAnalyticsAnonId('anon-42')).toBe('anon-42');
    expect(normalizeAnalyticsAnonId('  abc_123.DEF:xyz  ')).toBe('abc_123.DEF:xyz');
  });

  it('nulls out non-identifiers (PII, free text, oversized, non-strings)', () => {
    expect(normalizeAnalyticsAnonId('user@example.com')).toBeNull();
    expect(normalizeAnalyticsAnonId('some visitor id')).toBeNull();
    expect(normalizeAnalyticsAnonId('访客')).toBeNull();
    expect(normalizeAnalyticsAnonId('a'.repeat(65))).toBeNull();
    expect(normalizeAnalyticsAnonId('')).toBeNull();
    expect(normalizeAnalyticsAnonId(123 as never)).toBeNull();
    expect(normalizeAnalyticsAnonId(null)).toBeNull();
  });
});

describe('createAnalyticsRateLimiter', () => {
  const windowMs = 60 * 60 * 1000;

  it('allows up to the per-client limit and blocks after it', () => {
    let now = 0;
    const limiter = createAnalyticsRateLimiter({ limit: 3, globalLimit: 100, windowMs, now: () => now });
    expect(limiter.tryConsume('1.1.1.1', now)).toBe(true);
    now = 1000;
    expect(limiter.tryConsume('1.1.1.1', now)).toBe(true);
    now = 2000;
    expect(limiter.tryConsume('1.1.1.1', now)).toBe(true);
    now = 3000;
    expect(limiter.tryConsume('1.1.1.1', now)).toBe(false);
    // Rejected attempts do not consume budget.
    expect(limiter.tryConsume('1.1.1.1', now)).toBe(false);
    // Another client is unaffected.
    expect(limiter.tryConsume('2.2.2.2', now)).toBe(true);
  });

  it('recovers after the window slides past', () => {
    let now = 0;
    const limiter = createAnalyticsRateLimiter({ limit: 1, globalLimit: 100, windowMs, now: () => now });
    expect(limiter.tryConsume('1.1.1.1', now)).toBe(true);
    expect(limiter.tryConsume('1.1.1.1', windowMs - 1)).toBe(false);
    expect(limiter.tryConsume('1.1.1.1', windowMs + 1)).toBe(true);
  });

  it('enforces the global limit across all clients', () => {
    let now = 0;
    const limiter = createAnalyticsRateLimiter({ limit: 100, globalLimit: 2, windowMs, now: () => now });
    expect(limiter.tryConsume('1.1.1.1', now)).toBe(true);
    expect(limiter.tryConsume('2.2.2.2', now)).toBe(true);
    expect(limiter.tryConsume('3.3.3.3', now)).toBe(false);
  });
});
