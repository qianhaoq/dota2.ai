import { describe, it, expect } from 'vitest';
import { messageToBlocks, parseMarkdownSections, pairCoachSessions, sessionTitle } from './coachBlocks';
import type { CoachMessage } from '../components/coach/coachMessage';
import { appendStreamChunk } from './streamAccumulator';

const baseCoach = (over: Partial<CoachMessage> = {}): CoachMessage => ({
  id: 'c1',
  type: 'coach',
  content: '',
  ...over,
});

describe('parseMarkdownSections', () => {
  it('returns empty for blank content', () => {
    expect(parseMarkdownSections('')).toEqual([]);
    expect(parseMarkdownSections('   \n')).toEqual([]);
  });

  it('keeps untitled body as one section', () => {
    expect(parseMarkdownSections('先抓斧王的节奏。')).toEqual([
      { title: undefined, markdown: '先抓斧王的节奏。' },
    ]);
  });

  it('splits ## 分析思路 / ## 结论 into inspectable sections', () => {
    const text = '## 分析思路\n先看对线。\n\n## 结论\n中期抱团。';
    expect(parseMarkdownSections(text)).toEqual([
      { title: '分析思路', markdown: '先看对线。' },
      { title: '结论', markdown: '中期抱团。' },
    ]);
  });

  it('keeps preamble before the first heading', () => {
    const text = '一句话摘要。\n## 结论\n打高地。';
    expect(parseMarkdownSections(text)).toEqual([
      { title: undefined, markdown: '一句话摘要。' },
      { title: '结论', markdown: '打高地。' },
    ]);
  });
});

