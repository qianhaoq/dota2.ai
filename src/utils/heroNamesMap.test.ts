import { describe, it, expect } from 'vitest';
import { buildHeroNamesMap, resolveHeroEnglishName, internalSlugFromInternalName } from '../../lib/matchReview/heroNamesMap.js';

const HERO_NAMES_CN = {
  1: { nameZh: '敌法师' },
  123: { nameZh: '森海飞霞' },
};

const HERO_CONSTANTS = {
  npc_dota_hero_antimage: {
    id: 1,
    name: 'npc_dota_hero_antimage',
    localized_name: 'Anti-Mage',
  },
  npc_dota_hero_hoodwink: {
    id: 123,
    name: 'npc_dota_hero_hoodwink',
    localized_name: 'Hoodwink',
  },
};

describe('heroNamesMap', () => {
  it('resolves English names from hero constants', () => {
    expect(resolveHeroEnglishName(1, HERO_CONSTANTS)).toBe('Anti-Mage');
  });

  it('keeps Chinese and English separate when heroStats is empty', () => {
    const map = buildHeroNamesMap({}, [{ hero_id: 1 }], HERO_CONSTANTS, HERO_NAMES_CN) as Record<number, { nameZh: string; nameEn: string }>;
    expect(map[1]?.nameZh).toBe('敌法师');
    expect(map[1]?.nameEn).toBe('Anti-Mage');
    expect(map[1]?.nameEn).not.toBe(map[1]?.nameZh);
  });

  it('falls back to heroStats internalName when constants are missing', () => {
    const stats = {
      11: {
        id: 11,
        name: 'Shadow Fiend',
        internalName: 'npc_dota_hero_nevermore',
        localized_name: 'Shadow Fiend',
      },
    };
    const map = buildHeroNamesMap(stats, [], {}, { 11: { nameZh: '影魔' } }) as Record<number, { internalSlug?: string }>;
    expect(map[11]?.internalSlug).toBe('nevermore');
    expect(internalSlugFromInternalName('npc_dota_hero_nevermore')).toBe('nevermore');
  });
});
