import { describe, it, expect } from 'vitest';
import {
  buildConclusionCards,
  conclusionHeading,
  getPresetFollowUps,
  CONCLUSION_ORDER,
} from './reviewConclusions';
import type { ThreeConclusions } from '../types/matchReview';

const OK_CONCLUSIONS: ThreeConclusions = {
  turningPoint: {
    status: 'ok',
    title: 'backend title — never rendered',
    summary: 'The 18-minute Roshan fight flipped a 4k lead.',
    evidence: [
      { time: '18:24', text: 'Lost 4 heroes at Roshan', source: 'timeline' },
      { time: '19:02', text: 'Net worth swing -6k', source: 'advantage' },
    ],
  },
  topMistake: {
    status: 'ok',
    title: 'x',
    summary: 'You died three times farming without vision.',
    evidence: [{ time: null, text: 'Deaths at 12:10 / 15:44 / 21:03', source: 'deaths' }],
  },
  nextGameRule: {
    status: 'ok',
    title: 'x',
    summary: 'Ward the enemy triangle before taking their safelane tower.',
    evidence: [],
  },
  followUps: ['Why was Roshan the turning point?', 'How do I ward the triangle?'],
};

describe('conclusionHeading', () => {
  it('uses the fixed frontend labels, localized', () => {
    expect(conclusionHeading('turningPoint', 'en')).toBe('Turning point');
    expect(conclusionHeading('topMistake', 'en')).toBe('The one thing to fix');
    expect(conclusionHeading('nextGameRule', 'en')).toBe('Do this next game');
    expect(conclusionHeading('turningPoint', 'zh')).toBe('转折点');
    expect(conclusionHeading('topMistake', 'zh')).toBe('你这局最该改的一件事');
    expect(conclusionHeading('nextGameRule', 'zh')).toBe('下一局照做的一条');
  });
});

describe('buildConclusionCards', () => {
  it('returns null when the payload is missing (old server response → fallback layout)', () => {
    expect(buildConclusionCards(undefined, 'en')).toBeNull();
    expect(buildConclusionCards(null, 'en')).toBeNull();
    expect(buildConclusionCards({} as ThreeConclusions, 'en')).toBeNull();
  });

  it('builds exactly three cards in the fixed order with frontend headings', () => {
    const cards = buildConclusionCards(OK_CONCLUSIONS, 'en');
    expect(cards).toHaveLength(3);
    expect(cards!.map((c) => c.key)).toEqual(CONCLUSION_ORDER);
    expect(cards!.map((c) => c.heading)).toEqual([
      'Turning point',
      'The one thing to fix',
      'Do this next game',
    ]);
    // backend `title` must never leak into the view-model
    expect(JSON.stringify(cards)).not.toContain('backend title');
  });

  it('keeps valid evidence, ordered, with timestamps and sources', () => {
    const cards = buildConclusionCards(OK_CONCLUSIONS, 'en');
    expect(cards![0].evidence).toEqual([
      { time: '18:24', text: 'Lost 4 heroes at Roshan', source: 'timeline' },
      { time: '19:02', text: 'Net worth swing -6k', source: 'advantage' },
    ]);
  });

  it('renders a conclusion with status insufficient as an explicit insufficient card', () => {
    const payload: ThreeConclusions = {
      ...OK_CONCLUSIONS,
      topMistake: { status: 'insufficient', title: '', summary: 'Not enough parsed data.', evidence: [] },
    };
    const cards = buildConclusionCards(payload, 'en')!;
    expect(cards[1].status).toBe('insufficient');
    expect(cards[1].summary).toBe('Not enough parsed data.');
    expect(cards[0].status).toBe('ok');
  });

  it('fills a missing conclusion with a localized insufficient placeholder instead of dropping it', () => {
    const payload = {
      ...OK_CONCLUSIONS,
      nextGameRule: undefined,
    } as unknown as ThreeConclusions;
    const en = buildConclusionCards(payload, 'en')!;
    expect(en).toHaveLength(3);
    expect(en[2]).toEqual({
      key: 'nextGameRule',
      heading: 'Do this next game',
      status: 'insufficient',
      summary: 'Insufficient data',
      evidence: [],
    });
    const zh = buildConclusionCards(payload, 'zh')!;
    expect(zh[2].summary).toBe('数据不足');
  });

  it('treats an empty/blank summary as missing even when status says ok', () => {
    const payload: ThreeConclusions = {
      ...OK_CONCLUSIONS,
      turningPoint: { status: 'ok', title: 't', summary: '   ', evidence: [] },
    };
    const cards = buildConclusionCards(payload, 'en')!;
    expect(cards[0].status).toBe('insufficient');
  });

  it('returns null when no conclusion has a usable summary', () => {
    const payload: ThreeConclusions = {
      turningPoint: { status: 'insufficient', title: '', summary: '', evidence: [] },
      topMistake: { status: 'insufficient', title: '', summary: '  ', evidence: [] },
      nextGameRule: { status: 'insufficient', title: '', summary: '', evidence: [] },
      followUps: [],
    };
    expect(buildConclusionCards(payload, 'en')).toBeNull();
  });

  it('drops malformed evidence entries but keeps valid ones', () => {
    const payload = {
      ...OK_CONCLUSIONS,
      turningPoint: {
        status: 'ok',
        title: 't',
        summary: 's',
        evidence: [
          { time: '10:00', text: 'ok entry', source: 'timeline' },
          { time: '11:00', text: '', source: 'timeline' },
          { text: 42 },
          null,
          'not-an-object',
        ],
      },
    } as unknown as ThreeConclusions;
    const cards = buildConclusionCards(payload, 'en')!;
    expect(cards[0].evidence).toEqual([
      { time: '10:00', text: 'ok entry', source: 'timeline' },
    ]);
  });
});

describe('getPresetFollowUps', () => {
  it('returns up to 3 non-blank questions', () => {
    expect(getPresetFollowUps(OK_CONCLUSIONS)).toEqual([
      'Why was Roshan the turning point?',
      'How do I ward the triangle?',
    ]);
    const many: ThreeConclusions = {
      ...OK_CONCLUSIONS,
      followUps: ['a', ' ', 'b', 'c', 'd', 7 as unknown as string],
    };
    expect(getPresetFollowUps(many)).toEqual(['a', 'b', 'c']);
  });

  it('returns empty when the payload or followUps is missing', () => {
    expect(getPresetFollowUps(null)).toEqual([]);
    expect(getPresetFollowUps(undefined)).toEqual([]);
    expect(getPresetFollowUps({} as ThreeConclusions)).toEqual([]);
  });
});
