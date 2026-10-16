import { describe, it, expect } from 'vitest';
import {
  ANALYTICS_EVENTS,
  validateAnalyticsEvent,
  sanitizeAnalyticsProps,
  normalizeAnalyticsAnonId,
  createAnalyticsRateLimiter,
} from '../../lib/analyticsEvents.js';

describe('validateAnalyticsEvent', () => {
  it('accepts every whitelisted event and keeps only allowlisted props', () => {
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['review_viewed', { matchId: '8985182860', extra: 'x' }, { matchId: '8985182860' }],
      ['followup_clicked', { kind: 'preset', position: 2 }, { kind: 'preset' }],
      ['fakedoor_clicked', { kind: 'steam_autoreview' }, { kind: 'steam_autoreview' }],
      ['return_visit', { kind: 'preset' }, {}],
    ];
    expect(cases.map((c) => c[0]).sort()).toEqual([...ANALYTICS_EVENTS].sort());
    for (const [event, props, expected] of cases) {
      expect(validateAnalyticsEvent({ event, props, anonId: 'anon-42' })).toEqual({
        ok: true, event, props: expected, anonId: 'anon-42',
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
  it('drops unknown keys (incl. PII key names) and non-allowlisted values', () => {
    expect(sanitizeAnalyticsProps({ 'alice@example.com': true, kind: 'preset' }, 'followup_clicked')).toEqual({ kind: 'preset' });
    expect(sanitizeAnalyticsProps({ kind: 'Why did we lose?' }, 'followup_clicked')).toEqual({});
    expect(sanitizeAnalyticsProps({ matchId: 8985182860 }, 'review_viewed')).toEqual({});
    expect(sanitizeAnalyticsProps({ matchId: 'abc' }, 'review_viewed')).toEqual({});
    expect(sanitizeAnalyticsProps({ kind: 'preset' }, 'unknown_event')).toEqual({});
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
