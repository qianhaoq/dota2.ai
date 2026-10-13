import { describe, expect, it } from 'vitest';
import {
  parseReviewParseStatus,
  parseRetryAfterLabel,
  shouldShowParseStatusBanner,
} from './parseStatus';

describe('parseReviewParseStatus', () => {
  it.each(['requested', 'pending', 'parsed', 'unparsed', 'failed', 'throttled'] as const)(
    'accepts status %s with full fields',
    (status) => {
      const parsed = parseReviewParseStatus({
        status,
        jobId: 12345,
        retryAfterSec: 120,
        message: 'msg',
      });
      expect(parsed).toEqual({ status, jobId: 12345, retryAfterSec: 120, message: 'msg' });
    },
  );

  it('returns null for missing or non-object payloads', () => {
    expect(parseReviewParseStatus(undefined)).toBeNull();
    expect(parseReviewParseStatus(null)).toBeNull();
    expect(parseReviewParseStatus('parsed')).toBeNull();
    expect(parseReviewParseStatus(42)).toBeNull();
  });

  it('returns null for unknown statuses', () => {
    expect(parseReviewParseStatus({ status: 'queued' })).toBeNull();
    expect(parseReviewParseStatus({ status: 200 })).toBeNull();
    expect(parseReviewParseStatus({})).toBeNull();
  });

  it('normalizes missing/invalid optional fields', () => {
    expect(parseReviewParseStatus({ status: 'pending' })).toEqual({
      status: 'pending',
      jobId: null,
      retryAfterSec: null,
      message: '',
    });
    expect(
      parseReviewParseStatus({ status: 'requested', jobId: 'abc', retryAfterSec: 'soon', message: 7 }),
    ).toEqual({ status: 'requested', jobId: null, retryAfterSec: null, message: '' });
  });
});

describe('shouldShowParseStatusBanner', () => {
  it('hides the banner when parsed or absent', () => {
    expect(shouldShowParseStatusBanner(null)).toBe(false);
    expect(shouldShowParseStatusBanner(undefined)).toBe(false);
    expect(
      shouldShowParseStatusBanner({ status: 'parsed', jobId: null, retryAfterSec: null, message: '' }),
    ).toBe(false);
  });

  it.each(['requested', 'pending', 'unparsed', 'failed', 'throttled'] as const)('shows the banner for %s', (status) => {
    expect(
      shouldShowParseStatusBanner({ status, jobId: null, retryAfterSec: null, message: '' }),
    ).toBe(true);
  });
});

describe('parseRetryAfterLabel', () => {
  it('formats a bilingual retry hint', () => {
    expect(parseRetryAfterLabel('en', 120)).toBe('Retry in ~120s');
    expect(parseRetryAfterLabel('zh', 90)).toBe('约 90 秒后可重试');
  });

  it('returns null when there is no meaningful wait', () => {
    expect(parseRetryAfterLabel('en', null)).toBeNull();
    expect(parseRetryAfterLabel('en', 0)).toBeNull();
    expect(parseRetryAfterLabel('zh', -5)).toBeNull();
  });
});
