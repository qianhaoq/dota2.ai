import { describe, it, expect } from 'vitest';
import { heroDisplayName } from './heroDisplayName';

describe('heroDisplayName', () => {
  it('formats non-hero killers without leaking npc_dota_ names', () => {
    expect(heroDisplayName('npc_dota_neutral_satyr_trickster', 'en')).toBe('Neutral creep');
    expect(heroDisplayName('npc_dota_neutral_satyr_trickster', 'zh')).toBe('中立生物');
    expect(heroDisplayName('npc_dota_wraith_king_skeleton_warrior', 'en')).toBe('Wraith King skeleton');
    expect(heroDisplayName('npc_dota_badguys_tower1_mid', 'en')).toMatch(/Dire.*T1.*tower/);
    expect(heroDisplayName('npc_dota_badguys_tower1_mid', 'en')).not.toMatch(/npc_dota_|destroyed by/);
    expect(heroDisplayName('npc_dota_badguys_tower1_mid', 'zh')).not.toMatch(/被.*摧毁/);
    expect(heroDisplayName('npc_dota_hero_slark', 'en')).toBe('Slark');
    expect(heroDisplayName('skeleton_king', 'en')).toBe('Wraith King');
  });
});
