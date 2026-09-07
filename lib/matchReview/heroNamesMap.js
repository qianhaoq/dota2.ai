/**
 * @param {number} heroId
 * @param {Record<string, { id?: number, localized_name?: string, name?: string }>} heroConstants
 */
export function resolveHeroEnglishName(heroId, heroConstants = {}) {
  const constant = Object.values(heroConstants).find((h) => h.id === heroId);
  if (constant?.localized_name) return constant.localized_name;
  if (constant?.name) {
    return constant.name
      .replace(/^npc_dota_hero_/, '')
      .replace(/_/g, ' ');
  }
  return `Hero#${heroId}`;
}

/**
 * @param {number} heroId
 * @param {Record<string, { id?: number, localized_name?: string, name?: string }>} heroConstants
 */
export function resolveHeroInternalSlug(heroId, heroConstants = {}) {
  const constant = Object.values(heroConstants).find((h) => h.id === heroId);
  if (constant?.name) {
    return constant.name.replace(/^npc_dota_hero_/, '');
  }
  return null;
}

/**
 * @param {string | null | undefined} internalName
 */
export function internalSlugFromInternalName(internalName) {
  if (!internalName || typeof internalName !== 'string') return null;
  const slug = internalName.replace(/^npc_dota_hero_/, '').trim();
  return slug || null;
}

/**
 * @param {Record<string, { name?: string, localized_name?: string }>} heroStats
 * @param {Array<{ hero_id?: number }>} matchPlayers
 * @param {Record<string, { id?: number, localized_name?: string, name?: string }>} heroConstants
 * @param {Record<number, { nameZh: string }>} heroNamesCn
 */
export function buildHeroNamesMap(heroStats, matchPlayers = [], heroConstants = {}, heroNamesCn = {}) {
  const map = {};

  for (const [id, cn] of Object.entries(heroNamesCn)) {
    const heroId = Number(id);
    map[heroId] = {
      nameZh: cn.nameZh,
      nameEn: resolveHeroEnglishName(heroId, heroConstants),
      internalSlug: resolveHeroInternalSlug(heroId, heroConstants),
    };
  }

  for (const [id, stats] of Object.entries(heroStats || {})) {
    const heroId = Number(id);
    const cn = heroNamesCn[heroId];
    const englishFromStats = stats?.name || stats?.localized_name;
    map[heroId] = {
      nameZh: cn?.nameZh || stats?.localized_name || stats?.name || map[heroId]?.nameZh || `Hero#${heroId}`,
      nameEn: englishFromStats || map[heroId]?.nameEn || resolveHeroEnglishName(heroId, heroConstants),
      internalSlug: map[heroId]?.internalSlug
        || resolveHeroInternalSlug(heroId, heroConstants)
        || internalSlugFromInternalName(stats?.internalName),
    };
  }

  for (const p of matchPlayers) {
    const heroId = p.hero_id;
    if (!heroId) continue;
    const cn = heroNamesCn[heroId];
    if (!map[heroId]) {
      map[heroId] = {
        nameZh: cn?.nameZh || `Hero#${heroId}`,
        nameEn: resolveHeroEnglishName(heroId, heroConstants),
        internalSlug: resolveHeroInternalSlug(heroId, heroConstants),
      };
    }
  }

  return map;
}
