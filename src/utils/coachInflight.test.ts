import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  clearStreamingCoachMessages,
  coachCancelledMessage,
  coachFetchTimeoutMessage,
  createTimeoutAbort,
  awaitWithTimeout,
  claimCoachInflightGeneration,
  finalizeReviewCoachMessage,
  invalidateCoachInflightGeneration,
  isCoachInflightCurrent,
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

  it('clearStreamingCoachMessages keeps review cards visible when cancelled mid-stream', () => {
    const messages: CoachMessage[] = [
      {
        id: 'a',
        type: 'coach',
        action: 'review',
        content: '',
        isStreaming: true,
        matchFact: { summary: { matchId: 1 } } as CoachMessage['matchFact'],
        reviewCards: {
          match_summary: { matchId: 1, heroName: '噬魂鬼', kda: '1/2/3', gpm: 400, result: 'loss', resultLabel: '失败', durationFormatted: '40:00' },
          phases: [],
        },
      },
    ];
    const out = clearStreamingCoachMessages(messages, coachCancelledMessage('zh'));
    expect(out[0].isStreaming).toBe(false);
    expect(out[0].error).toBeUndefined();
    expect(out[0].reviewCards?.match_summary?.heroName).toBe('噬魂鬼');
  });

  it('clearStreamingCoachMessages keeps matchFact spine when cancelled before AI cards arrive', () => {
    const messages: CoachMessage[] = [
      {
        id: 'a',
        type: 'coach',
        action: 'review',
        content: '',
        isStreaming: true,
        matchFact: { summary: { matchId: 8985182860 } } as CoachMessage['matchFact'],
      },
    ];
    const out = clearStreamingCoachMessages(messages, coachCancelledMessage('en'));
    expect(out[0].isStreaming).toBe(false);
    expect(out[0].error).toBeUndefined();
    expect(out[0].matchFact?.summary?.matchId).toBe(8985182860);
  });

  it('finalizeReviewCoachMessage keeps review cards on client timeout error', () => {
    const msg: CoachMessage = {
      id: 'a',
      type: 'coach',
      action: 'review',
      content: '',
      isStreaming: true,
      matchFact: { summary: { matchId: 1 } } as CoachMessage['matchFact'],
      reviewCards: {
        match_summary: { matchId: 1, heroName: '噬魂鬼', kda: '1/2/3', gpm: 400, result: 'loss', resultLabel: '失败', durationFormatted: '40:00' },
        phases: [],
      },
    };
    const out = finalizeReviewCoachMessage(msg, { error: 'Request timed out, please try again' });
    expect(out.isStreaming).toBe(false);
    expect(out.error).toBeUndefined();
    expect(out.reviewCards?.match_summary?.heroName).toBe('噬魂鬼');
  });

  it('finalizeReviewCoachMessage still sets error when no structured review payload', () => {
    const msg: CoachMessage = {
      id: 'a',
      type: 'coach',
      action: 'review',
      content: '',
      isStreaming: true,
    };
    const out = finalizeReviewCoachMessage(msg, { error: 'Request timed out' });
    expect(out.error).toBe('Request timed out');
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

  describe('coach inflight generation guard', () => {
    it('invalidates captured generation on supersede', () => {
      const generationRef = { current: 0 };
      const first = claimCoachInflightGeneration(generationRef);
      invalidateCoachInflightGeneration(generationRef);
      const second = claimCoachInflightGeneration(generationRef);
      expect(isCoachInflightCurrent(generationRef, first)).toBe(false);
      expect(isCoachInflightCurrent(generationRef, second)).toBe(true);
    });

    it('aborted stream AbortError must not clear new stream loading state', () => {
      const generationRef = { current: 0 };
      let isLoading = false;
      let activeController: string | null = null;

      const finishStream = (streamGen: number) => {
        if (!isCoachInflightCurrent(generationRef, streamGen)) return;
        isLoading = false;
        activeController = null;
      };

      const startStream = (controllerId: string) => {
        invalidateCoachInflightGeneration(generationRef);
        isLoading = false;
        isLoading = true;
        const streamGen = claimCoachInflightGeneration(generationRef);
        activeController = controllerId;
        return streamGen;
      };

      const firstGen = startStream('stream-a');
      const secondGen = startStream('stream-b');

      expect(isLoading).toBe(true);
      expect(activeController).toBe('stream-b');

      // Stale AbortError from stream-a after stream-b started
      finishStream(firstGen);

      expect(isLoading).toBe(true);
      expect(activeController).toBe('stream-b');

      // Current stream completes normally
      finishStream(secondGen);

      expect(isLoading).toBe(false);
      expect(activeController).toBeNull();
    });
  });
});
