import { describe, expect, it } from 'vitest';
import type { Hero } from '../types';
import {
  EMPTY_DRAFT,
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
