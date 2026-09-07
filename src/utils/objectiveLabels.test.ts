import { describe, it, expect } from 'vitest';
import { formatObjectiveLabel } from '../../lib/matchReview/objectiveLabels.js';

describe('formatObjectiveLabel', () => {
  it('localizes building kills with destroyed side in Chinese', () => {
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_badguys_tower1_top',
    }, 'zh')).toBe('夜魇上路一塔');
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_goodguys_tower1_mid',
    }, 'zh')).toBe('天辉中路一塔');
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_goodguys_fort',
    }, 'zh')).toBe('天辉基地');
  });

  it('localizes first blood and roshan kills in Chinese', () => {
    expect(formatObjectiveLabel({
      type: 'CHAT_MESSAGE_FIRSTBLOOD',
      team: 2,
      carrierName: '森海飞霞',
    }, 'zh')).toBe('天辉森海飞霞 一血');
    expect(formatObjectiveLabel({ type: 'CHAT_MESSAGE_ROSHAN_KILL', team: 2 }, 'zh')).toBe('天辉肉山');
    expect(formatObjectiveLabel({ type: 'CHAT_MESSAGE_ROSHAN_KILL', team: 3 }, 'zh')).toBe('夜魇肉山');
  });

  it('keeps English labels with side for en', () => {
    expect(formatObjectiveLabel({
      type: 'CHAT_MESSAGE_FIRSTBLOOD',
      team: 2,
      carrierName: 'Hoodwink',
    }, 'en')).toBe('Radiant Hoodwink First Blood');
    expect(formatObjectiveLabel({ type: 'CHAT_MESSAGE_ROSHAN_KILL', team: 2 }, 'en')).toBe('Radiant Roshan');
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_badguys_tower1_mid',
    }, 'en')).toBe('Dire mid T1');
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_goodguys_tower2_bot',
    }, 'en')).toBe('Radiant bot T2');
  });

  it('labels Aegis pickup and steal with carrier and side', () => {
    expect(formatObjectiveLabel({
      type: 'CHAT_MESSAGE_AEGIS',
      team: 3,
      carrierName: '斯温',
      aegisStolen: false,
    }, 'zh')).toBe('夜魇斯温 拾取不朽之守护');
    expect(formatObjectiveLabel({
      type: 'CHAT_MESSAGE_AEGIS',
      team: 2,
      carrierName: '噬魂鬼',
      aegisStolen: true,
    }, 'zh')).toBe('天辉噬魂鬼 抢盾');
    expect(formatObjectiveLabel({
      type: 'CHAT_MESSAGE_AEGIS',
      team: 2,
      carrierName: 'Lifestealer',
      aegisStolen: false,
    }, 'en')).toBe('Radiant Lifestealer picks up Aegis');
    expect(formatObjectiveLabel({
      type: 'CHAT_MESSAGE_AEGIS',
      team: 3,
      carrierName: 'Sven',
      aegisStolen: true,
    }, 'en')).toBe('Dire Sven steals Aegis');
  });
});
