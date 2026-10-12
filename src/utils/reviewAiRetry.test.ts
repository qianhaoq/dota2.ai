import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildMatchFact } from '../../lib/matchReview/matchFacts.js';
import { resolveReviewCardsWithRetry } from '../../lib/matchReview/reviewAiRetry.js';
import type { ReviewCardsPayload } from '../types/reviewCards';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/match8985182860.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

const HERO_NAMES_CN = {
  54: { nameZh: '噬魂鬼', nameEn: 'Lifestealer' },
  86: { nameZh: '拉比克', nameEn: 'Rubick' },
  42: { nameZh: '冥界亚龙', nameEn: 'Viper' },
  2: { nameZh: '斧王', nameEn: 'Axe' },
  88: { nameZh: '娜迦海妖', nameEn: 'Naga Siren' },
  71: { nameZh: '裂魂人', nameEn: 'Spirit Breaker' },
  18: { nameZh: '斯温', nameEn: 'Sven' },
  9: { nameZh: '米拉娜', nameEn: 'Mirana' },
  123: { nameZh: '森海飞霞', nameEn: 'Hoodwink' },
  90: { nameZh: '光之守卫', nameEn: 'Keeper of the Light' },
};

const fact = buildMatchFact(fixture, { lang: 'zh', heroId: 54, heroNames: HERO_NAMES_CN });

// Passes isReviewAiCardsComplete: grounded fight_timing mistake (timeline
// evidence), 3 distinct grounded key moments, shape-valid drill.
const COMPLETE_TEXT = JSON.stringify({
  primary_mistake: {
    category: 'fight_timing',
    headline: '中期开团过早',
    explanation: '在经济落后时强行开团。',
    evidence: [{ factKey: 'timeline_0' }, { factKey: 'kda' }, { factKey: 'gold_lead_20' }],
  },
  key_moments: [
    { timestamp: 48, phase: 'lane', headline: '一血', why: '下路交出一血。', evidence: [{ factKey: 'timeline_0' }] },
    { timestamp: 1310, phase: 'mid', headline: '推中二塔', why: '扩大优势。', evidence: [{ factKey: 'timeline_2' }] },
    { timestamp: 2817, phase: 'late', headline: '肉山', why: '夜魇控肉山。', evidence: [{ factKey: 'timeline_5' }] },
  ],
  drill: { duration: '15 分钟', title: '练节奏', steps: ['每局只选一个改进点'] },
});

// Fails validation: mistake cites no timeline fact, key moments cite facts
// outside the catalog (dropped on parse → 0 moments).
const INVALID_TEXT = JSON.stringify({
  primary_mistake: {
    category: 'fight_timing',
    headline: '失误',
    explanation: '解释',
    evidence: [{ factKey: 'kda' }],
  },
  key_moments: [
    { timestamp: 9999, headline: '假', why: '无', evidence: [{ factKey: 'timeline_99' }] },
    { timestamp: 1310, headline: 'b', why: 'b', evidence: [] },
    { timestamp: 2817, headline: 'c', why: 'c', evidence: [{ factKey: 'fake_stat' }] },
  ],
  drill: { duration: '15 分钟', title: '练', steps: ['一步'] },
});

// What openai v4 rejects with when the caller's signal aborts — note the
// name is NOT 'AbortError', which is why classification goes through the
// aborted shared signal instead of the error name.
function userAbortError() {
  return Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' });
}

function abortError() {
  return Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
}

function createHarness(overrides: Record<string, unknown> = {}) {
  const warn = vi.fn();
  const controller = new AbortController();
  const requestCompletionText = vi.fn(async () => COMPLETE_TEXT);
  const opts = {
    firstText: COMPLETE_TEXT,
    matchFact: fact,
    lang: 'zh',
    minKeyMoments: 3,
    matchId: 8985182860,
    requestCompletionText,
    signal: controller.signal,
    warn,
    ...overrides,
  };
  return { opts, warn, controller, requestCompletionText };
}

describe('resolveReviewCardsWithRetry', () => {
  it('returns first-attempt cards without a retry when they are complete', async () => {
    const h = createHarness();
    const result = await resolveReviewCardsWithRetry(h.opts);
    const cards = result.reviewCards as ReviewCardsPayload;
    expect(result.usedFallback).toBe(false);
    expect(cards.primary_mistake?.headline).toBe('中期开团过早');
    expect(h.requestCompletionText).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('retries once and keeps the retry cards when the first attempt is invalid', async () => {
    const h = createHarness({ firstText: INVALID_TEXT });
    const result = await resolveReviewCardsWithRetry(h.opts);
    const cards = result.reviewCards as ReviewCardsPayload;
    expect(result.usedFallback).toBe(false);
    expect(cards.primary_mistake?.headline).toBe('中期开团过早');
    expect(h.requestCompletionText).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0][0]).toContain('attempt=1 result=invalid');
  });

  it('marks fallback when the retry output is still invalid', async () => {
    const h = createHarness({
      firstText: INVALID_TEXT,
      requestCompletionText: vi.fn(async () => INVALID_TEXT),
    });
    const result = await resolveReviewCardsWithRetry(h.opts);
    expect(result.usedFallback).toBe(true);
    expect(h.warn.mock.calls.map((c) => c[0]).join('\n')).toContain('attempt=2 result=invalid');
  });

  it('swallows non-abort retry errors and marks fallback', async () => {
    const h = createHarness({
      firstText: INVALID_TEXT,
      requestCompletionText: vi.fn(async () => {
        throw Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' });
      }),
    });
    const result = await resolveReviewCardsWithRetry(h.opts);
    expect(result.usedFallback).toBe(true);
    expect(h.warn.mock.calls.map((c) => c[0]).join('\n')).toContain(
      '[review:ai-retry] match=8985182860 error=APIConnectionError (non-fatal)'
    );
  });

  it('rethrows the retry abort when the client disconnected (openai APIUserAbortError shape)', async () => {
    const err = userAbortError();
    const h = createHarness({
      firstText: INVALID_TEXT,
      requestCompletionText: vi.fn(() => Promise.reject(err)),
    });
    // The disconnect: shared signal aborts before the rejected await resumes.
    h.controller.abort();
    // The caller (server.js) treats this rethrow as "exit quietly" — no
    // fallback cards, no write/end on the already-closed response.
    await expect(resolveReviewCardsWithRetry(h.opts)).rejects.toBe(err);
    // Only the attempt=1 validation line was logged; the abort is not
    // recorded as an upstream/retry failure.
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0][0]).toContain('attempt=1 result=invalid');
  });

  it('rethrows a plain AbortError when the client disconnected', async () => {
    const err = abortError();
    const h = createHarness({
      firstText: INVALID_TEXT,
      requestCompletionText: vi.fn(() => Promise.reject(err)),
    });
    h.controller.abort();
    await expect(resolveReviewCardsWithRetry(h.opts)).rejects.toBe(err);
    expect(h.warn).toHaveBeenCalledTimes(1);
  });

  it('does not classify an abort-shaped error with a live signal as a disconnect', async () => {
    const h = createHarness({
      firstText: INVALID_TEXT,
      requestCompletionText: vi.fn(() => Promise.reject(abortError())),
    });
    // Signal never aborted → not a client disconnect → degrade to fallback.
    const result = await resolveReviewCardsWithRetry(h.opts);
    expect(result.usedFallback).toBe(true);
    expect(h.warn.mock.calls.map((c) => c[0]).join('\n')).toContain(
      '[review:ai-retry] match=8985182860 error=AbortError (non-fatal)'
    );
  });
});
