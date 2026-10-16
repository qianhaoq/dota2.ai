import { describe, it, expect } from 'vitest';
import {
  ANON_ID_STORAGE_KEY,
  buildEventPayload,
  generateAnonId,
  isValidAnonId,
  resolveAnonId,
  decideReturnVisit,
  followUpKind,
  claimReviewViewed,
  type StorageLike,
} from './analyticsClient';

/** Minimal in-memory Storage stand-in (localStorage/sessionStorage shape). */
function makeStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => { data.set(k, v); },
  };
}

function makeThrowingStorage(): StorageLike {
  return {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
  };
}

describe('isValidAnonId', () => {
  it('accepts short identifier-shaped ids and rejects free text', () => {
    expect(isValidAnonId('anon_8f4c2d1e')).toBe(true);
    expect(isValidAnonId('a.b:c-d_e')).toBe(true);
    expect(isValidAnonId('has space')).toBe(false);
    expect(isValidAnonId('')).toBe(false);
    expect(isValidAnonId('x'.repeat(65))).toBe(false);
    expect(isValidAnonId(null)).toBe(false);
    expect(isValidAnonId(42)).toBe(false);
  });
});

describe('generateAnonId', () => {
  it('produces a valid anon_ id from the injected random token', () => {
    const id = generateAnonId(() => 'deadbeef-1234');
    expect(id).toBe('anon_deadbeef-1234');
    expect(isValidAnonId(id)).toBe(true);
  });

  it('truncates overlong tokens to stay within the 64-char limit', () => {
    const id = generateAnonId(() => 'y'.repeat(200));
    expect(id.length).toBeLessThanOrEqual(64);
    expect(isValidAnonId(id)).toBe(true);
  });
});

describe('resolveAnonId', () => {
  it('reuses an existing valid id and marks the visitor as returning', () => {
    const storage = makeStorage({ [ANON_ID_STORAGE_KEY]: 'anon_existing' });
    const makeId = () => 'anon_new';
    expect(resolveAnonId(storage, makeId)).toEqual({ anonId: 'anon_existing', isReturning: true });
    // no rewrite happened
    expect(storage.data.get(ANON_ID_STORAGE_KEY)).toBe('anon_existing');
  });

  it('creates and persists an id on first visit (not returning)', () => {
    const storage = makeStorage();
    const result = resolveAnonId(storage, () => 'anon_fresh');
    expect(result).toEqual({ anonId: 'anon_fresh', isReturning: false });
    expect(storage.data.get(ANON_ID_STORAGE_KEY)).toBe('anon_fresh');
  });

  it('regenerates when the stored value is missing or malformed', () => {
    for (const bad of ['has space', '', 'x'.repeat(100)]) {
      const storage = makeStorage({ [ANON_ID_STORAGE_KEY]: bad });
      expect(resolveAnonId(storage, () => 'anon_fixed')).toEqual({
        anonId: 'anon_fixed',
        isReturning: false,
      });
      expect(storage.data.get(ANON_ID_STORAGE_KEY)).toBe('anon_fixed');
    }
  });

  it('degrades gracefully when storage throws (private mode)', () => {
    const result = resolveAnonId(makeThrowingStorage(), () => 'anon_ephemeral');
    expect(result).toEqual({ anonId: 'anon_ephemeral', isReturning: false });
  });
});

describe('return_visit gating (different day, not a refresh)', () => {
  it('first visit never emits, and a same-session refresh never emits', () => {
    const local = makeStorage();
    const session = makeStorage();
    expect(decideReturnVisit(local, session, '2026-10-16')).toBe(false);
    expect(decideReturnVisit(local, session, '2026-10-16')).toBe(false);
  });

  it('a new session on the same day is not a return visit', () => {
    const local = makeStorage();
    decideReturnVisit(local, makeStorage(), '2026-10-16');
    expect(decideReturnVisit(local, makeStorage(), '2026-10-16')).toBe(false);
  });

  it('a new session on a later day emits once', () => {
    const local = makeStorage();
    decideReturnVisit(local, makeStorage(), '2026-10-16');
    const session = makeStorage();
    expect(decideReturnVisit(local, session, '2026-10-18')).toBe(true);
    expect(decideReturnVisit(local, session, '2026-10-18')).toBe(false);
  });

  it('fails closed when storage throws', () => {
    expect(decideReturnVisit(makeThrowingStorage(), makeThrowingStorage(), '2026-10-16')).toBe(false);
  });
});

describe('buildEventPayload', () => {
  it('assembles event + props + anonId', () => {
    expect(buildEventPayload('followup_clicked', { kind: 'preset' }, 'anon_1')).toEqual({
      event: 'followup_clicked',
      props: { kind: 'preset' },
      anonId: 'anon_1',
    });
  });

  it('defaults props to {} and nulls out a missing/invalid anonId', () => {
    expect(buildEventPayload('return_visit')).toEqual({
      event: 'return_visit',
      props: {},
      anonId: null,
    });
    expect(buildEventPayload('review_viewed', { matchId: '123' }, 'bad id')).toEqual({
      event: 'review_viewed',
      props: { matchId: '123' },
      anonId: null,
    });
  });
});

describe('followUpKind', () => {
  it('logs unchanged prefilled chips as preset and edits as custom', () => {
    expect(followUpKind(' Why did we lose? ', 'Why did we lose?')).toBe('preset');
    expect(followUpKind('Why did we lose at 30?', 'Why did we lose?')).toBe('custom');
    expect(followUpKind('anything', null)).toBe('custom');
  });
});

describe('claimReviewViewed', () => {
  it('counts a match once per browser session (survives refresh via sessionStorage)', () => {
    const session = makeStorage();
    expect(claimReviewViewed(session, 8985182860)).toBe(true);
    expect(claimReviewViewed(session, 8985182860)).toBe(false);
    expect(claimReviewViewed(session, 1)).toBe(true);
    expect(claimReviewViewed(makeStorage(), 8985182860)).toBe(true);
  });
});
