/**
 * The item and hero-ability data of the patch a game was played on.
 *
 * The site's tables (lib/data/constants/items.json, lib/coach/data/abilities.json)
 * are the current patch's. A game from an earlier patch is told its own prices,
 * recipes, item effects and cooldowns from lib/data/constants/patches/<patch>.json
 * (scripts/coach-patch-snapshots.mjs): Heaven's Halberd is 3300 gold with 25%
 * evasion in a 7.41 game, 2400 with neither in a 7.42 one.
 *
 * A game's patch (gamePatch) is OpenDota's patch number when the match data has
 * it, else the release its start time falls after, else the release its match
 * id falls after (match ids grow with time; patches/index.json holds the ids on
 * either side of each release). None of these tells letter releases apart: a
 * snapshot is the patch's last letter release. With no patch, or a patch no
 * snapshot is kept for, the current data is used and `exact` is false, so a
 * caller can say so instead of presenting it as the game's.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { STATIC_HEROES } from '../../packages/review-engine/src/staticHeroes.js';

const require = createRequire(import.meta.url);
const ITEMS = require('../data/constants/items.json');
const ABILITIES = require('../coach/data/abilities.json');
const ALL_ABILITIES = require('../data/constants/abilities.json');
const NAMES = require('../coach/data/names.json');
const INDEX = require('../data/constants/patches/index.json');
const RELEASES = [...INDEX.patches].sort((a, b) => a.id - b.id);

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

/**
 * The patch a game was played on, and how that is known.
 * @param {number | string | null | undefined} matchId
 * @param {{ patch?: number, start_time?: number } | null | undefined} match  OpenDota's match data, if at hand
 * @returns {{ id: number | null, how: 'match_data' | 'start_time' | 'match_id' | null, reason?: string }}
 */
export function gamePatch(matchId, match) {
  if (Number.isInteger(match?.patch)) return { id: match.patch, how: 'match_data' };
  const first = RELEASES[0];
  const start = Number(match?.start_time);
  if (Number.isFinite(start) && start > 0) {
    const p = RELEASES.filter((r) => Date.parse(r.released) / 1000 <= start).at(-1);
    return p ? { id: p.id, how: 'start_time' } : { id: null, how: null, reason: `older_than_${first.name}` };
  }
  const id = Number(matchId);
  if (!Number.isFinite(id) || id <= 0) return { id: null, how: null, reason: 'patch_of_this_game_unknown' };
  // An id between the last match before a release and the first after it cannot be told.
  if (RELEASES.some((r) => id > r.last_match_id_before && id < r.first_match_id_after)) return { id: null, how: null, reason: 'match_id_at_a_patch_release' };
  const p = RELEASES.filter((r) => r.first_match_id_after <= id).at(-1);
  return p ? { id: p.id, how: 'match_id' } : { id: null, how: null, reason: `older_than_${first.name}` };
}

/** patchData for a game, with how its patch is known (`how`) and, when it is not, why (`reason`). */
export function patchForGame(matchId, match) {
  const g = gamePatch(matchId, match);
  const pd = patchData(g.id);
  return { ...pd, how: pd.exact ? g.how : null, ...(g.id == null && g.reason ? { reason: g.reason } : {}) };
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
