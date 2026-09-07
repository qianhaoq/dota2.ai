import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  clearStreamingCoachMessages,
  coachCancelledMessage,
  coachFetchTimeoutMessage,
  createTimeoutAbort,
  awaitWithTimeout,
} from './coachInflight';
import type { CoachMessage } from '../components/coach/coachMessage';

describe('coachInflight', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('createTimeoutAbort aborts after the deadline', async () => {
    vi.useFakeTimers();
    const { signal, clear } = createTimeoutAbort(1000);
    vi.advanceTimersByTime(1001);
    expect(signal.aborted).toBe(true);
    clear();
  });

  it('createTimeoutAbort clear prevents abort', async () => {
    vi.useFakeTimers();
    const { signal, clear } = createTimeoutAbort(1000);
    clear();
    vi.advanceTimersByTime(2000);
    expect(signal.aborted).toBe(false);
  });

  it('clearStreamingCoachMessages stops streaming and sets cancel error when empty', () => {
    const messages: CoachMessage[] = [
      { id: 'a', type: 'coach', content: '', isStreaming: true, action: 'meta' },
      { id: 'b', type: 'coach', content: 'done', isStreaming: false },
    ];
    const out = clearStreamingCoachMessages(messages, coachCancelledMessage('zh'));
    expect(out[0].isStreaming).toBe(false);
    expect(out[0].error).toBe('已停止');
    expect(out[1]).toBe(messages[1]);
  });

  it('clearStreamingCoachMessages leaves messages with content unchanged aside from flag', () => {
    const messages: CoachMessage[] = [
      { id: 'a', type: 'coach', content: 'partial', isStreaming: true },
    ];
    const out = clearStreamingCoachMessages(messages, coachCancelledMessage('en'));
    expect(out[0].isStreaming).toBe(false);
    expect(out[0].error).toBeUndefined();
    expect(out[0].content).toBe('partial');
  });

  it('exposes bilingual timeout copy', () => {
    expect(coachFetchTimeoutMessage('zh')).toContain('超时');
    expect(coachFetchTimeoutMessage('en')).toMatch(/timed out/i);
  });

  it('awaitWithTimeout rejects when the deadline passes', async () => {
    vi.useFakeTimers();
    const pending = awaitWithTimeout(new Promise<string>(() => {}), 500);
    const assertion = expect(pending).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(501);
    await assertion;
  });
});
