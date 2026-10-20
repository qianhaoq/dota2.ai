import staticHeroesData from '../data/static-heroes.json' with { type: 'json' };

/** @typedef {{ id: number, nameEn: string, nameZh: string, internalSlug: string, internalName: string }} StaticHero */

/** @type {Record<string, StaticHero>} */
export const STATIC_HEROES = staticHeroesData.heroes;
export const STATIC_HEROES_PATCH = staticHeroesData.patch;

/** @param {number | string} heroId */
export function getStaticHero(heroId) {
  return Object.hasOwn(STATIC_HEROES, heroId) ? STATIC_HEROES[heroId] : undefined;
}

export function staticHeroNamesCnMap() {
  return Object.fromEntries(Object.values(STATIC_HEROES).map(hero => [hero.id, { nameZh: hero.nameZh }]));
}

export function staticHeroConstantsMap() {
  return Object.fromEntries(Object.values(STATIC_HEROES).map(hero => [
    hero.internalName,
    { id: hero.id, name: hero.internalName, localized_name: hero.nameEn },
  ]));
}
