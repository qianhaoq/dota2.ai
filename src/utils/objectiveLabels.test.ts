import { describe, it, expect } from 'vitest';
import { formatObjectiveLabel } from '../../lib/matchReview/objectiveLabels.js';

describe('formatObjectiveLabel', () => {
  it('localizes first blood and roshan in Chinese', () => {
    expect(formatObjectiveLabel({ type: 'CHAT_MESSAGE_FIRSTBLOOD' }, 'zh')).toBe('一血');
    expect(formatObjectiveLabel({ type: 'CHAT_MESSAGE_ROSHAN_KILL' }, 'zh')).toBe('肉山');
  });

  it('localizes building kills in Chinese', () => {
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_badguys_tower1_top',
    }, 'zh')).toBe('上路一塔');
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_goodguys_fort',
    }, 'zh')).toBe('天辉基地');
  });

  it('keeps English labels for en', () => {
    expect(formatObjectiveLabel({ type: 'CHAT_MESSAGE_FIRSTBLOOD' }, 'en')).toBe('First Blood');
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_badguys_tower1_mid',
    }, 'en')).toBe('mid T1');
  });
});
