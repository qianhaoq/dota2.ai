/**
 * Tactical journal store: local notes of the shape "trigger + action + check".
 *
 * Boundaries (docs/design/tactical-coach-v3/docs/DESIGN.md §3.7):
 * - Local-device storage only; on any storage failure we degrade to in-memory
 *   for the rest of the session instead of losing the feature.
 * - Export is user-triggered; nothing is uploaded or shared by default.
 * - Saving is not training authorization; completing a note is self-report.
 */

import { useSyncExternalStore } from 'react';
import type { JournalNote } from '../../coach-ui/types';

const STORAGE_KEY = 'dota-v3-tactical-notes';
const MAX_NOTES = 100;

export interface JournalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type AddNoteStatus = 'added' | 'duplicate' | 'invalid';

export interface JournalNoteInput {
  key: string;
  title: string;
  trigger: string;
  action: string;
  check: string;
  contextId: string;
  authority: JournalNote['authority'];
}

const AUTHORITIES: readonly JournalNote['authority'][] = [
  'fact',
  'inference',
  'user_report',
  'hypothesis',
  'demo',
];

function sanitizeNote(value: unknown): JournalNote | null {
  if (typeof value !== 'object' || value === null) return null;
  const n = value as Record<string, unknown>;
  if (
    typeof n.key !== 'string' ||
    !n.key ||
    typeof n.title !== 'string' ||
    typeof n.trigger !== 'string' ||
    typeof n.action !== 'string' ||
    typeof n.check !== 'string'
  ) {
    return null;
  }
  const authority = AUTHORITIES.includes(n.authority as JournalNote['authority'])
    ? (n.authority as JournalNote['authority'])
    : 'demo';
  return {
    key: n.key.slice(0, 160),
    title: n.title.slice(0, 200),
    trigger: n.trigger.slice(0, 500),
    action: n.action.slice(0, 500),
    check: n.check.slice(0, 500),
    contextId: typeof n.contextId === 'string' ? n.contextId.slice(0, 160) : 'unknown',
    authority,
    done: n.done === true,
  };
}

function sanitizeNotes(value: unknown): JournalNote[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_NOTES)
    .map(sanitizeNote)
    .filter((n): n is JournalNote => n !== null);
}

export interface JournalStore {
  subscribe(listener: () => void): () => void;
  getNotes(): JournalNote[];
  /** False when localStorage is unavailable/blocked — notes live in memory only. */
  isPersistent(): boolean;
  addNote(input: JournalNoteInput): AddNoteStatus;
  toggleDone(key: string): void;
  removeNote(key: string): JournalNote | null;
  restoreNote(note: JournalNote): void;
  exportText(lang: 'zh' | 'en'): string;
}

export function createJournalStore(storage: JournalStorage | null): JournalStore {
  const listeners = new Set<() => void>();
  let persistent = storage !== null;
  let notes: JournalNote[] = [];

  if (storage) {
    try {
      notes = sanitizeNotes(JSON.parse(storage.getItem(STORAGE_KEY) || '[]'));
    } catch {
      persistent = false;
    }
  }

  const emit = () => listeners.forEach((l) => l());
  const persist = () => {
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(notes));
    } catch {
      if (persistent) {
        persistent = false;
        emit();
      }
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getNotes: () => notes,
    isPersistent: () => persistent,
    addNote(input) {
      const note = sanitizeNote(input);
      if (!note) return 'invalid';
      if (notes.some((n) => n.key === note.key)) return 'duplicate';
      notes = [...notes, { ...note, done: false }].slice(0, MAX_NOTES);
      persist();
      emit();
      return 'added';
    },
    toggleDone(key) {
      notes = notes.map((n) => (n.key === key ? { ...n, done: !n.done } : n));
      persist();
      emit();
    },
    removeNote(key) {
      const removed = notes.find((n) => n.key === key) ?? null;
      notes = notes.filter((n) => n.key !== key);
      persist();
      emit();
      return removed;
    },
    restoreNote(note) {
      const clean = sanitizeNote(note);
      if (!clean || notes.some((n) => n.key === clean.key)) return;
      notes = [...notes, clean];
      persist();
      emit();
    },
    exportText(lang) {
      const sourceLabel = lang === 'zh' ? '来源' : 'Source';
      const doneLabel = lang === 'zh' ? '已自我检查' : 'self-checked';
      return notes
        .map((n) =>
          [
            n.title,
            `${lang === 'zh' ? '触发' : 'Trigger'}：${n.trigger}`,
            `${lang === 'zh' ? '行动' : 'Action'}：${n.action}`,
            `${lang === 'zh' ? '检查' : 'Check'}：${n.check}`,
            `${sourceLabel}：${n.contextId}${n.done ? ` · ${doneLabel}` : ''}`,
            '',
          ].join('\n'),
        )
        .join('\n');
    },
  };
}

function detectStorage(): JournalStorage | null {
  try {
    const storage = globalThis.localStorage;
    return storage ? { getItem: (k) => storage.getItem(k), setItem: (k, v) => storage.setItem(k, v) } : null;
  } catch {
    return null;
  }
}

/** App-wide singleton backed by localStorage when available. */
export const journalStore: JournalStore = createJournalStore(detectStorage());

export function useJournalNotes(): JournalNote[] {
  return useSyncExternalStore(journalStore.subscribe, journalStore.getNotes, journalStore.getNotes);
}
