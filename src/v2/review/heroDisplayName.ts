import { STATIC_HEROES } from '../../../packages/review-engine/src/staticHeroes.js';

const heroes = Object.values(STATIC_HEROES);
const normalize = (name: string) => name.toLowerCase().replace(/^npc_dota_hero_/, '').replaceAll('_', ' ');
const byName = new Map(heroes.flatMap(hero =>
  [hero.internalSlug, hero.nameEn, hero.nameZh].map(name => [normalize(name), hero] as const),
));

/** Keep engine identifiers for requests/images; localize only visible labels. */
export function heroDisplayName(name: string, lang: 'en' | 'zh'): string {
  const hero = byName.get(normalize(name));
  return hero ? (lang === 'zh' ? hero.nameZh : hero.nameEn) : name;
}
