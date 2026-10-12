import { describe, expect, it } from 'vitest';
import type { CoachMessage } from '../components/coach/coachMessage';
import type { MatchFact, ReviewParseStatus } from '../types/matchReview';
import type { ReviewCardsPayload } from '../types/reviewCards';
import { reviewFactsRefreshResult } from './reviewFactsRefresh';

const fact = (timelineLength: number): MatchFact => ({
  summary: { matchId: 9035042364 },
  focusHeroId: 74,
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

  it('drops stale cards when the refreshed fact differs even without a parse transition', () => {
    const prev = reviewMessage({
      matchFact: fact(2),
      parseStatus: parseStatus('parsed'),
      reviewCards: cards(),
    });
    const next = { matchFact: fact(5), parseStatus: parseStatus('parsed') };

    const result = reviewFactsRefreshResult(prev, next);

    expect(result.staleCleared).toBe(true);
    expect(result.patch.reviewCards).toBeNull();
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
