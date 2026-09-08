import { describe, it, expect } from 'vitest';
import {
  classifyTimelineVisibilityChange,
  isScrollPinnedNearBottom,
  scrollOffsetWithinContainer,
  shouldAutoScrollCoachTimeline,
  coachSessionScrollFingerprint,
  streamingSessionFingerprint,
} from './coachScroll';
import type { CoachSession } from '../components/coach/coachMessage';

const streamingSession = (id: string, content: string): CoachSession => ({
  id,
  message: { id, type: 'coach', content, isStreaming: true },
  blocks: [],
});

describe('scrollOffsetWithinContainer', () => {
  it('derives scroll top from bounding rects and current scrollTop', () => {
    const container = {
      scrollTop: 200,
      getBoundingClientRect: () => ({ top: 100 }),
    } as HTMLElement;
    const target = {
      getBoundingClientRect: () => ({ top: 250 }),
    } as HTMLElement;
    expect(scrollOffsetWithinContainer(container, target, 8)).toBe(342);
  });
});

describe('isScrollPinnedNearBottom', () => {
  it('returns true when within threshold of bottom', () => {
    expect(isScrollPinnedNearBottom(880, 1000, 100, 120)).toBe(true);
  });

  it('returns false when user scrolled up', () => {
    expect(isScrollPinnedNearBottom(100, 1000, 100, 120)).toBe(false);
  });

  it('would read unpinned after a large single expansion if measured post-commit', () => {
    // User was pinned at bottom (scrollTop 880, height 1000) before +500px content lands.
    const scrollTopBeforeGrowth = 880;
    const scrollHeightAfterGrowth = 1500;
    const clientHeight = 100;
    expect(isScrollPinnedNearBottom(scrollTopBeforeGrowth, scrollHeightAfterGrowth, clientHeight, 120)).toBe(false);
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

  it('changes when matchFact arrives during review stream', () => {
    const before = streamingSessionFingerprint({
      id: 'c1',
      message: { id: 'c1', type: 'coach', content: '', isStreaming: true },
      blocks: [],
    });
    const after = streamingSessionFingerprint({
      id: 'c1',
      message: {
        id: 'c1',
        type: 'coach',
        content: '',
        isStreaming: true,
        matchFact: { summary: { matchId: 1 } } as never,
      },
      blocks: [],
    });
    expect(before).not.toBe(after);
  });

  it('changes when AI insight cards replace deterministic review spine', () => {
    const spine = streamingSessionFingerprint({
      id: 'c1',
      message: {
        id: 'c1',
        type: 'coach',
        action: 'review',
        content: '',
        isStreaming: true,
        matchFact: { summary: { matchId: 1 } } as never,
        reviewCards: {
          match_summary: { matchId: 1, heroName: '噬魂鬼', kda: '1/2/3', gpm: 400, result: 'loss', resultLabel: '失败', durationFormatted: '40:00' },
          phases: [{ phase: 'lane', label: '对线', insight: '对线', evidence: [] }],
        },
      },
      blocks: [],
    });
    const withInsight = streamingSessionFingerprint({
      id: 'c1',
      message: {
        id: 'c1',
        type: 'coach',
        action: 'review',
        content: '',
        isStreaming: true,
        matchFact: { summary: { matchId: 1 } } as never,
        reviewCards: {
          match_summary: { matchId: 1, heroName: '噬魂鬼', kda: '1/2/3', gpm: 400, result: 'loss', resultLabel: '失败', durationFormatted: '40:00' },
          phases: [{ phase: 'lane', label: '对线', insight: '对线', evidence: [] }],
          primary_mistake: { category: 'fight_timing', categoryLabel: '团战时机', headline: '开团过早', explanation: '解释', evidence: [] },
          key_moments: [
            { timestamp: 48, timestampLabel: '0:48', phase: 'lane', headline: '一血', why: '原因', evidence: [] },
            { timestamp: 1310, timestampLabel: '21:50', phase: 'mid', headline: '推塔', why: '原因', evidence: [] },
            { timestamp: 2817, timestampLabel: '46:57', phase: 'late', headline: '肉山', why: '原因', evidence: [] },
          ],
          drill: { duration: '15 分钟', title: '练一件事', steps: ['步骤1'] },
        },
      },
      blocks: [],
    });
    expect(spine).not.toBe(withInsight);
  });

  it('detects review-card growth after stream completes in the same render batch', () => {
    const spineOnly = coachSessionScrollFingerprint({
      id: 'c1',
      message: {
        id: 'c1',
        type: 'coach',
        action: 'review',
        content: '',
        isStreaming: true,
        matchFact: { summary: { matchId: 1 } } as never,
        reviewCards: {
          match_summary: { matchId: 1, heroName: '噬魂鬼', kda: '1/2/3', gpm: 400, result: 'loss', resultLabel: '失败', durationFormatted: '40:00' },
          phases: [{ phase: 'lane', label: '对线', insight: '对线', evidence: [] }],
        },
      },
      blocks: [],
    });
    const completed = coachSessionScrollFingerprint({
      id: 'c1',
      message: {
        id: 'c1',
        type: 'coach',
        action: 'review',
        content: '',
        isStreaming: false,
        matchFact: { summary: { matchId: 1 } } as never,
        reviewCards: {
          match_summary: { matchId: 1, heroName: '噬魂鬼', kda: '1/2/3', gpm: 400, result: 'loss', resultLabel: '失败', durationFormatted: '40:00' },
          phases: [{ phase: 'lane', label: '对线', insight: '对线', evidence: [] }],
          primary_mistake: { category: 'fight_timing', categoryLabel: '团战时机', headline: '开团过早', explanation: '解释', evidence: [] },
          key_moments: [
            { timestamp: 48, timestampLabel: '0:48', phase: 'lane', headline: '一血', why: '原因', evidence: [] },
            { timestamp: 1310, timestampLabel: '21:50', phase: 'mid', headline: '推塔', why: '原因', evidence: [] },
            { timestamp: 2817, timestampLabel: '46:57', phase: 'late', headline: '肉山', why: '原因', evidence: [] },
          ],
          drill: { duration: '15 分钟', title: '练一件事', steps: ['步骤1'] },
        },
      },
      blocks: [],
    });
    expect(streamingSessionFingerprint({
      id: 'c1',
      message: {
        id: 'c1',
        type: 'coach',
        action: 'review',
        content: '',
        isStreaming: false,
        reviewCards: {
          phases: [],
          primary_mistake: { category: 'fight_timing', categoryLabel: '团战时机', headline: 'h', explanation: 'e', evidence: [] },
        },
      },
      blocks: [],
    })).toBe('');
    expect(spineOnly).not.toBe(completed);
  });
});

describe('classifyTimelineVisibilityChange', () => {
  it('detects append at tail when sessions array grows', () => {
    expect(classifyTimelineVisibilityChange(
      new Set(['c1']),
      ['c1'],
      ['c1', 'c2'],
      ['c1', 'c2'],
    )).toEqual({
      kind: 'append',
      newlyVisibleIds: ['c2'],
      scrollTargetId: 'c2',
    });
  });

  it('detects restore when undo makes an older session visible again', () => {
    expect(classifyTimelineVisibilityChange(
      new Set(['c1', 'c3']),
      ['c1', 'c2', 'c3'],
      ['c1', 'c2', 'c3'],
      ['c1', 'c2', 'c3'],
    )).toEqual({
      kind: 'restore',
      newlyVisibleIds: ['c2'],
      scrollTargetId: 'c2',
    });
  });

  it('returns none when visible set is unchanged', () => {
    expect(classifyTimelineVisibilityChange(
      new Set(['c1', 'c2']),
      ['c1', 'c2'],
      ['c1', 'c2'],
      ['c1', 'c2'],
    )).toEqual({
      kind: 'none',
      newlyVisibleIds: [],
      scrollTargetId: null,
    });
  });
});

describe('shouldAutoScrollCoachTimeline', () => {
  it('scrolls when a session is appended at the tail', () => {
    expect(shouldAutoScrollCoachTimeline({
      appendedAtTail: true,
      streamingFingerprint: '',
      prevStreamingFingerprint: '',
      pinnedNearBottom: false,
    })).toBe(true);
  });

  it('does not scroll to bottom when visibility restores via undo', () => {
    expect(shouldAutoScrollCoachTimeline({
      appendedAtTail: false,
      streamingFingerprint: '',
      prevStreamingFingerprint: '',
      pinnedNearBottom: true,
    })).toBe(false);
  });

  it('scrolls on stream chunks only when pinned snapshot is true', () => {
    expect(shouldAutoScrollCoachTimeline({
      appendedAtTail: false,
      streamingFingerprint: 'c1:10:0:0:0:1',
      prevStreamingFingerprint: 'c1:5:0:0:0:0',
      pinnedNearBottom: true,
    })).toBe(true);

    expect(shouldAutoScrollCoachTimeline({
      appendedAtTail: false,
      streamingFingerprint: 'c1:10:0:0:0:1',
      prevStreamingFingerprint: 'c1:5:0:0:0:0',
      pinnedNearBottom: false,
    })).toBe(false);
  });

  it('follows large single-step stream updates when user was pinned before DOM growth', () => {
    // Simulates matchFact onData: fingerprint jumps, pinned snapshot still true from scroll listener.
    expect(shouldAutoScrollCoachTimeline({
      appendedAtTail: false,
      streamingFingerprint: 'c1:0:0:0:0:1',
      prevStreamingFingerprint: 'c1:0:0:0:0:0',
      pinnedNearBottom: true,
    })).toBe(true);
  });

  it('does not scroll when fingerprint is unchanged', () => {
    expect(shouldAutoScrollCoachTimeline({
      appendedAtTail: false,
      streamingFingerprint: 'c1:5:0:0:0:0',
      prevStreamingFingerprint: 'c1:5:0:0:0:0',
      pinnedNearBottom: true,
    })).toBe(false);
  });
});
