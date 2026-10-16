import { describe, it, expect } from 'vitest';
import {
  ANON_ID_STORAGE_KEY,
  RETURN_VISIT_SESSION_KEY,
  buildEventPayload,
  generateAnonId,
  isValidAnonId,
  markReturnVisitEmitted,
  resolveAnonId,
  shouldEmitReturnVisit,
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

describe('return_visit gating', () => {
  it('emits once per session for a returning visitor', () => {
    const session = makeStorage();
    expect(shouldEmitReturnVisit(session, true)).toBe(true);
    markReturnVisitEmitted(session);
    expect(session.data.get(RETURN_VISIT_SESSION_KEY)).toBe('1');
    expect(shouldEmitReturnVisit(session, true)).toBe(false);
  });

  it('never emits for a first-time visitor', () => {
    const session = makeStorage();
    expect(shouldEmitReturnVisit(session, false)).toBe(false);
  });

  it('fails open when sessionStorage throws', () => {
    expect(shouldEmitReturnVisit(makeThrowingStorage(), true)).toBe(true);
    expect(() => markReturnVisitEmitted(makeThrowingStorage())).not.toThrow();
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