describe('messageToBlocks', () => {
  it('maps streaming markdown without headings to a single analysis block', () => {
    const blocks = messageToBlocks(baseCoach({ content: '正在看 OpenDota…' }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('section');
    expect(blocks[0].title).toBe('分析');
    expect(blocks[0].markdown).toBe('正在看 OpenDota…');
  });

  it('emits section cards for 分析思路 and 结论', () => {
    const blocks = messageToBlocks(baseCoach({
      action: 'analyze',
      content: '## 分析思路\n对线压制。\n## 结论\n4 号位游走。',
    }));
    expect(blocks.map((b) => b.type)).toEqual(['section', 'section']);
    expect(blocks.map((b) => b.title)).toEqual(['分析思路', '结论']);
  });

  it('maps matchup payload to a matchups block', () => {
    const blocks = messageToBlocks(baseCoach({
      matchupData: {
        grounded: true,
        radiantAdvantages: [{ hero: 'Axe', vsHero: 'PA', advantage: 4.2, winRate: '54', games: 10 }],
        direAdvantages: [],
      },
    }));
    expect(blocks[0].type).toBe('matchups');
    expect(blocks[0].title).toBe('对位优势');
  });

  it('maps suggestions to actions and tier list to tier', () => {
    const blocks = messageToBlocks(baseCoach({
      suggestions: [{
        id: 2,
        name: 'Axe',
        nameZh: '斧王',
        score: '1',
        winRate: '52',
        roles: ['Initiator'],
        rolesZh: ['先手'],
        bestAdvantage: '6.1',
        reasons: [],
      }],
      tierHeroes: [{
        id: 2,
        name: 'Axe',
        nameZh: '斧王',
        nameEn: 'Axe',
        shortName: 'axe',
        winRate: 53.1,
        pickRate: 12,
        gamesPlayed: 100,
        roles: ['Initiator'],
        img: '',
        icon: '',
        rank: 1,
        tier: 'S',
      }],
    }));
    expect(blocks.map((b) => b.type)).toEqual(['actions', 'tier']);
    expect(blocks[0].actions?.[0]).toMatchObject({ label: '斧王', heroId: 2, meta: '+6.1%' });
  });

  it('maps playbook data onto a section card', () => {
    const blocks = messageToBlocks(baseCoach({
      playbookData: [{
        heroId: 2,
        heroName: 'Axe',
        nameZh: '斧王',
        winRate: '54.0',
        roles: ['Initiator'],
        items: { startGame: [], earlyGame: [], midGame: [], lateGame: [] },
        vsEnemies: [],
      }],
    }));
    expect(blocks[0].type).toBe('section');
    expect(blocks[0].title).toBe('出装剧本');
    expect(blocks[0].playbook).toHaveLength(1);
  });

  it('returns no blocks for an empty streaming placeholder', () => {
    expect(messageToBlocks(baseCoach({ isStreaming: true, content: '' }))).toEqual([]);
  });

  it('drops a short caption when a structured tier block already exists', () => {
    const blocks = messageToBlocks(baseCoach({
      content: '当前版本强势英雄榜：',
      tierHeroes: [{
        id: 2, name: 'Axe', nameZh: '斧王', nameEn: 'Axe', shortName: 'axe',
        winRate: 53, pickRate: 12, gamesPlayed: 100, roles: [], img: '', icon: '', rank: 1, tier: 'S',
      }],
    }));
    expect(blocks.map((b) => b.type)).toEqual(['tier']);
  });

  it('shows localized fallback when review lanes are empty', () => {
    const blocks = messageToBlocks(baseCoach({
      action: 'review',
      matchFact: {
        summary: {
          matchId: 1,
          duration: 2400,
          durationFormatted: '40:00',
          radiantWin: true,
          winner: 'radiant',
          winnerLabelZh: '天辉胜利',
          winnerLabelEn: 'Radiant Victory',
        },
        players: [],
        lanes: [],
        laneInferenceLabelZh: '根据录像站位推断',
        laneInferenceLabelEn: 'Inferred from replay positioning',
        laneSource: 'lane_pos_unavailable',
        laneDataAvailable: false,
        economy: { radiantGoldAdv: [], checkpoints: [] },
        timeline: [],
        focusHeroId: null,
        focusLens: null,
        focusLaneGrounded: true,
        grounded: false,
      },
    }), 'zh');
    const lanes = blocks.find((b) => b.reviewSection === 'lanes');
    expect(lanes?.markdown).toContain('暂无可用录像站位数据');
    expect(lanes?.markdown).not.toBe('');
  });

  it('returns no blocks when review message has an error', () => {
    const blocks = messageToBlocks(baseCoach({
      action: 'review',
      error: 'DeepSeek API Key 未配置',
      matchFact: null,
    }));
    expect(blocks).toEqual([]);
  });

  it('does not leak inline markdown asterisks in review POV (en)', () => {
    const blocks = messageToBlocks(baseCoach({
      action: 'review',
      matchFact: {
        summary: {
          matchId: 8985182860,
          duration: 2400,
          durationFormatted: '40:00',
          radiantWin: true,
          winner: 'radiant',
          winnerLabelZh: '天辉胜利',
          winnerLabelEn: 'Radiant Victory',
        },
        players: [],
        lanes: [],
        laneInferenceLabelZh: '根据录像站位推断',
        laneInferenceLabelEn: 'Inferred from replay positioning',
        laneSource: 'lane_pos_cluster',
        laneDataAvailable: true,
        economy: { radiantGoldAdv: [], checkpoints: [] },
        timeline: [],
        focusHeroId: 54,
        focusLens: {
          heroId: 54,
          displayName: 'Lifestealer',
          kda: '2/1/3',
          gpm: 400,
          netWorth: 12000,
          lane: 'bot',
          laneLabel: 'Bot',
          laneGrounded: true,
          opponents: [{ heroId: 2, displayName: 'Axe', kda: '1/2/0' }],
          nearby: [{ heroId: 71, displayName: 'Spirit Breaker' }],
          earlyKills: [],
          keyTimeline: [],
          laneSource: 'lane_pos_cluster',
          laneConfidence: 'high',
        },
        focusLaneGrounded: true,
        grounded: true,
      },
    }), 'en');
    const pov = blocks.find((b) => b.reviewSection === 'pov');
    expect(pov?.markdown).toContain('Nearby: Spirit Breaker');
    expect(pov?.markdown).not.toContain('**');
  });

  it('localizes Chinese timeline objective labels', () => {
    const blocks = messageToBlocks(baseCoach({
      action: 'review',
      matchFact: {
        summary: {
          matchId: 8985182860,
          duration: 2400,
          durationFormatted: '40:00',
          radiantWin: false,
          winner: 'dire',
          winnerLabelZh: '夜魇胜利',
          winnerLabelEn: 'Dire Victory',
        },
        players: [],
        lanes: [],
        laneInferenceLabelZh: '根据录像站位推断',
        laneInferenceLabelEn: 'Inferred from replay positioning',
        laneSource: 'lane_pos_cluster',
        laneDataAvailable: true,
        economy: { radiantGoldAdv: [], checkpoints: [] },
        timeline: [
          { time: 48, type: 'CHAT_MESSAGE_FIRSTBLOOD', key: '5' },
          { time: 563, type: 'building_kill', key: 'npc_dota_badguys_tower1_top' },
          { time: 2053, type: 'CHAT_MESSAGE_ROSHAN_KILL', key: null, team: 3 },
        ],
        focusHeroId: null,
        focusLens: null,
        focusLaneGrounded: true,
        grounded: true,
      },
    }), 'zh');
    const timeline = blocks.find((b) => b.reviewSection === 'timeline');
    expect(timeline?.markdown).toContain('一血');
    expect(timeline?.markdown).toContain('夜魇上路一塔');
    expect(timeline?.markdown).toContain('夜魇肉山');
    expect(timeline?.markdown).not.toContain('CHAT_MESSAGE_');
    expect(timeline?.markdown).not.toContain('building_kill');
  });
});

describe('pairCoachSessions', () => {
  it('pairs a user prompt with the following coach result', () => {
    const sessions = pairCoachSessions([
      { id: 'u1', type: 'user', action: 'meta', content: '当前版本哪些英雄强势？' },
      { id: 'c1', type: 'coach', action: 'meta', content: '当前版本强势英雄榜：', tierHeroes: [] },
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].query).toBe('当前版本哪些英雄强势？');
    expect(sessions[0].action).toBe('meta');
    expect(sessionTitle(sessions[0], 'zh')).toBe('当前版本哪些英雄强势？');
  });

  it('keeps coach-only notices as their own session', () => {
    const sessions = pairCoachSessions([
      { id: 'c1', type: 'coach', content: '请先选择英雄' },
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].query).toBeUndefined();
    expect(sessionTitle(sessions[0], 'zh')).toBe('教练结果');
  });
});

describe('streaming append still feeds A2UI sections', () => {
  it('rebuilds 分析思路 / 结论 cards as chunks accumulate', () => {
    let messages: CoachMessage[] = [baseCoach({ id: 'stream', content: '', isStreaming: true })];
    const chunks = ['## ', '分析思路', '\n先看对线。\n', '## 结论', '\n抱团推进。'];

    for (const chunk of chunks) {
      messages = appendStreamChunk(messages, 'stream', chunk);
    }

    const blocks = messageToBlocks(messages[0]);
    expect(messages[0].content).toBe('## 分析思路\n先看对线。\n## 结论\n抱团推进。');
    expect(blocks.map((b) => b.title)).toEqual(['分析思路', '结论']);
  });
});
