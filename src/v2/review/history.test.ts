import { describe, expect, it } from 'vitest';
import { DEFAULT_CHAT_HISTORY_OPTIONS, buildChatHistory } from './history';

const turn = (role: 'user' | 'assistant', text: string) => ({ role, text });

describe('buildChatHistory', () => {
  it('keeps the last 12 turns by default', () => {
    const turns = Array.from({ length: 20 }, (_, i) => turn(i % 2 ? 'assistant' : 'user', `m${i}`));
    const history = buildChatHistory(turns);
    expect(history).toHaveLength(DEFAULT_CHAT_HISTORY_OPTIONS.maxTurns);
    expect(history[0]).toEqual(turn('user', 'm8'));
    expect(history[11]).toEqual(turn('assistant', 'm19'));
  });

  it('trims each message and caps it at 2000 chars', () => {
    const long = 'x'.repeat(5000);
    const history = buildChatHistory([turn('user', `  ${long}  `)]);
    expect(history).toHaveLength(1);
    expect(history[0].text).toBe('x'.repeat(2000));
  });

  it('drops oldest turns first until the total is ≤8000 chars', () => {
    // 5 messages × 1900 chars = 9500 > 8000 → the oldest is dropped
    // (4 × 1900 = 7600 ≤ 8000), newest kept.
    const turns = Array.from({ length: 5 }, (_, i) => turn('user', `${i}`.padEnd(1900, 'x')));
    const history = buildChatHistory(turns);
    expect(history.map((t) => t.text[0])).toEqual(['1', '2', '3', '4']);
    const total = history.reduce((sum, t) => sum + t.text.length, 0);
    expect(total).toBeLessThanOrEqual(DEFAULT_CHAT_HISTORY_OPTIONS.maxChars);
  });

  it('never drops everything for size: one message capped at maxMessageChars always fits', () => {
    // A single message is capped at 2000 chars, so it always fits maxChars.
    const history = buildChatHistory([turn('assistant', 'y'.repeat(100000))]);
    expect(history).toEqual([turn('assistant', 'y'.repeat(2000))]);
  });

  it('filters out non-user/assistant roles, blanks and nullish entries', () => {
    const history = buildChatHistory([
      null,
      undefined,
      { role: 'system', text: 'prompt' },
      { role: 'user', text: '   ' },
      { role: 42, text: 'junk' },
      { text: 'no role' },
      turn('user', 'keep me'),
    ] as unknown as ReadonlyArray<{ role?: unknown; text?: unknown }>);
    expect(history).toEqual([turn('user', 'keep me')]);
  });

  it('accepts custom options', () => {
    const turns = [turn('user', 'aaaa'), turn('assistant', 'bbbb'), turn('user', 'cccc')];
    expect(buildChatHistory(turns, { maxTurns: 2 })).toEqual([
      turn('assistant', 'bbbb'),
      turn('user', 'cccc'),
    ]);
    expect(buildChatHistory(turns, { maxChars: 8 })).toEqual([
      turn('assistant', 'bbbb'),
      turn('user', 'cccc'),
    ]);
    expect(buildChatHistory(turns, { maxMessageChars: 2 })).toEqual([
      turn('user', 'aa'),
      turn('assistant', 'bb'),
      turn('user', 'cc'),
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(buildChatHistory([])).toEqual([]);
  });
});
