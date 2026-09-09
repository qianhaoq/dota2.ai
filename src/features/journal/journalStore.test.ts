import { describe, expect, it } from 'vitest';
import { createJournalStore, type JournalStorage } from './journalStore';

function memoryStorage(initial: Record<string, string> = {}): JournalStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

function failingStorage(): JournalStorage {
  return {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
}

const note = {
  key: 'drill-8',
  title: '关键对手未出现时，先说清一个信息缺口',
  trigger: '准备跟进队友或独自靠近战场前。',
  action: '说出关键对手、最后已知信息，以及会改变决定的一个条件。',
  check: '赛后回想：这次行动前是否主动确认？',
  contextId: 'training-demo',
  authority: 'demo' as const,
};

describe('journalStore', () => {
  it('adds and deduplicates notes', () => {
    const store = createJournalStore(memoryStorage());
    expect(store.addNote(note)).toBe('added');
    expect(store.addNote(note)).toBe('duplicate');
    expect(store.getNotes().length).toBe(1);
  });

  it('rejects invalid notes without touching state', () => {
    const store = createJournalStore(memoryStorage());
    expect(store.addNote({ ...note, key: '' })).toBe('invalid');
    expect(store.getNotes().length).toBe(0);
  });

  it('persists through storage and reloads on next mount', () => {
    const storage = memoryStorage();
    const a = createJournalStore(storage);
    a.addNote(note);
    const b = createJournalStore(storage);
    expect(b.getNotes().length).toBe(1);
    expect(b.getNotes()[0]?.key).toBe('drill-8');
  });

  it('fails soft to in-memory when storage reads fail', () => {
    const store = createJournalStore(failingStorage());
    expect(store.isPersistent()).toBe(false);
    expect(store.addNote(note)).toBe('added');
    expect(store.getNotes().length).toBe(1);
  });

  it('degrades to in-memory when a later write fails', () => {
    let broken = false;
    const storage: JournalStorage = {
      getItem: (k) => (broken ? null : memoryStorage().getItem(k)),
      setItem: (k, v) => {
        if (broken) throw new Error('quota');
        memoryStorage().setItem(k, v);
      },
    };
    const store = createJournalStore(storage);
    store.addNote(note);
    broken = true;
    expect(store.addNote({ ...note, key: 'item-survive' })).toBe('added');
    expect(store.isPersistent()).toBe(false);
    expect(store.getNotes().length).toBe(2);
  });

  it('sanitizes untrusted persisted payloads', () => {
    const storage = memoryStorage({
      'dota-v3-tactical-notes': JSON.stringify([
        { key: 'ok', title: 't', trigger: 'a', action: 'b', check: 'c', authority: 'demo' },
        { key: 'bad' },
        null,
        { key: 'x', title: 1, trigger: '', action: '', check: '', authority: 'fact' },
      ]),
    });
    const store = createJournalStore(storage);
    expect(store.getNotes().length).toBe(1);
    expect(store.getNotes()[0]?.key).toBe('ok');
  });

  it('toggles done, removes and restores for undo', () => {
    const store = createJournalStore(memoryStorage());
    store.addNote(note);
    store.toggleDone('drill-8');
    expect(store.getNotes()[0]?.done).toBe(true);
    const removed = store.removeNote('drill-8');
    expect(removed?.key).toBe('drill-8');
    expect(store.getNotes().length).toBe(0);
    store.restoreNote(removed!);
    expect(store.getNotes()[0]?.done).toBe(true);
  });

  it('exports notes as text', () => {
    const store = createJournalStore(memoryStorage());
    store.addNote(note);
    const text = store.exportText('zh');
    expect(text).toContain('关键对手未出现时');
    expect(text).toContain('触发：准备跟进队友');
  });
});
