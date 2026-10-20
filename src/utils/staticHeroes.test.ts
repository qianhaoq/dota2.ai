import { describe, expect, it } from 'vitest';
import {
  STATIC_HEROES,
  STATIC_HEROES_PATCH,
  getStaticHero,
  staticHeroConstantsMap,
  staticHeroNamesCnMap,
  buildHeroNamesMap,
} from '@dota2ai/review-engine';

describe('static hero metadata', () => {
  it('bundles a patch-tagged roster and looks up names and internal identifiers', () => {
    expect(Object.keys(STATIC_HEROES).length).toBeGreaterThanOrEqual(120);
    expect(STATIC_HEROES_PATCH).toBe('7.41');
    expect(getStaticHero(54)).toMatchObject({
      id: 54, nameEn: 'Lifestealer', nameZh: '噬魂鬼',
      internalSlug: 'life_stealer', internalName: 'npc_dota_hero_life_stealer',
    });
    expect(getStaticHero('54')).toEqual(getStaticHero(54));
    expect(getStaticHero(-1)).toBeUndefined();
    expect(getStaticHero('toString')).toBeUndefined();
    expect(staticHeroNamesCnMap()[54]).toEqual({ nameZh: '噬魂鬼' });
    expect(staticHeroConstantsMap().npc_dota_hero_life_stealer).toEqual({
      id: 54, name: 'npc_dota_hero_life_stealer', localized_name: 'Lifestealer',
    });
  });

  it('fills missing match hero metadata without live maps', () => {
    const map = buildHeroNamesMap({}, [{ hero_id: 54 }, { hero_id: 104 }, { hero_id: 9999 }]);
    expect(map[54]).toEqual({
      nameEn: 'Lifestealer', nameZh: '噬魂鬼', internalSlug: 'life_stealer',
    });
    expect(map[104]).toEqual({
      nameEn: 'Legion Commander', nameZh: '军团指挥官', internalSlug: 'legion_commander',
    });
    expect(map[9999]).toEqual({
      nameEn: 'Hero#9999', nameZh: 'Hero#9999', internalSlug: null,
    });
  });

  it('prefers live names and slugs over the bundled fallback', () => {
    const map = buildHeroNamesMap(
      { 54: { name: 'Live English', internalName: 'npc_dota_hero_live_stats' } },
      [{ hero_id: 54 }],
      { live: { id: 54, localized_name: 'Live constant', name: 'npc_dota_hero_live_constant' } },
      { 54: { nameZh: '实时中文' } },
    );
    expect(map[54]).toEqual({
      nameEn: 'Live English', nameZh: '实时中文', internalSlug: 'live_constant',
    });
    const statsOnly = buildHeroNamesMap(
      { 54: { name: 'Stats English', localized_name: 'Stats localized', internalName: 'npc_dota_hero_live_stats' } },
      [], {}, { 54: { nameZh: '实时中文' } },
    );
    expect(statsOnly[54]).toEqual({
      nameEn: 'Stats English', nameZh: '实时中文', internalSlug: 'live_stats',
    });
  });
});
