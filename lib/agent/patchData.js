/**
 * The item and hero-ability data of the release a game was played on — the
 * letter release, not only the patch: Heart of Tarrasque is 5100 gold in a
 * 7.41b game and 5200 in a 7.41c one.
 *
 * The site's live tables (lib/data/constants/items.json, lib/coach/data/abilities.json)
 * are the current release's. Every earlier release from 7.40 on has a snapshot,
 * lib/data/constants/patches/<release>.json (scripts/coach-patch-snapshots.mjs),
 * and patches/index.json lists the releases: when each rolled out, and the
 * match ids on either side of the rollout (scripts/patch-match-ids.mjs).
 *
 * A game's release (gamePatch) is read from its start time when the match data
 * has one, else from its match id (ids grow with time), else — the letter
 * then unknown — from OpenDota's patch number, which names the major patch
 * only. A game that started while a release was rolling out cannot be told
 * apart: the newer release's data is used and `exact` is false, as it is when
 * the release is not known at all or no data is kept for it (current tables).
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

/** OpenDota's patch numbers (constants/patch): majors only. */
export const PATCH_NAMES = Object.freeze({ 58: '7.39', 59: '7.40', 60: '7.41', 61: '7.42' });
const MAJOR_ID = Object.fromEntries(Object.entries(PATCH_NAMES).map(([id, name]) => [name, Number(id)]));
/** The current major patch (the live tables'). */
export const CURRENT_PATCH = ABILITIES.patch;
/** Releases in order: { name, major, major_id, rollout_from, rollout_by, data, last_match_id_before?, first_match_id_after? }. */
export const RELEASES = Object.freeze([...INDEX.releases].sort((a, b) => Date.parse(a.rollout_by) - Date.parse(b.rollout_by)));
/** The current release: the live tables are its data. */
export const CURRENT_RELEASE = RELEASES.filter((r) => r.data === 'current').at(-1)?.name ?? CURRENT_PATCH;

const snapshots = new Map();
function snapshot(file) {
  if (!snapshots.has(file)) {
    const url = new URL(`../data/constants/patches/${file}`, import.meta.url);
    snapshots.set(file, existsSync(url) ? JSON.parse(readFileSync(url, 'utf8')) : null);
  }
  return snapshots.get(file);
}

const BY_ID = new Map(Object.values(STATIC_HEROES).map((h) => [h.id, h]));
/** The current table's Chinese name and ultimate flag for an ability key, which an old release's data does not carry. */
const CURRENT_ABILITY = new Map(Object.values(ABILITIES.heroes ?? {}).flat().map((a) => [a.id, a]));

const current = {
  items: ITEMS,
  heroAbilities: (heroId) => ABILITIES.heroes?.[String(heroId)] ?? null,
  ultimate: (heroId) => ABILITIES.ultimates?.[String(heroId)] ?? null,
};
function fromSnapshot(snap) {
  const listOf = (heroId) => {
    const hero = BY_ID.get(Number(heroId));
    const list = hero ? snap.heroes?.[hero.internalName] : null;
    if (!Array.isArray(list)) return null;
    const ultKey = ABILITIES.ultimates?.[String(heroId)]?.key;
    // The same kinds of ability the current table lists: one that still exists but the current table leaves out
    // (an innate, or one granted by Aghanim's Scepter or Shard) is left out here too. One that no longer exists
    // at all was a real ability of that release, and stays, under its English name.
    const listed = new Set((ABILITIES.heroes?.[String(heroId)] ?? []).map((a) => a.id));
    return list.filter((a) => listed.has(a.id) || !ALL_ABILITIES[a.id]).map((a) => ({
      id: a.id, en: a.en, zh: CURRENT_ABILITY.get(a.id)?.zh ?? a.en,
      // Which ability is the ultimate is the current table's word for it; one that no longer exists is not marked.
      ...(a.id === ultKey ? { ult: true } : {}),
      ...(a.dmg ? { dmg: a.dmg } : {}), ...(typeof a.pierces === 'boolean' ? { pierces: a.pierces } : {}), ...(a.dispel ? { dispel: a.dispel } : {}),
      ...(Array.isArray(a.cd) ? { cd: a.cd } : {}),
    }));
  };
  return {
    items: snap.items,
    heroAbilities: listOf,
    ultimate: (heroId) => {
      const u = listOf(heroId)?.find((a) => a.ult);
      return u ? { key: u.id, en: u.en, zh: u.zh, ...(u.cd ? { cd: u.cd } : {}) } : null;
    },
  };
}

const majorOf = (name) => String(name).replace(/[a-z]$/, '');
/**
 * @param {string | number | null | undefined} which  a release name ("7.41b"), or OpenDota's patch number (60:
 *   the letter is then not known, and the last release of that patch is used, exact false)
 * @returns {{ name: string, major: string, id: number | null, exact: boolean, reason: string | null,
 *   items: Record<string, any>,
 *   heroAbilities: (heroId: number) => { id: string, en: string, zh: string, dmg?: string, pierces?: boolean, dispel?: string, ult?: true }[] | null,
 *   ultimate: (heroId: number) => { key: string, en: string, zh: string, cd?: number[] } | null,
 *   has: (itemKey: string) => boolean }}
 */
