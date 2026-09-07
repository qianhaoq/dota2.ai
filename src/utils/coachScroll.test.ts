import { describe, it, expect } from 'vitest';
import {
  isScrollPinnedNearBottom,
  shouldAutoScrollCoachTimeline,
  streamingSessionFingerprint,
} from './coachScroll';
import type { CoachSession } from '../components/coach/coachMessage';

const streamingSession = (id: string, content: string): CoachSession => ({
  id,
  message: { id, type: 'coach', content, isStreaming: true },
  blocks: [],
});

describe('isScrollPinnedNearBottom', () => {
  it('returns true when within threshold of bottom', () => {
    expect(isScrollPinnedNearBottom(880, 1000, 100, 120)).toBe(true);
  });

  it('returns false when user scrolled up', () => {
    expect(isScrollPinnedNearBottom(100, 1000, 100, 120)).toBe(false);
  });
});

describe('streamingSessionFingerprint', () => {
  it('returns empty for non-streaming sessions', () => {
    expect(streamingSessionFingerprint({
      id: 'c1',
      message: { id: 'c1', type: 'coach', content: 'done' },
      blocks: [],
    })).toBe('');
  });

  it('changes as streamed content grows', () => {
    const a = streamingSessionFingerprint(streamingSession('c1', 'a'));
    const b = streamingSessionFingerprint(streamingSession('c1', 'ab'));
    expect(a).not.toBe(b);
  });
});

describe('shouldAutoScrollCoachTimeline', () => {
  it('scrolls when a new visible session is added', () => {
    expect(shouldAutoScrollCoachTimeline({
      visibleCount: 2,
      prevVisibleCount: 1,
      streamingFingerprint: '',
      prevStreamingFingerprint: '',
      pinnedNearBottom: false,
    })).toBe(true);
  });

  it('scrolls on stream chunks only when pinned near bottom', () => {
    expect(shouldAutoScrollCoachTimeline({
      visibleCount: 1,
      prevVisibleCount: 1,
      streamingFingerprint: 'c1:10:0:0:0:0',
      prevStreamingFingerprint: 'c1:5:0:0:0:0',
      pinnedNearBottom: true,
    })).toBe(true);

    expect(shouldAutoScrollCoachTimeline({
      visibleCount: 1,
      prevVisibleCount: 1,
      streamingFingerprint: 'c1:10:0:0:0:0',
      prevStreamingFingerprint: 'c1:5:0:0:0:0',
      pinnedNearBottom: false,
    })).toBe(false);
  });

  it('does not scroll when fingerprint is unchanged', () => {
    expect(shouldAutoScrollCoachTimeline({
      visibleCount: 1,
      prevVisibleCount: 1,
      streamingFingerprint: 'c1:5:0:0:0:0',
      prevStreamingFingerprint: 'c1:5:0:0:0:0',
      pinnedNearBottom: true,
    })).toBe(false);
  });
});
