/**
 * Minimal runtime for the internal Dota coaching-domain contract.
 * Ported from docs/design/tactical-coach-v3/prototype/runtime.mjs (kept
 * behavior-identical; the prototype tests are ported alongside).
 *
 * Guardrails:
 * - Only the currently active request (contextId + contextRevision + runId,
 *   busy) can update a surface; surface revisions must be consecutive.
 * - Stopping invalidates the old run while retaining completed surfaces.
 * - Player answers are recorded as user_report, never as match facts.
 * - Aggregate stats never become vision or coordinates (reviewCapabilities).
 */

import { isKnownAction, isKnownComponent } from './catalog';
import type {
  CoachAnswerEvent,
  CoachAnswerValue,
  CoachPatch,
  CoachRuntimeState,
  CoachSurface,
  DraftSlots,
  JournalNote,
  ReviewCapabilities,
} from './types';

const UNSAFE_SURFACE_IDS = ['__proto__', 'constructor', 'prototype'];
const SURFACE_KEYS: readonly string[] = ['id', 'component', 'revision', 'presentation', 'title'];
const PRESENTATIONS: readonly string[] = ['demo', 'diagram', 'nonspatial'];
const ANSWER_VALUES: readonly string[] = ['seen', 'unseen', 'unknown'];
const MATCH_HOSTS: readonly string[] = [
  'www.opendota.com',
  'opendota.com',
  'www.dotabuff.com',
  'dotabuff.com',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createState(contextId = 'demo-teamfight-01'): CoachRuntimeState {
  return {
    contextId,
    contextRevision: 0,
    runId: 0,
    busy: false,
    surfaces: {},
    seenEventIds: [],
    answers: {},
    notes: [],
  };
}

export function beginRun(state: CoachRuntimeState): CoachRuntimeState {
  return { ...state, runId: state.runId + 1, busy: true };
}

/** Stop immediately unblocks the UI and invalidates the in-flight run. */
export function stopRun(state: CoachRuntimeState): CoachRuntimeState {
  return { ...state, runId: state.runId + 1, busy: false };
}

/** Judge-changing input increments contextRevision; opening docs or scrolling does not. */
export function switchContext(state: CoachRuntimeState, contextId: string): CoachRuntimeState {
  if (!contextId || contextId === state.contextId) return state;
  return {
    ...createState(contextId),
    contextRevision: state.contextRevision + 1,
    runId: state.runId + 1,
    notes: state.notes,
  };
}

export function validSurface(surface: unknown): surface is CoachSurface {
  if (!isRecord(surface)) return false;
  const { id, component, revision, presentation, title } = surface;
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 80 &&
    !UNSAFE_SURFACE_IDS.includes(id) &&
    isKnownComponent(component) &&
    Number.isInteger(revision) &&
    (revision as number) > 0 &&
    typeof presentation === 'string' &&
    PRESENTATIONS.includes(presentation) &&
    typeof title === 'string' &&
    title.length <= 400 &&
    Object.keys(surface).every((k) => SURFACE_KEYS.includes(k))
  );
}

export function applyPatch(state: CoachRuntimeState, patch: unknown): CoachRuntimeState {
  if (!state.busy || !isRecord(patch)) return state;
  if (
    patch.contextId !== state.contextId ||
    patch.contextRevision !== state.contextRevision ||
    patch.runId !== state.runId ||
    !validSurface(patch.surface)
  ) {
    return state;
  }
  const surface = patch.surface as CoachSurface;
  const old = state.surfaces[surface.id];
  if (surface.revision !== (old?.revision ?? 0) + 1) return state;
  return { ...state, surfaces: { ...state.surfaces, [surface.id]: { ...surface } } };
}

export function finishRun(state: CoachRuntimeState, runId: number): CoachRuntimeState {
  return state.runId === runId ? { ...state, busy: false } : state;
}

/**
 * Prototype-grade answer event: checks context/eventId and deduplicates
 * replays. Production must additionally bind surfaceId +
 * expectedSurfaceRevision and re-check permissions server-side.
 */
