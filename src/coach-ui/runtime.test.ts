/**
 * Port of docs/design/tactical-coach-v3/prototype/runtime.test.mjs (node:test
 * -> vitest). Behavior of src/coach-ui/runtime.ts must stay identical to the
 * reviewed prototype semantics.
 */
import { describe, expect, it } from 'vitest';
import {
  answerEvent,
  applyPatch,
  assignHero,
  beginRun,
  createState,
  finishRun,
  parseMatchId,
  restoreNotes,
  reviewCapabilities,
  saveNote,
  stopRun,
  switchContext,
  validSurface,
} from './runtime';
import type { CoachPatch, CoachRuntimeState, CoachSurface, DraftSlots } from './types';

const surface: CoachSurface = {
  id: 'decision',
  component: 'DecisionFork',
  revision: 1,
  presentation: 'demo',
  title: '判断',
};
const patch = (s: CoachRuntimeState): CoachPatch => ({
  contextId: s.contextId,
  contextRevision: s.contextRevision,
  runId: s.runId,
  surface,
});
const note = { key: 'n', title: '判断', trigger: '开团前', action: '确认信息', check: '主动回想' };
const emptyDraft = (): DraftSlots => ({ radiant: Array(5).fill(null), dire: Array(5).fill(null) });

describe('surface patch lifecycle', () => {
  it('only an active request can update a surface', () => {
    const s = createState();
    expect(applyPatch(s, patch(s))).toBe(s);
  });

  it('accepted patches are immutable', () => {
    const s = beginRun(createState());
    const n = applyPatch(s, patch(s));
    expect(n.surfaces.decision?.title).toBe('判断');
    expect(Object.keys(s.surfaces).length).toBe(0);
  });

  it('cancel rejects a late chunk', () => {
    const s = beginRun(createState());
    const n = stopRun(s);
    expect(applyPatch(n, patch(s))).toBe(n);
  });

  it('cancel retains completed surfaces', () => {
    const s = beginRun(createState());
    const n = applyPatch(s, patch(s));
    expect(stopRun(n).surfaces.decision?.title).toBe('判断');
  });

  it('old context cannot update new context', () => {
    const s = beginRun(createState());
    const n = beginRun(switchContext(s, 'other'));
    expect(applyPatch(n, patch(s))).toBe(n);
  });

  it('duplicate surface revision is ignored', () => {
    const s = beginRun(createState());
    const n = applyPatch(s, patch(s));
    expect(applyPatch(n, patch(s))).toBe(n);
  });

  it('a skipped surface revision is rejected', () => {
    const s = beginRun(createState());
    expect(applyPatch(s, { ...patch(s), surface: { ...surface, revision: 3 } })).toBe(s);
  });

  it('late finish cannot unlock another request', () => {
    const s = beginRun(beginRun(createState()));
    expect(finishRun(s, 1)).toBe(s);
  });
});

describe('surface validation', () => {
  it('unknown component rejected', () => {
    expect(validSurface({ ...surface, component: 'RawHtml' })).toBe(false);
  });

  it('unknown props rejected', () => {
    expect(validSurface({ ...surface, html: '<script>' })).toBe(false);
  });

  it('prototype pollution key rejected', () => {
    expect(validSurface({ ...surface, id: '__proto__' })).toBe(false);
  });

  it('invalid title rejected', () => {
    expect(validSurface({ ...surface, title: { code: 'x' } as unknown as string })).toBe(false);
  });
});

describe('answer events', () => {
  it('user memory stays user_report', () => {
    const s = createState();
    const n = answerEvent(s, {
      id: 'a',
      action: 'answer',
      contextId: s.contextId,
      contextRevision: 0,
      value: 'seen',
    });
    expect(n.answers.visibility?.authority).toBe('user_report');
  });

  it('replayed events do not apply twice', () => {
    const s = createState();
    const e = {
      id: 'a',
      action: 'answer',
      contextId: s.contextId,
      contextRevision: 0,
      value: 'unknown',
    } as const;
    const n = answerEvent(s, e);
    expect(answerEvent(n, e)).toBe(n);
  });

  it('old-context action rejected', () => {
    const s = createState();
    expect(
      answerEvent(s, { id: 'a', action: 'answer', contextId: 'old', contextRevision: 0, value: 'seen' }),
    ).toBe(s);
  });

  it('unsupported action rejected', () => {
    const s = createState();
    expect(
      answerEvent(s, { id: 'a', action: 'eval', contextId: s.contextId, contextRevision: 0, value: 'seen' }),
    ).toBe(s);
  });
});

describe('notes', () => {
  it('saved notes deduplicated', () => {
    const s = saveNote(createState(), note);
    expect(saveNote(s, note)).toBe(s);
  });

  it('saved note includes context', () => {
    expect(saveNote(createState('demo-a'), note).notes[0]?.contextId).toBe('demo-a');
  });

  it('notes survive context change', () => {
    expect(switchContext(saveNote(createState(), note), 'b').notes.length).toBe(1);
  });

  it('untrusted storage is sanitized', () => {
    expect(restoreNotes([{}, null, { title: 'x' }])).toEqual([]);
  });

  it('valid demo storage restored', () => {
    expect(restoreNotes(saveNote(createState(), note).notes).length).toBe(1);
  });
});

describe('match id intake', () => {
  it('safe match-id input', () => {
    expect(parseMatchId('8985182860')).toBe(8985182860);
  });

  it('recognized URL is parsed', () => {
    expect(parseMatchId('https://www.opendota.com/matches/8985182860')).toBe(8985182860);
  });

  it('unknown host rejected', () => {
    expect(parseMatchId('https://evil.test/matches/8985182860')).toBe(null);
  });

  it('javascript URL rejected', () => {
    expect(parseMatchId('javascript:alert(1)')).toBe(null);
  });

  it('unsafe numeric IDs rejected', () => {
    expect(parseMatchId('999999999999999999999')).toBe(null);
  });
});

describe('draft slots', () => {
  it('duplicate heroes rejected', () => {
    const d: DraftSlots = { radiant: [1, null, null, null, null], dire: [null, null, null, null, null] };
    expect(assignHero(d, 'dire', 0, 1)).toBe(d);
  });

  it('editing enemy does not mutate allied slots', () => {
    const d: DraftSlots = { radiant: [1, null, null, null, null], dire: [null, null, null, null, null] };
    const n = assignHero(d, 'dire', 0, 2);
    expect(n.radiant[0]).toBe(1);
    expect(d.dire[0]).toBe(null);
  });

  it('invalid slot rejected', () => {
    const d = emptyDraft();
    expect(assignHero(d, 'radiant', 5, 2)).toBe(d);
  });
});

describe('evidence capabilities', () => {
  it('aggregate facts never become vision or coordinates', () => {
    expect(reviewCapabilities({ players: [{}], timeline: [{}], positions: 'untrusted' })).toEqual({
      roster: true,
      timeline: true,
      tacticalMap: false,
      vision: false,
      replayPlayback: false,
    });
  });

  it('missing fact yields no capabilities', () => {
    expect(reviewCapabilities(null)).toEqual({
      roster: false,
      timeline: false,
      tacticalMap: false,
      vision: false,
      replayPlayback: false,
    });
  });
});