export function patchData(which) {
  const use = (release, data, exact, reason) => {
    const name = release ?? CURRENT_RELEASE;
    return { name, major: majorOf(name), id: MAJOR_ID[majorOf(name)] ?? null, exact, reason, ...data, has: (k) => Boolean(data.items[k]) };
  };
  if (which == null || which === '') return use(null, current, false, 'patch_of_this_game_unknown');
  let release; let exact = true; let reason = null;
  if (typeof which === 'number') {
    const name = PATCH_NAMES[which];
    const of = name ? RELEASES.filter((r) => r.major === name) : [];
    if (!of.length) return use(null, current, false, which > (MAJOR_ID[CURRENT_PATCH] ?? Infinity) ? 'patch_newer_than_the_site_data' : 'no_data_kept_for_this_patch');
    release = of.at(-1);
    // A patch with one release so far has no letter to be unsure of.
    if (of.length > 1) { exact = false; reason = `letter_release_unknown; ${release.name} data used`; }
  } else {
    release = RELEASES.find((r) => r.name === which);
    if (!release) return use(null, current, false, 'no_data_kept_for_this_release');
  }
  if (release.data === 'current') return use(release.name, current, exact, reason);
  const snap = snapshot(release.data);
  return snap ? use(release.name, fromSnapshot(snap), exact, reason) : use(null, current, false, 'no_data_kept_for_this_release');
}

/**
 * The release a game was played on, and how that is known.
 * @param {number | string | null | undefined} matchId
 * @param {{ patch?: number, start_time?: number } | null | undefined} match  OpenDota's match data, if at hand
 * @returns {{ release: string | null, id: number | null, how: 'start_time' | 'match_id' | 'match_data' | null, exact: boolean, reason?: string }}
 *   `id` is OpenDota's number for the release's patch.
 */
export function gamePatch(matchId, match) {
  const found = (r, how, exact = true, reason) => ({ release: r.name, id: r.major_id ?? MAJOR_ID[r.major] ?? null, how, exact, ...(reason ? { reason } : {}) });
  const first = RELEASES[0];
  const start = Number(match?.start_time);
  if (Number.isFinite(start) && start > 0) {
    const t = start * 1000;
    const rolling = RELEASES.find((r) => t >= Date.parse(r.rollout_from) && t < Date.parse(r.rollout_by));
    if (rolling) return found(rolling, 'start_time', false, `started_while_${rolling.name}_was_rolling_out`);
    const r = RELEASES.filter((x) => Date.parse(x.rollout_by) <= t).at(-1);
    if (r) return found(r, 'start_time');
    return { release: null, id: null, how: null, exact: false, reason: `older_than_${first.name}` };
  }
  const id = Number(matchId);
  const placed = RELEASES.filter((r) => r.first_match_id_after);
  if (Number.isFinite(id) && id > 0 && placed.length) {
    // Started between the last match before a rollout and the first after it: not told.
    const rolling = placed.find((r) => id > r.last_match_id_before && id < r.first_match_id_after);
    if (rolling) return found(rolling, 'match_id', false, `started_while_${rolling.name}_was_rolling_out`);
    const r = placed.filter((x) => x.first_match_id_after <= id).at(-1);
    if (r) return found(r, 'match_id');
    if (id <= placed[0].last_match_id_before) return { release: null, id: null, how: null, exact: false, reason: `older_than_${first.name}` };
  }
  if (Number.isInteger(match?.patch)) return { release: null, id: match.patch, how: 'match_data', exact: false, reason: 'letter_release_unknown' };
  return { release: null, id: null, how: null, exact: false, reason: 'patch_of_this_game_unknown' };
}

/** patchData for a game, with how its release is known (`how`) and, when it is not known exactly, why (`reason`). */
export function patchForGame(matchId, match) {
  const g = gamePatch(matchId, match);
  if (g.release) {
    const pd = patchData(g.release);
    const exact = g.exact && pd.exact;
    return { ...pd, exact, how: g.how, reason: exact ? null : g.reason ?? pd.reason };
  }
  // Only OpenDota's patch number: exact only for a patch that has had one release.
  const pd = patchData(g.how === 'match_data' ? g.id : null);
  return { ...pd, how: g.how === 'match_data' && (pd.exact || pd.reason?.startsWith('letter_release_unknown')) ? 'match_data' : null, reason: pd.exact ? null : g.how === 'match_data' ? pd.reason : g.reason };
}

/** A finished item worth listing as a big item in this release: the coach's rule (2000 gold and built from a recipe, or a key item), on that release's prices. */
export function isBigItemIn(pd, key, { minCost, always }) {
  const it = pd.items[key];
  if (!it || key.startsWith('recipe_')) return false;
  if (always.includes(key)) return true;
  // The current table says "built" through the names table; a snapshot through its recipe.
  const built = pd.items === ITEMS ? NAMES.items[key]?.built === true : Array.isArray(it.components) && it.components.length > 0;
  return built && it.cost >= minCost;
}