export function answerEvent(state: CoachRuntimeState, event: unknown): CoachRuntimeState {
  if (!isRecord(event)) return state;
  if (
    !isKnownAction(event.action) ||
    event.action !== 'answer' ||
    typeof event.id !== 'string' ||
    event.id.length > 100 ||
    state.seenEventIds.includes(event.id) ||
    event.contextId !== state.contextId ||
    event.contextRevision !== state.contextRevision ||
    typeof event.value !== 'string' ||
    !ANSWER_VALUES.includes(event.value)
  ) {
    return state;
  }
  const value = event.value as CoachAnswerValue;
  return {
    ...state,
    seenEventIds: [...state.seenEventIds, event.id].slice(-100),
    answers: { ...state.answers, visibility: { value, authority: 'user_report' } },
  };
}

export interface NoteInput {
  key: unknown;
  title: unknown;
  trigger: unknown;
  action: unknown;
  check: unknown;
}

export function saveNote(state: CoachRuntimeState, note: unknown): CoachRuntimeState {
  if (!isRecord(note)) return state;
  const { key, title, trigger, action, check } = note as unknown as NoteInput;
  if (
    typeof key !== 'string' ||
    !key ||
    typeof title !== 'string' ||
    typeof trigger !== 'string' ||
    typeof action !== 'string' ||
    typeof check !== 'string'
  ) {
    return state;
  }
  if (state.notes.some((n) => n.key === key)) return state;
  const saved: JournalNote = {
    key: key.slice(0, 160),
    title: title.slice(0, 200),
    trigger: trigger.slice(0, 500),
    action: action.slice(0, 500),
    check: check.slice(0, 500),
    contextId: state.contextId,
    authority: 'demo',
    done: false,
  };
  return { ...state, notes: [...state.notes, saved] };
}

/** Untrusted persisted storage is sanitized back to the demo-note shape. */
export function restoreNotes(value: unknown): JournalNote[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 100)
    .filter(
      (n): n is Record<string, unknown> =>
        isRecord(n) &&
        typeof n.key === 'string' &&
        typeof n.title === 'string' &&
        typeof n.trigger === 'string' &&
        typeof n.action === 'string' &&
        typeof n.check === 'string' &&
        n.authority === 'demo',
    )
    .map((n) => ({
      key: String(n.key).slice(0, 160),
      title: String(n.title).slice(0, 200),
      trigger: String(n.trigger).slice(0, 500),
      action: String(n.action).slice(0, 500),
      check: String(n.check).slice(0, 500),
      contextId: String(n.contextId || 'demo').slice(0, 160),
      authority: 'demo' as const,
      done: n.done === true,
    }));
}

/** Accepts a bare match id or an OpenDota/Dotabuff https link. Rejects everything else. */
export function parseMatchId(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (/^[1-9]\d{5,11}$/.test(raw)) {
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : null;
  }
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || !MATCH_HOSTS.includes(u.hostname)) return null;
    const m = u.pathname.match(/^\/matches\/([1-9]\d{5,11})\/?$/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function emptyDraft(): DraftSlots {
  return { radiant: Array(5).fill(null), dire: Array(5).fill(null) };
}

/** Assigns one slot; heroes already picked elsewhere stay blocked. */
export function assignHero(
  draft: DraftSlots,
  side: 'radiant' | 'dire',
  slot: number,
  hero: number,
): DraftSlots {
  if (
    (side !== 'radiant' && side !== 'dire') ||
    !Number.isInteger(slot) ||
    slot < 0 ||
    slot > 4 ||
    !Number.isInteger(hero)
  ) {
    return draft;
  }
  const duplicate = (['radiant', 'dire'] as const).some(
    (s) => draft[s].some((h, i) => h === hero && !(s === side && i === slot)),
  );
  if (duplicate) return draft;
  const next: DraftSlots = { radiant: [...draft.radiant], dire: [...draft.dire] };
  next[side][slot] = hero;
  return next;
}

/**
 * Existing MatchFact has no time-indexed coordinates/vision. Never synthesize
 * them: untrusted fields (e.g. positions) must not flip spatial capabilities.
 */
export function reviewCapabilities(fact: unknown): ReviewCapabilities {
  const record = isRecord(fact) ? fact : {};
  const players = Array.isArray(record.players) ? record.players : [];
  const timeline = Array.isArray(record.timeline) ? record.timeline : [];
  return {
    roster: players.length > 0,
    timeline: timeline.length > 0,
    tacticalMap: false,
    vision: false,
    replayPlayback: false,
  };
}

export { emptyDraft };
