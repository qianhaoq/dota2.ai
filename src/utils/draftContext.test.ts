import { describe, expect, it } from 'vitest';
import type { Hero } from '../types';
import {
  EMPTY_DRAFT,
  acceptHeroOntoDraft,
  cloneDraft,
  draftHasHeroes,
  resolveLessonDraftSwitch,
  shouldAddHeroToDraft,
} from './draftContext';

const hero = (id: number, name: string): Hero =>
  ({ id, name, nameZh: name, nameEn: name, img: '', icon: '', roles: [], attribute: 'agi' } as unknown as Hero);

describe('draftContext isolation', () => {
  it('clones drafts without sharing arrays', () => {
    const a = { radiant: [hero(1, 'A')], dire: [] };
    const b = cloneDraft(a);
    b.radiant.push(hero(2, 'B'));
    expect(a.radiant).toHaveLength(1);
    expect(draftHasHeroes(EMPTY_DRAFT)).toBe(false);
  });

  it('snapshots live draft when entering review', () => {
    const live = { radiant: [hero(1, 'A')], dire: [hero(2, 'B')] };
    const result = resolveLessonDraftSwitch({
      currentLesson: 'bp',
      nextLesson: 'review',
      liveDraft: live,
      snapshot: EMPTY_DRAFT,
    });
    expect(result.enteringReview).toBe(true);
    expect(result.snapshot.radiant.map((h) => h.id)).toEqual([1]);
    expect(result.draft.radiant.map((h) => h.id)).toEqual([1]);
  });

  it('restores snapshot when leaving review (drops review pollution)', () => {
    const snapshot = { radiant: [hero(9, 'Snap')], dire: [] };
    const polluted = {
      radiant: [hero(1, 'M1'), hero(2, 'M2'), hero(3, 'M3')],
      dire: [hero(4, 'M4'), hero(5, 'M5')],
    };
    const result = resolveLessonDraftSwitch({
      currentLesson: 'review',
      nextLesson: 'bp',
      liveDraft: polluted,
      snapshot,
    });
    expect(result.leavingReview).toBe(true);
    expect(result.clearUserInput).toBe(true);
    expect(result.draft.radiant.map((h) => h.id)).toEqual([9]);
    expect(result.draft.dire).toHaveLength(0);
  });

  it('keeps empty snapshot when review started with empty draft', () => {
    const result = resolveLessonDraftSwitch({
      currentLesson: 'review',
      nextLesson: 'bp',
      liveDraft: { radiant: [hero(1, 'Polluted')], dire: [] },
      snapshot: EMPTY_DRAFT,
    });
    expect(draftHasHeroes(result.draft)).toBe(false);
  });

  it('only suggest/analyze/meta/playbook may add heroes to draft', () => {
    expect(shouldAddHeroToDraft('review')).toBe(false);
    expect(shouldAddHeroToDraft(undefined)).toBe(false);
    expect(shouldAddHeroToDraft('suggest')).toBe(true);
    expect(shouldAddHeroToDraft('analyze')).toBe(true);
  });
});

describe('acceptHeroOntoDraft', () => {
  const practice = hero(100, 'Practice');

  it('appends the accepted hero to a non-empty side', () => {
    const board = { radiant: [hero(1, 'A')], dire: [] };
    const next = acceptHeroOntoDraft(board, 'radiant', hero(2, 'B'), practice);
    expect(next.radiant.map((h) => h.id)).toEqual([1, 2]);
    expect(board.radiant).toHaveLength(1);
  });

  it('materializes the practice hero before the accepted pick on an empty side', () => {
    const next = acceptHeroOntoDraft(EMPTY_DRAFT, 'radiant', hero(2, 'B'), practice);
    expect(next.radiant.map((h) => h.id)).toEqual([100, 2]);
  });

  it('does not duplicate when the accepted hero IS the practice hero', () => {
    const next = acceptHeroOntoDraft(EMPTY_DRAFT, 'radiant', practice, practice);
    expect(next.radiant.map((h) => h.id)).toEqual([100]);
  });

  it('does not re-materialize a practice hero already on the other side', () => {
    const board = { radiant: [], dire: [practice] };
    const next = acceptHeroOntoDraft(board, 'radiant', hero(2, 'B'), practice);
    expect(next.radiant.map((h) => h.id)).toEqual([2]);
    expect(next.dire.map((h) => h.id)).toEqual([100]);
  });

  it('returns the board unchanged when the hero is already picked', () => {
    const board = { radiant: [hero(1, 'A')], dire: [] };
    const next = acceptHeroOntoDraft(board, 'dire', hero(1, 'A'), practice);
    expect(next).toBe(board);
  });

  it('caps the side at 5 heroes', () => {
    const board = {
      radiant: [hero(1, 'A'), hero(2, 'B'), hero(3, 'C'), hero(4, 'D'), hero(5, 'E')],
      dire: [],
    };
    const next = acceptHeroOntoDraft(board, 'radiant', hero(6, 'F'), practice);
    expect(next.radiant).toHaveLength(5);
  });
});
