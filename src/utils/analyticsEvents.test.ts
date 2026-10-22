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
      expect(validateAnalyticsEvent({ event, props, anonId: 'anon_123e4567-e89b-42d3-a456-426614174000' })).toEqual({
        ok: true, event, props: expected, anonId: 'anon_123e4567-e89b-42d3-a456-426614174000',
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
  it('keeps generated-format anon ids', () => {
    expect(normalizeAnalyticsAnonId('anon_123e4567-e89b-42d3-a456-426614174000')).toBe('anon_123e4567-e89b-42d3-a456-426614174000');
    expect(normalizeAnalyticsAnonId('  anon_lq2x9k1.abcd1234  ')).toBe('anon_lq2x9k1.abcd1234');
  });

  it('rejects identifier-shaped PII that is not the generated format', () => {
    expect(normalizeAnalyticsAnonId('13800138000')).toBeNull();
    expect(normalizeAnalyticsAnonId('192.168.1.10')).toBeNull();
    expect(normalizeAnalyticsAnonId('abc_123.DEF:xyz')).toBeNull();
    expect(normalizeAnalyticsAnonId('anon_alice')).toBeNull();
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

describe('v2 analytics props', () => {
  it('preserves the complete review metadata and existing match ID', () => {
    const props = { matchId: '9035042364', ui: 'v2', state: 'parsed', surface: 'web', lang: 'en', phrasing: 'template' };
    expect(sanitizeAnalyticsProps(props, 'review_viewed')).toEqual(props);
    for (const surface of ['web', 'api', 'cli', 'mcp', 'discord']) expect(sanitizeAnalyticsProps({ surface }, 'review_viewed')).toEqual({ surface });
    for (const state of ['parsed', 'unparsed', 'insufficient', 'needs_hero']) expect(sanitizeAnalyticsProps({ state }, 'review_viewed')).toEqual({ state });
    expect(sanitizeAnalyticsProps({ ui: 'v1', lang: 'zh', phrasing: 'llm' }, 'review_viewed')).toEqual({ ui: 'v1', lang: 'zh', phrasing: 'llm' });
    expect(sanitizeAnalyticsProps({ ui: 'v3', state: 'bad', surface: 'email', lang: 'fr', phrasing: 'guess' }, 'review_viewed')).toEqual({});
  });
  it('accepts followup identifiers and booleans, never free text', () => {
    for (const followup_id of ['death_list', 'free']) for (const answerable of [true, false]) {
      const props = { kind: 'custom', followup_id, answerable };
      expect(sanitizeAnalyticsProps(props, 'followup_clicked')).toEqual(props);
    }
    expect(sanitizeAnalyticsProps({ followup_id: 'hello@example.com', answerable: 'true' }, 'followup_clicked')).toEqual({});
  });
  it('accepts both fake-door kinds and actions', () => {
    for (const kind of ['steam_autoreview', 'fakedoor_steam_autoreview']) for (const action of ['notify', 'dismiss']) {
      expect(sanitizeAnalyticsProps({ kind, action }, 'fakedoor_clicked')).toEqual({ kind, action });
    }
    expect(sanitizeAnalyticsProps({ kind: 'other', action: 'buy' }, 'fakedoor_clicked')).toEqual({});
  });
  it('accepts nonnegative integer days only', () => {
    for (const days_since_first of [0, 1, 365]) expect(sanitizeAnalyticsProps({ days_since_first }, 'return_visit')).toEqual({ days_since_first });
    for (const days_since_first of [-1, 1.5, Infinity, NaN, '1', true]) expect(sanitizeAnalyticsProps({ days_since_first }, 'return_visit')).toEqual({});
  });
});
