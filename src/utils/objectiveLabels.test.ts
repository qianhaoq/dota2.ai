import { describe, it, expect } from 'vitest';
import { formatObjectiveLabel } from '../../lib/matchReview/objectiveLabels.js';

describe('formatObjectiveLabel', () => {
  it('localizes building kills with the losing side and destroyer in Chinese', () => {
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_badguys_tower1_top',
    }, 'zh')).toBe('夜魇上路一塔被天辉摧毁');
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_goodguys_tower1_mid',
    }, 'zh')).toBe('天辉中路一塔被夜魇摧毁');
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_goodguys_fort',
    }, 'zh')).toBe('天辉基地被夜魇摧毁');
  });

  it('prefers the event killer team over the opposite-side default', () => {
    // team is the killer side: 2 = Radiant destroyer (a Radiant deny of its
    // own tower) — the killer field wins over the opposite-team inference.
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_goodguys_tower1_top',
      team: 2,
    }, 'en')).toBe('Radiant lost top T1 tower (destroyed by Radiant)');
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_badguys_tower1_top',
      team: 2,
    }, 'en')).toBe('Dire lost top T1 tower (destroyed by Radiant)');
  });

  it('names tower tiers unambiguously (T2 is not high ground)', () => {
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_goodguys_tower2_bot',
    }, 'en')).toBe('Radiant lost bot T2 tower (destroyed by Dire)');
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_goodguys_tower2_bot',
    }, 'en')).not.toContain('high ground');
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_goodguys_tower3_mid',
    }, 'en')).toBe('Radiant lost mid T3 tower (high ground, destroyed by Dire)');
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_goodguys_tower3_mid',
    }, 'zh')).toBe('天辉中路高地三塔被夜魇摧毁');
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_goodguys_tower4',
    }, 'en')).toBe('Radiant lost T4 base tower (destroyed by Dire)');
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_goodguys_tower4',
    }, 'zh')).toBe('天辉基地四塔被夜魇摧毁');
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_goodguys_melee_rax_top',
    }, 'en')).toBe('Radiant lost top melee barracks (high ground, destroyed by Dire)');
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_goodguys_range_rax_top',
    }, 'zh')).toBe('天辉上路高地远程兵营被夜魇摧毁');
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
    }, 'en')).toBe('Dire lost mid T1 tower (destroyed by Radiant)');
    expect(formatObjectiveLabel({
      type: 'building_kill',
      key: 'npc_dota_goodguys_tower2_bot',
    }, 'en')).toBe('Radiant lost bot T2 tower (destroyed by Dire)');
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
