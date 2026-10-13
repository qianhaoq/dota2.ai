import { describe, expect, it } from 'vitest';
import type { CoachMessage } from '../components/coach/coachMessage';
import type { MatchFact, ReviewParseStatus } from '../types/matchReview';
import type { ReviewCardsPayload } from '../types/reviewCards';
import { reviewFactsRefreshResult, reviewRequestHeroId, isFactsRetryCurrent, type ReviewFactsRetryToken } from './reviewFactsRefresh';

const fact = (timelineLength: number): MatchFact => ({
  summary: { matchId: 9035042364 },
  focusHeroId: 74,
  timeline: Array.from({ length: timelineLength }, (_, i) => ({ time: i * 60, type: 'kill', key: null })),
} as unknown as MatchFact);

/** A fact built without the request-time heroId — what the GET returned before the fix. */
const focusLessFact = (timelineLength: number): MatchFact => ({
  summary: { matchId: 9035042364 },
  focusHeroId: null,
  timeline: Array.from({ length: timelineLength }, (_, i) => ({ time: i * 60, type: 'kill', key: null })),
} as unknown as MatchFact);

const parseStatus = (status: ReviewParseStatus['status']): ReviewParseStatus => ({
  status,
  jobId: null,
  retryAfterSec: null,
  message: '',
});

const cards = (): ReviewCardsPayload => ({
  match_summary: {
    matchId: 9035042364,
    heroId: 74,
    durationFormatted: '36:12',
    heroName: 'Invoker',
    result: 'win',
    resultLabel: 'Victory',
  },
});

const reviewMessage = (overrides: Partial<CoachMessage>): CoachMessage => ({
  id: 'm1',
  type: 'coach',
  action: 'review',
  lesson: 'review',
  content: '',
  ...overrides,
});

