import staticHeroesData from '../data/static-heroes.json' with { type: 'json' };

/** @typedef {{ id: number, nameEn: string, nameZh: string, internalSlug: string, internalName: string }} StaticHero */

/** @type {Record<string, StaticHero>} */
export const STATIC_HEROES = staticHeroesData.heroes;
export const STATIC_HEROES_PATCH = staticHeroesData.patch;

/** @param {number | string} heroId */
export function getStaticHero(heroId) {
  return Object.hasOwn(STATIC_HEROES, heroId) ? STATIC_HEROES[heroId] : undefined;
}

const squash = (s) => String(s ?? '').toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[^a-z0-9]/g, '');
const BY_SLUG = new Map(Object.values(STATIC_HEROES).map((hero) => [hero.internalSlug, hero]));
// A replay names a hero by its entity class ("queen_of_pain", "anti_mage", "vengeful_spirit"), which is the
// internal name with the words split: the same letters. Matched with the underscores left out, then by the
// English name ("zeus" for zuus). No two heroes share a squashed key.
const BY_SQUASHED = new Map();
for (const hero of Object.values(STATIC_HEROES)) for (const key of [hero.nameEn, hero.internalSlug]) if (key) BY_SQUASHED.set(squash(key), hero);

/**
 * The hero a key means: the internal slug ("queenofpain"), the key a replay trace uses for it
 * ("queen_of_pain"), the internal name ("npc_dota_hero_queenofpain") or the English name. Null when it is none.
 * @param {string | null | undefined} key
 */
export function heroByKey(key) {
  if (typeof key !== 'string' || !key) return null;
  return BY_SLUG.get(key) ?? BY_SQUASHED.get(squash(key)) ?? null;
}
/** A Map-like view of heroByKey, for code written against a map of slugs. */
export const HEROES_BY_KEY = Object.freeze({ get: (key) => heroByKey(key) ?? undefined, has: (key) => heroByKey(key) != null, keys: () => BY_SLUG.keys() });

export function staticHeroNamesCnMap() {
  return Object.fromEntries(Object.values(STATIC_HEROES).map(hero => [hero.id, { nameZh: hero.nameZh }]));
}

export function staticHeroConstantsMap() {
  return Object.fromEntries(Object.values(STATIC_HEROES).map(hero => [
    hero.internalName,
    { id: hero.id, name: hero.internalName, localized_name: hero.nameEn },
  ]));
}
