/**
 * The item and hero-ability data of the patch a game was played on.
 *
 * The site's tables (lib/data/constants/items.json, lib/coach/data/abilities.json)
 * are the current patch's. A game from an earlier patch is told its own prices,
 * recipes, item effects and cooldowns from lib/data/constants/patches/<patch>.json
 * (scripts/coach-patch-snapshots.mjs): Heaven's Halberd is 3300 gold with 25%
 * evasion in a 7.41 game, 2400 with neither in a 7.42 one.
 *
 * A game's patch is OpenDota's patch number (match.patch), which does not tell
 * letter releases apart: a snapshot is the patch's last letter release. With no
 * match data, or a patch no snapshot is kept for, the current data is used and
 * `exact` is false, so a caller can say so instead of presenting it as the game's.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { STATIC_HEROES } from '../../packages/review-engine/src/staticHeroes.js';

const require = createRequire(import.meta.url);
const ITEMS = require('../data/constants/items.json');
const ABILITIES = require('../coach/data/abilities.json');
const ALL_ABILITIES = require('../data/constants/abilities.json');
const NAMES = require('../coach/data/names.json');

/** OpenDota's patch numbers (constants/patch) for the patches the site knows. */
export const PATCH_NAMES = Object.freeze({ 58: '7.39', 59: '7.40', 60: '7.41', 61: '7.42' });
const ID_OF = Object.fromEntries(Object.entries(PATCH_NAMES).map(([id, name]) => [name, Number(id)]));
export const CURRENT_PATCH = ABILITIES.patch;
const CURRENT_ID = ID_OF[CURRENT_PATCH] ?? null;

const snapshots = new Map();
function snapshot(name) {
  if (!snapshots.has(name)) {
    const file = new URL(`../data/constants/patches/${name}.json`, import.meta.url);
    snapshots.set(name, existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);
  }
  return snapshots.get(name);
}

const BY_ID = new Map(Object.values(STATIC_HEROES).map((h) => [h.id, h]));
/** The current table's Chinese name and ultimate flag for an ability key, which an old patch's data does not carry. */
const CURRENT_ABILITY = new Map(Object.values(ABILITIES.heroes ?? {}).flat().map((a) => [a.id, a]));

const current = {
  items: ITEMS,
  heroAbilities: (heroId) => ABILITIES.heroes?.[String(heroId)] ?? null,
  ultimate: (heroId) => ABILITIES.ultimates?.[String(heroId)] ?? null,
};

/**
 * @param {number | null | undefined} patchId  OpenDota's match.patch
 * @returns {{ name: string, id: number | null, exact: boolean, reason: string | null,
 *   items: Record<string, any>,
 *   heroAbilities: (heroId: number) => { id: string, en: string, zh: string, dmg?: string, pierces?: boolean, dispel?: string, ult?: true }[] | null,
 *   ultimate: (heroId: number) => { key: string, en: string, zh: string, cd?: number[] } | null,
 *   has: (itemKey: string) => boolean }}
 */
export function patchData(patchId) {
  const id = Number.isInteger(patchId) ? patchId : null;
  const name = id == null ? null : PATCH_NAMES[id] ?? null;
  const use = (data, exact, reason) => ({ name: exact ? name : CURRENT_PATCH, id: exact ? id : CURRENT_ID, exact, reason, ...data, has: (k) => Boolean(data.items[k]) });
  if (id == null) return use(current, false, 'patch_of_this_game_unknown');
  if (id === CURRENT_ID) return use(current, true, null);
  const snap = name && id < (CURRENT_ID ?? Infinity) ? snapshot(name) : null;
  if (!snap) return use(current, false, id > (CURRENT_ID ?? -Infinity) ? 'patch_newer_than_the_site_data' : 'no_data_kept_for_this_patch');
  const listOf = (heroId) => {
    const hero = BY_ID.get(Number(heroId));
    const list = hero ? snap.heroes?.[hero.internalName] : null;
    if (!Array.isArray(list)) return null;
    const ultKey = ABILITIES.ultimates?.[String(heroId)]?.key;
    // The same kinds of ability the current table lists: one that still exists but the current table leaves out
    // (an innate, or one granted by Aghanim's Scepter or Shard) is left out here too. One that no longer exists
    // at all was a real ability of that patch, and stays, under its English name.
    const listed = new Set((ABILITIES.heroes?.[String(heroId)] ?? []).map((a) => a.id));
    return list.filter((a) => listed.has(a.id) || !ALL_ABILITIES[a.id]).map((a) => ({
      id: a.id, en: a.en, zh: CURRENT_ABILITY.get(a.id)?.zh ?? a.en,
      // Which ability is the ultimate is the current table's word for it; one that no longer exists is not marked.
      ...(a.id === ultKey ? { ult: true } : {}),
      ...(a.dmg ? { dmg: a.dmg } : {}), ...(typeof a.pierces === 'boolean' ? { pierces: a.pierces } : {}), ...(a.dispel ? { dispel: a.dispel } : {}),
      ...(Array.isArray(a.cd) ? { cd: a.cd } : {}),
    }));
  };
  return use({
    items: snap.items,
    heroAbilities: listOf,
    ultimate: (heroId) => {
      const u = listOf(heroId)?.find((a) => a.ult);
      return u ? { key: u.id, en: u.en, zh: u.zh, ...(u.cd ? { cd: u.cd } : {}) } : null;
    },
  }, true, null);
}

/** A finished item worth listing as a big item in this patch: the coach's rule (2000 gold and built from a recipe, or a key item), on that patch's prices. */
export function isBigItemIn(pd, key, { minCost, always }) {
  const it = pd.items[key];
  if (!it || key.startsWith('recipe_')) return false;
  if (always.includes(key)) return true;
  // The current table says "built" through the names table; a snapshot through its recipe.
  const built = pd.items === ITEMS ? NAMES.items[key]?.built === true : Array.isArray(it.components) && it.components.length > 0;
  return built && it.cost >= minCost;
}
