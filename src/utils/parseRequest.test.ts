import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ReviewParseStatus } from '../types/matchReview';
import {
  createParseRequestController,
  isParseAbortError,
  shouldOfferParseRequest,
} from './parseRequest';

const statusOf = (status: ReviewParseStatus['status'], retryAfterSec: number | null = null): ReviewParseStatus => ({
  status,
  jobId: null,
  retryAfterSec,
  message: '',
});

describe('shouldOfferParseRequest', () => {
  it('offers the parse button for unparsed and failed matches', () => {
    expect(shouldOfferParseRequest(statusOf('unparsed'))).toBe(true);
    expect(shouldOfferParseRequest(statusOf('failed'))).toBe(true);
  });

  it('offers it for pending/throttled only once the cooldown elapsed', () => {
    expect(shouldOfferParseRequest(statusOf('pending', 45))).toBe(false);
    expect(shouldOfferParseRequest(statusOf('throttled', 45))).toBe(false);
    expect(shouldOfferParseRequest(statusOf('pending', 0))).toBe(true);
    expect(shouldOfferParseRequest(statusOf('throttled'))).toBe(true);
  });

  it('does not offer it for requested/parsed or a missing status', () => {
    expect(shouldOfferParseRequest(statusOf('requested'))).toBe(false);
    expect(shouldOfferParseRequest(statusOf('parsed'))).toBe(false);
    expect(shouldOfferParseRequest(null)).toBe(false);
    expect(shouldOfferParseRequest(undefined)).toBe(false);
  });
});

describe('isParseAbortError', () => {
  it('recognizes abort errors by name only', () => {
    expect(isParseAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isParseAbortError(new Error('fetch failed'))).toBe(false);
    expect(isParseAbortError(undefined)).toBe(false);
  });
});

describe('createParseRequestController', () => {
  it('calls the helper once and resolves with the updated parse status', async () => {
    const requested = statusOf('requested');
    const requestFn = vi.fn(async () => requested);
    const controller = createParseRequestController(requestFn);

    const result = await controller.request(8985182860, 'en', 'Failed to request a parse');

    expect(requestFn).toHaveBeenCalledTimes(1);
    expect(requestFn).toHaveBeenCalledWith(8985182860, 'en', expect.any(AbortSignal));
    expect(result).toEqual({ kind: 'status', status: requested });
    expect(controller.isPending()).toBe(false);
  });

  it('is single-flight: a second concurrent request does not call the helper again', async () => {
    let resolveRequest!: (s: ReviewParseStatus) => void;
    const requestFn = vi.fn(
      () => new Promise<ReviewParseStatus>((res) => { resolveRequest = res; }),
    );
    const controller = createParseRequestController(requestFn);

    const first = controller.request(1, 'en', 'fail');
    const second = await controller.request(1, 'en', 'fail');

    expect(second).toBeNull();
    expect(controller.isPending()).toBe(true);
    resolveRequest(statusOf('pending'));
    expect(await first).toEqual({ kind: 'status', status: statusOf('pending') });
    expect(requestFn).toHaveBeenCalledTimes(1);
  });

  it('surfaces the server error message and falls back for network failures', async () => {
    const serverErr = Object.assign(new Error('OpenDota is busy'), { name: 'MatchFactsError' });
    const controller = createParseRequestController(vi.fn(async () => { throw serverErr; }));
    expect(await controller.request(1, 'zh', '解析请求失败，请稍后重试'))
      .toEqual({ kind: 'error', message: 'OpenDota is busy' });

    const networkDown = createParseRequestController(vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(await networkDown.request(1, 'zh', '解析请求失败，请稍后重试'))
      .toEqual({ kind: 'error', message: '解析请求失败，请稍后重试' });
  });

  it('abort() cancels the in-flight request and resolves it as aborted', async () => {
    const requestFn = vi.fn(async (_id: number, _lang: 'en' | 'zh', signal?: AbortSignal) => {
      await new Promise((res) => setTimeout(res, 5));
      if (signal?.aborted) {
        throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      }
      return statusOf('requested');
    });
    const controller = createParseRequestController(requestFn);

    const run = controller.request(1, 'en', 'fail');
    controller.abort();

    expect(await run).toEqual({ kind: 'aborted' });
    expect(controller.isPending()).toBe(false);
  });
});

describe('ReviewEntry parse-request wiring (component guard)', () => {
  const content = readFileSync(join(__dirname, '../components/coach/ReviewEntry.tsx'), 'utf-8');

  it('renders the parse button from shouldOfferParseRequest inside the parse banner', () => {
    expect(content).toContain('shouldShowParseStatusBanner(parseStatus)');
    expect(content).toContain('shouldOfferParseRequest(parseStatus)');
    expect(content).toContain('review-entry-request-parse');
  });

  it('submits only from the click handler, never automatically', () => {
    // requestMatchParse is never called directly in the component (no
    // auto-submission on load/effect) — only handed to the controller factory.
    expect(content).not.toMatch(/\brequestMatchParse\s*\(/);
    expect(content).toContain('createParseRequestController(requestMatchParse)');
    expect(content).toMatch(/handleRequestParse[\s\S]*getParseRequestController\(\)\.request\(/);
    expect(content).toMatch(/onClick=\{\(\) => void handleRequestParse\(\)\}/);
  });

  it('aborts the request on unmount and on match invalidation', () => {
    const aborts = content.match(/parseRequestControllerRef\.current\?\.abort\(\)/g) ?? [];
    expect(aborts.length).toBeGreaterThanOrEqual(2);
  });
});
