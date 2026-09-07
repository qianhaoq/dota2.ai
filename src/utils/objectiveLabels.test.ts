import { describe, it, expect } from 'vitest';
import { formatObjectiveLabel } from '../../lib/matchReview/objectiveLabels.js';

describe('formatObjectiveLabel', () => {
  it('localizes first blood and roshan killer side in Chinese', () => {
    expect(formatObjectiveLabel({ type: 'CHAT_MESSAGE_FIRSTBLOOD' }, 'zh')).toBe('一血');
    expect(formatObjectiveLabel({ type: 'CHAT_MESSAGE_ROSHAN_KILL', team: 3 }, 'zh')).toBe('夜魇肉山');
    expect(formatObjectiveLabel({ type: 'CHAT_MESSAGE_ROSHAN_KILL', team: 2 }, 'zh')).toBe('天辉肉山');
  });

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

  it('keeps English labels with side for en', () => {
    expect(formatObjectiveLabel({ type: 'CHAT_MESSAGE_FIRSTBLOOD' }, 'en')).toBe('First Blood');
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
});
