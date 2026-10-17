import { describe, expect, it } from 'vitest';
import {
  RETRY_AFTER_MAX_SEC,
  RETRY_AFTER_MIN_SEC,
  bodyRetryAfterSec,
  clampRetryAfterSec,
  parseRetryAfterHeader,
  retryAfterFrom,
} from './retryAfter';

const NOW = Date.parse('2026-10-17T12:00:00Z');

describe('parseRetryAfterHeader', () => {
  it('reads delay-seconds values', () => {
    expect(parseRetryAfterHeader('30', NOW)).toBe(30);
    expect(parseRetryAfterHeader('  30  ', NOW)).toBe(30);
    expect(parseRetryAfterHeader('0', NOW)).toBe(RETRY_AFTER_MIN_SEC);
    expect(parseRetryAfterHeader('1.4', NOW)).toBe(2);
  });

  it('reads HTTP-date values as seconds from now', () => {
    expect(parseRetryAfterHeader('Sat, 17 Oct 2026 12:00:30 GMT', NOW)).toBe(30);
    // Already in the past → clamped up to the minimum wait.
    expect(parseRetryAfterHeader('Fri, 16 Oct 2026 12:00:00 GMT', NOW)).toBe(RETRY_AFTER_MIN_SEC);
  });

  it('returns null for garbage and missing values', () => {
    expect(parseRetryAfterHeader('soon', NOW)).toBeNull();
    expect(parseRetryAfterHeader('-5', NOW)).toBeNull();
    expect(parseRetryAfterHeader('', NOW)).toBeNull();
    expect(parseRetryAfterHeader(null, NOW)).toBeNull();
    expect(parseRetryAfterHeader(undefined, NOW)).toBeNull();
  });

  it('clamps to 1..3600 seconds', () => {
    expect(parseRetryAfterHeader('9999999', NOW)).toBe(RETRY_AFTER_MAX_SEC);
    // HTTP-date a day out is still capped at one hour.
    expect(parseRetryAfterHeader('Sun, 18 Oct 2026 12:00:00 GMT', NOW)).toBe(RETRY_AFTER_MAX_SEC);
  });
});

describe('clampRetryAfterSec', () => {
  it('clamps and rounds to whole seconds', () => {
    expect(clampRetryAfterSec(0)).toBe(RETRY_AFTER_MIN_SEC);
    expect(clampRetryAfterSec(-100)).toBe(RETRY_AFTER_MIN_SEC);
    expect(clampRetryAfterSec(45.2)).toBe(46);
    expect(clampRetryAfterSec(3601)).toBe(RETRY_AFTER_MAX_SEC);
    expect(clampRetryAfterSec(Number.NaN)).toBe(RETRY_AFTER_MIN_SEC);
  });
});

describe('retryAfterFrom', () => {
  it('prefers the header over the body fallback', () => {
    expect(retryAfterFrom('30', 99, NOW)).toBe(30);
  });

  it('falls back to the body retryAfterSec when the header is absent or garbage', () => {
    expect(retryAfterFrom(null, 45, NOW)).toBe(45);
    expect(retryAfterFrom('garbage', 45, NOW)).toBe(45);
    expect(retryAfterFrom('', '120', NOW)).toBeNull();
  });

  it('falls back to the production body `retryAfter` field too', () => {
    expect(retryAfterFrom(null, bodyRetryAfterSec({ retryAfter: 60 }), NOW)).toBe(60);
    expect(retryAfterFrom(null, bodyRetryAfterSec({ retryAfterSec: 45, retryAfter: 60 }), NOW)).toBe(45);
    expect(retryAfterFrom(null, bodyRetryAfterSec({ retryAfter: 'soon' }), NOW)).toBeNull();
  });

  it('clamps the body value too', () => {
    expect(retryAfterFrom(null, 0, NOW)).toBe(RETRY_AFTER_MIN_SEC);
    expect(retryAfterFrom(null, 99999, NOW)).toBe(RETRY_AFTER_MAX_SEC);
  });

  it('returns null when nothing usable is present', () => {
    expect(retryAfterFrom(null, undefined, NOW)).toBeNull();
    expect(retryAfterFrom(undefined, 'soon', NOW)).toBeNull();
  });
});

describe('bodyRetryAfterSec', () => {
  it('prefers retryAfterSec, then the production retryAfter field', () => {
    expect(bodyRetryAfterSec({ retryAfterSec: 45, retryAfter: 60 })).toBe(45);
    expect(bodyRetryAfterSec({ retryAfter: 60 })).toBe(60);
    expect(bodyRetryAfterSec({})).toBeUndefined();
    expect(bodyRetryAfterSec(null)).toBeUndefined();
  });

  it('ignores non-numeric values', () => {
    expect(bodyRetryAfterSec({ retryAfter: '30' })).toBeUndefined();
    expect(bodyRetryAfterSec({ retryAfterSec: Number.POSITIVE_INFINITY })).toBeUndefined();
  });
});