describe('reviewFactsRefreshResult', () => {
  it('drops stale cards and notice when the refreshed fact is newly parsed', () => {
    const prev = reviewMessage({
      matchFact: fact(0),
      parseStatus: parseStatus('pending'),
      reviewCards: cards(),
      error: 'Replay still parsing — showing partial data.',
    });
    const next = { matchFact: fact(0), parseStatus: parseStatus('parsed') };

    const result = reviewFactsRefreshResult(prev, next);

    expect(result.staleCleared).toBe(true);
    expect(result.heroId).toBe(74);
    expect(result.patch.matchFact).toBe(next.matchFact);
    expect(result.patch.parseStatus).toBe(next.parseStatus);
    expect(result.patch.reviewCards).toBeNull();
    expect(result.patch.error).toBeUndefined();
  });

  it('drops stale cards when parse evidence appears without a status transition', () => {
    const prev = reviewMessage({
      matchFact: fact(0),
      parseStatus: parseStatus('parsed'),
      reviewCards: cards(),
    });
    const next = { matchFact: fact(5), parseStatus: parseStatus('parsed') };

    const result = reviewFactsRefreshResult(prev, next);

    expect(result.staleCleared).toBe(true);
    expect(result.patch.reviewCards).toBeNull();
  });

  it('keeps cards when only non-parse fact fields differ while parsed', () => {
    const prev = reviewMessage({
      matchFact: fact(2),
      parseStatus: parseStatus('parsed'),
      reviewCards: cards(),
    });
    // Same parsed flag and lanes/timeline presence — only fact details moved.
    const next = { matchFact: fact(3), parseStatus: parseStatus('parsed') };

    const result = reviewFactsRefreshResult(prev, next);

    expect(result.staleCleared).toBe(false);
    expect(result.patch.reviewCards).toBeUndefined();
  });

  it('keeps cards when an unchanged unparsed refresh drops the focus context', () => {
    // Regression: a facts retry that omitted the request-time heroId returned
    // focusHeroId: null / no focusLens, and the focused fact comparison always
    // treated it as changed — clearing cards and re-running the review.
    const prev = reviewMessage({
      matchFact: fact(0),
      parseStatus: parseStatus('pending'),
      reviewCards: cards(),
    });
    const next = { matchFact: focusLessFact(0), parseStatus: parseStatus('pending') };

    const result = reviewFactsRefreshResult(prev, next);

    expect(result.staleCleared).toBe(false);
    expect(result.patch.reviewCards).toBeUndefined();
    expect(result.heroId).toBe(74);
  });

  it('keeps cards when nothing changed', () => {
    const prev = reviewMessage({
      matchFact: fact(3),
      parseStatus: parseStatus('parsed'),
      reviewCards: cards(),
      error: 'some notice',
    });
    const next = { matchFact: fact(3), parseStatus: parseStatus('parsed') };

    const result = reviewFactsRefreshResult(prev, next);

    expect(result.staleCleared).toBe(false);
    expect(result.patch).toEqual({ matchFact: next.matchFact, parseStatus: next.parseStatus });
  });

  it('keeps cards when the replay is still unparsed and the fact is unchanged', () => {
    const prev = reviewMessage({
      matchFact: fact(0),
      parseStatus: parseStatus('throttled'),
      reviewCards: cards(),
    });
    const next = { matchFact: fact(0), parseStatus: parseStatus('pending') };

    const result = reviewFactsRefreshResult(prev, next);

    expect(result.staleCleared).toBe(false);
    expect(result.patch.reviewCards).toBeUndefined();
  });

  it('never touches messages without cards (fact spine re-renders from the new fact)', () => {
    const prev = reviewMessage({
      matchFact: fact(0),
      parseStatus: parseStatus('pending'),
    });
    const next = { matchFact: fact(4), parseStatus: parseStatus('parsed') };

    const result = reviewFactsRefreshResult(prev, next);

    expect(result.staleCleared).toBe(false);
    expect(result.patch.reviewCards).toBeUndefined();
    expect(result.heroId).toBe(74);
  });

  it('falls back to focusHeroId when cards carry no hero', () => {
    const prev = reviewMessage({
      matchFact: fact(0),
      parseStatus: parseStatus('pending'),
      reviewCards: { match_summary: { ...cards().match_summary!, heroId: undefined } },
    });
    const result = reviewFactsRefreshResult(prev, { matchFact: fact(1), parseStatus: parseStatus('parsed') });

    expect(result.staleCleared).toBe(true);
    expect(result.heroId).toBe(74);
  });
});

describe('reviewRequestHeroId', () => {
  it('prefers the hero stamped on the cards', () => {
    const msg = reviewMessage({ matchFact: fact(0), reviewCards: cards() });
    expect(reviewRequestHeroId(msg)).toBe(74);
  });

  it('falls back to the fact focus when cards carry no hero', () => {
    const msg = reviewMessage({
      matchFact: fact(0),
      reviewCards: { match_summary: { ...cards().match_summary!, heroId: undefined } },
    });
    expect(reviewRequestHeroId(msg)).toBe(74);
  });

  it('is null for a review requested without a hero', () => {
    const msg = reviewMessage({ matchFact: focusLessFact(0) });
    expect(reviewRequestHeroId(msg)).toBeNull();
  });
});

describe('isFactsRetryCurrent', () => {
  const makeToken = (): ReviewFactsRetryToken => ({ controller: new AbortController() });

  it('is current while its token stays installed and unaborted', () => {
    const token = makeToken();
    expect(isFactsRetryCurrent(token, token)).toBe(true);
  });

  it('is stale once a newer retry supersedes the token', () => {
    const token = makeToken();
    expect(isFactsRetryCurrent(makeToken(), token)).toBe(false);
  });

  it('is stale once the slot was cleared (review finished/reset)', () => {
    const token = makeToken();
    expect(isFactsRetryCurrent(null, token)).toBe(false);
  });

  it('is stale once aborted (active review changed or view unmounted)', () => {
    const token = makeToken();
    token.controller.abort();
    expect(isFactsRetryCurrent(token, token)).toBe(false);
  });
});
