/**
 * The item and hero-ability data of the release a game was played on — the
 * letter release, not only the patch: Heart of Tarrasque is 5100 gold in a
 * 7.41b game and 5200 in a 7.41c one — and the hotfix within it: Necronomicon
 * is 2050 gold in a 7.41f game of September 2026 and 2700 after the hotfix of
 * 7 October (a release's `hotfixes` in patches/index.json, each with its own
 * snapshot; `hotfix` on what patchData returns is the one used, null for the
 * release as it rolled out).
 *
 * Every release from 7.40 on, the newest included, has a snapshot built from its
 * own game files: lib/data/constants/patches/<release>.json (scripts/coach-patch-snapshots.mjs),
 * and patches/index.json lists the releases: when each rolled out, and the
 * match ids on either side of the rollout (scripts/patch-match-ids.mjs).
 *
 * A game's release (gamePatch) is read from its start time when the match data
 * has one, else from its match id (ids grow with time), else — the letter
 * then unknown — from OpenDota's patch number, which names the major patch
 * only. A game that started while a release was rolling out cannot be told
 * apart: the newer release's data is used and `exact` is false, as it is when
 * the release is not known at all or no data is kept for it — then the site's
 * live tables (lib/data/constants/items.json, lib/coach/data/abilities.json) are used.
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
const RELEASES_KNOWN = RELEASES;
/** The newest release the site has data for. Its data is its own snapshot, like every other release's. */
export const CURRENT_RELEASE = RELEASES.at(-1)?.name ?? CURRENT_PATCH;

const snapshots = new Map();
function snapshot(file) {
  if (!snapshots.has(file)) {
    const url = new URL(`../data/constants/patches/${file}`, import.meta.url);
    snapshots.set(file, existsSync(url) ? JSON.parse(readFileSync(url, 'utf8')) : null);
  }
  return snapshots.get(file);
}

const BY_ID = new Map(Object.values(STATIC_HEROES).map((h) => [h.id, h]));
/** The current table's Chinese name, ultimate flag, granted_by and Valve text for an ability key, which an old release's snapshot does not carry. */
const CURRENT_ABILITY = new Map(Object.values(ABILITIES.heroes ?? {}).flat().map((a) => [a.id, a]));

/**
 * Collect a hero's Aghanim's Scepter and Aghanim's Shard effects (both granted abilities
 * and upgrades to existing/innate abilities) in the requested language.
 * Returns `{ scepter: array | null, shard: array | null }` where `null` means missing in
 * the source data (never `[]`, following "Unknown is not false").
 */
export function aghsUpgradesFrom(abilities, innates = [], lang = 'en') {
  const L = lang === 'zh' ? 'zh' : 'en';
  const pick = (v) => (v && typeof v === 'object' ? v[L] ?? v.en ?? null : typeof v === 'string' && v ? v : null);
  const scepter = [];
  const shard = [];
  for (const a of Array.isArray(abilities) ? abilities : []) {
    if (!a?.id) continue;
    const name = a[L] ?? a.en ?? a.id;
    if (a.granted_by === 'scepter') {
      const description = pick(a.desc);
      scepter.push({
        kind: 'granted_ability',
        granted_by: 'scepter',
        ability: a.id,
        name,
        ...(description ? { description } : {}),
      });
    } else if (a.granted_by === 'shard') {
      const description = pick(a.desc);
      shard.push({
        kind: 'granted_ability',
        granted_by: 'shard',
        ability: a.id,
        name,
        ...(description ? { description } : {}),
      });
    }
    const scDesc = pick(a.scepter);
    if (scDesc) scepter.push({ kind: 'upgrade', ability: a.id, name, description: scDesc });
    const shDesc = pick(a.shard);
    if (shDesc) shard.push({ kind: 'upgrade', ability: a.id, name, description: shDesc });
  }
  for (const a of Array.isArray(innates) ? innates : []) {
    if (!a?.id) continue;
    const name = a[L] ?? a.en ?? a.id;
    const scDesc = pick(a.scepter);
    if (scDesc) scepter.push({ kind: 'upgrade', ability: a.id, name, innate: true, description: scDesc });
    const shDesc = pick(a.shard);
    if (shDesc) shard.push({ kind: 'upgrade', ability: a.id, name, innate: true, description: shDesc });
  }
  return {
    scepter: scepter.length ? scepter : null,
    shard: shard.length ? shard : null,
  };
}

/** Aghanim's Scepter and Shard effects for `heroId` from the current committed ability table (`ABILITIES`). */
export function currentAghsUpgrades(heroId, lang = 'en', source = ABILITIES) {
  const key = String(heroId);
  const list = source?.heroes?.[key];
  const innates = source?.innate_upgrades?.[key] ?? [];
  if (!Array.isArray(list) && !innates.length) return { scepter: null, shard: null };
  return aghsUpgradesFrom(list ?? [], innates, lang);
}

const current = {
  items: ITEMS,
  heroAbilities: (heroId) => ABILITIES.heroes?.[String(heroId)] ?? null,
  ultimate: (heroId) => ABILITIES.ultimates?.[String(heroId)] ?? null,
  aghsUpgrades: (heroId, lang = 'en') => currentAghsUpgrades(heroId, lang),
};
export function fromSnapshot(snap) {
  const sameMajor = snap?.major === ABILITIES.patch;
  const listOf = (heroId) => {
    const hero = BY_ID.get(Number(heroId));
    const list = hero ? snap?.heroes?.[hero.internalName] : null;
    if (!Array.isArray(list)) return null;
    // The same kinds of ability the current table lists (basic, ultimate, and Aghanim's Scepter/Shard-granted):
    // innates stay out, while granted abilities present in this release's snapshot are preserved. One that no
    // longer exists in current constants was a real ability of that release, and stays under its English name.
    const listed = new Set((ABILITIES.heroes?.[String(heroId)] ?? []).map((a) => a.id));
    return list.filter((a) => Boolean(a.granted_by) || listed.has(a.id) || !ALL_ABILITIES[a.id]).map((a) => {
      const now = CURRENT_ABILITY.get(a.id);
      // Spell immunity, as Valve's table means it: whether it goes through an *enemy's*. The game files say "yes"
      // also for an ability on allies or the caster (Brilliance Aura, Warcry), where Valve's table says nothing: the
      // release's value is kept only where Valve's table states one, or — for an ability no longer in it — where the
      // ability deals damage.
      const pierces = typeof a.pierces === 'boolean' && (now ? typeof now.pierces === 'boolean' : Boolean(a.dmg)) ? a.pierces : null;
      const grantedBy = a.granted_by === 'scepter' || a.granted_by === 'shard'
        ? a.granted_by
        : (sameMajor && (now?.granted_by === 'scepter' || now?.granted_by === 'shard') ? now.granted_by : null);
      return {
        id: a.id, en: a.en, zh: now?.zh ?? a.en,
        // Which abilities are ultimates is the current table's word for it (two for Dark Willow and Kez); one that no longer exists is not marked.
        ...(now?.ult ? { ult: true } : {}),
        ...(grantedBy ? { granted_by: grantedBy } : {}),
        ...(a.dmg ? { dmg: a.dmg } : {}), ...(pierces != null ? { pierces } : {}), ...(a.dispel ? { dispel: a.dispel } : {}),
        ...(Array.isArray(a.cd) ? { cd: a.cd } : {}),
        // Tooltip descriptions and Scepter/Shard upgrade text in abilities.json belong to the current major patch:
        // attach them only for snapshots on that same major patch (never back-port 7.42 wording onto 7.41f/7.40).
        ...(sameMajor && now?.desc ? { desc: now.desc } : {}),
        ...(sameMajor && now?.scepter ? { scepter: now.scepter } : {}),
        ...(sameMajor && now?.shard ? { shard: now.shard } : {}),
      };
    });
  };
  return {
    items: snap.items,
    heroAbilities: listOf,
    // Null for older major patches whose snapshots hold flags/cooldowns only, not Scepter/Shard text.
    aghsUpgrades: (heroId, lang = 'en') => {
      if (!sameMajor) return null;
      const list = listOf(heroId);
      const innates = ABILITIES.innate_upgrades?.[String(heroId)] ?? [];
      if (!Array.isArray(list) && !innates.length) return { scepter: null, shard: null };
      return aghsUpgradesFrom(list ?? [], innates, lang);
    },
    ultimate: (heroId) => {
      // The hero's main ultimate is the current table's (ultimates), looked up in the release's whole list: it need not
      // be among the abilities shown (Invoke is not), and with two ultimates the other is still marked in the list.
      const now = ABILITIES.ultimates?.[String(heroId)];
      const hero = BY_ID.get(Number(heroId));
      const raw = hero ? snap.heroes?.[hero.internalName] : null;
      const u = (now?.key && raw?.find((a) => a.id === now.key)) || listOf(heroId)?.find((a) => a.ult);
      if (!u) return null;
      const named = now?.key === u.id ? now : CURRENT_ABILITY.get(u.id);
      // The game files keep a cooldown that is the same at every level once ([100]); Valve's table per level
      // ([100, 100, 100]). Told per level, like the table, so "by level" reads the same either way.
      const levels = now?.key === u.id && Array.isArray(now.cd) ? now.cd.length : 0;
      const cd = Array.isArray(u.cd) && u.cd.length === 1 && levels > 1 ? Array(levels).fill(u.cd[0]) : u.cd;
      return { key: u.id, en: named?.en ?? u.en, zh: named?.zh ?? u.en, ...(Array.isArray(cd) ? { cd } : {}) };
    },
  };
}

const majorOf = (name) => String(name).replace(/[a-z]$/, '');
/**
 * @param {string | number | null | undefined} which  a release name ("7.41b"), or OpenDota's patch number (60:
 *   the letter is then not known, and the last release of that patch is used, exact false)
 * @param {{ hotfix?: string | null, releases?: readonly any[] }} [o]  the hotfix (its rollout_by) within the release, and the release list (a test may pass another state of it)
 * @returns {{ name: string, major: string, id: number | null, exact: boolean, reason: string | null,
 *   items: Record<string, any>,
 *   heroAbilities: (heroId: number) => { id: string, en: string, zh: string, dmg?: string, pierces?: boolean, dispel?: string, ult?: true, granted_by?: 'scepter' | 'shard', cd?: number[], desc?: { en: string, zh: string }, scepter?: { en: string, zh: string }, shard?: { en: string, zh: string } }[] | null,
 *   aghsUpgrades: (heroId: number, lang?: string) => { scepter: any[] | null, shard: any[] | null } | null,
 *   ultimate: (heroId: number) => { key: string, en: string, zh: string, cd?: number[] } | null,
 *   has: (itemKey: string) => boolean }}
 */
export function patchData(which, { hotfix = null, releases: RELEASES = RELEASES_KNOWN } = {}) {
  const use = (release, data, exact, reason, step = null) => {
    const name = release ?? CURRENT_RELEASE;
    return { name, major: majorOf(name), id: MAJOR_ID[majorOf(name)] ?? null, exact, reason, hotfix: step, ...data, has: (k) => Boolean(data.items[k]) };
  };
  if (which == null || which === '') return use(null, current, false, 'patch_of_this_game_unknown');
  let release; let exact = true; let reason = null; let step = null;
  if (typeof which === 'number') {
    const name = PATCH_NAMES[which];
    const of = name ? RELEASES.filter((r) => r.major === name) : [];
    if (!of.length) return use(null, current, false, which > (MAJOR_ID[CURRENT_PATCH] ?? Infinity) ? 'patch_newer_than_the_site_data' : 'no_data_kept_for_this_patch');
    release = of.at(-1);
    // The letter not known: the patch as it stands last, its latest hotfix included.
    step = (release.hotfixes ?? []).filter((h) => h.data).at(-1) ?? null;
    // A patch with one release so far has no letter to be unsure of.
    if (of.length > 1) { exact = false; reason = `letter_release_unknown; ${release.name} data used`; }
  } else {
    release = RELEASES.find((r) => r.name === which);
    if (!release) return use(null, current, false, 'no_data_kept_for_this_release');
    if (hotfix != null) {
      const list = release.hotfixes ?? [];
      const n = list.findIndex((h) => h.rollout_by === hotfix);
      if (n < 0) { exact = false; reason = `no_hotfix_of_${release.name}_at_${hotfix}`; } else {
        step = list[n];
        // A hotfix whose game files the builder could not read: the data of the update before it, not exact.
        if (!step.data) {
          exact = false; reason = `hotfix_${String(hotfix).slice(0, 16)}_data_not_built; the update before used`;
          step = list.slice(0, n).filter((h) => h.data).at(-1) ?? null;
        }
      }
    }
  }
  const snap = snapshot(step?.data ?? release.data);
  return snap ? use(release.name, fromSnapshot(snap), exact, reason, step?.rollout_by ?? null) : use(null, current, false, 'no_data_kept_for_this_release');
}

/** "2026-10-07T00:40" of a hotfix, for a reason. */
const dayOf = (h) => String(h.rollout_by).slice(0, 16);
/**
 * Which hotfix of release `r` a game was played on: the last one rolled out before it started (null: none, the
 * release as it rolled out). `t` the start time in ms, or `id` the match id when the start time is not known.
 */
/**
 * Whether a game known only by its match id started before rollout `x`, whose own ids are not found yet: true when the
 * id is at or below the newest match the id search looked at and that match started before `x` was rolling out.
 */
const startedBefore = (id, x, checked) => Boolean(checked && id <= checked.match_id && Date.parse(checked.started) < Date.parse(x.rollout_from));

function hotfixOf(r, { t = null, id = null }, checked = null) {
  const list = r.hotfixes ?? [];
  if (!list.length) return { hotfix: null, exact: true };
  if (t != null) {
    const rolling = list.find((h) => t >= Date.parse(h.rollout_from) && t < Date.parse(h.rollout_by));
    if (rolling) return { hotfix: rolling, exact: false, reason: `started_while_the_${dayOf(rolling)}_hotfix_was_rolling_out` };
    return { hotfix: list.filter((h) => Date.parse(h.rollout_by) <= t).at(-1) ?? null, exact: true };
  }
  const placed = list.filter((h) => h.first_match_id_after);
  const rolling = placed.find((h) => id > h.last_match_id_before && id < h.first_match_id_after);
  if (rolling) return { hotfix: rolling, exact: false, reason: `started_while_the_${dayOf(rolling)}_hotfix_was_rolling_out` };
  const h = placed.filter((x) => x.first_match_id_after <= id).at(-1) ?? null;
  // A later hotfix whose ids are not indexed: the game may be on it.
  const open = list.find((x) => !x.first_match_id_after && (!h || Date.parse(x.rollout_by) > Date.parse(h.rollout_by)) && !startedBefore(id, x, checked));
  if (open) return { hotfix: h, exact: false, reason: `may_be_after_the_${dayOf(open)}_hotfix_whose_match_ids_are_not_indexed` };
  return { hotfix: h, exact: true };
}

/**
 * The release a game was played on, and how that is known.
 * @param {number | string | null | undefined} matchId
 * @param {{ patch?: number, start_time?: number } | null | undefined} match  OpenDota's match data, if at hand
 * @param {{ releases?: readonly any[], checked?: { match_id: number, started: string } | null }} [o]  the release list (the index's; a test may pass another state of it), and the newest match the id search looked at
 * @returns {{ release: string | null, hotfix?: string, id: number | null, how: 'start_time' | 'match_id' | 'match_data' | null, exact: boolean, reason?: string }}
 *   `id` is OpenDota's number for the release's patch; `hotfix` the rollout time (rollout_by) of the release's hotfix
 *   the game was played on, absent when it was played on the release as it rolled out.
 */
export function gamePatch(matchId, match, { releases: RELEASES_ = RELEASES, checked = INDEX.ids_checked_to ?? null } = {}) {
  const RELEASES = RELEASES_;
  // OpenDota's patch number newer than any release the site knows: the release list is behind (a new patch came
  // out since it was built). Neither the start time nor the id can place such a game: they would name the last
  // known release, as if exactly.
  if (Number.isInteger(match?.patch) && match.patch > Math.max(...RELEASES.map((r) => r.major_id ?? MAJOR_ID[r.major] ?? -Infinity))) {
    return { release: null, id: match.patch, how: 'match_data', exact: false, reason: 'patch_newer_than_the_site_data' };
  }
  const found = (r, how, exact = true, reason, at = null) => {
    // The hotfix within the release, once the release itself is placed (a game during the release's rollout is in no hotfix of it).
    const hx = at ? hotfixOf(r, at, checked) : { hotfix: null, exact: true };
    const why = reason ?? (hx.exact ? null : hx.reason);
    return { release: r.name, ...(hx.hotfix ? { hotfix: hx.hotfix.rollout_by } : {}), id: r.major_id ?? MAJOR_ID[r.major] ?? null, how, exact: exact && hx.exact, ...(why ? { reason: why } : {}) };
  };
  const first = RELEASES[0];
  const start = Number(match?.start_time);
  if (Number.isFinite(start) && start > 0) {
    const t = start * 1000;
    const rolling = RELEASES.find((r) => t >= Date.parse(r.rollout_from) && t < Date.parse(r.rollout_by));
    if (rolling) return found(rolling, 'start_time', false, `started_while_${rolling.name}_was_rolling_out`);
    const r = RELEASES.filter((x) => Date.parse(x.rollout_by) <= t).at(-1);
    if (r) return found(r, 'start_time', true, undefined, { t });
    return { release: null, id: null, how: null, exact: false, reason: `older_than_${first.name}` };
  }
  const id = Number(matchId);
  const placed = RELEASES.filter((r) => r.first_match_id_after);
  if (Number.isFinite(id) && id > 0 && placed.length) {
    // Started between the last match before a rollout and the first after it: not told.
    const rolling = placed.find((r) => id > r.last_match_id_before && id < r.first_match_id_after);
    if (rolling) return found(rolling, 'match_id', false, `started_while_${rolling.name}_was_rolling_out`);
    const r = placed.filter((x) => x.first_match_id_after <= id).at(-1);
    // A newer release whose ids are not indexed yet: past r's boundary the game may be in it.
    const unplaced = r ? RELEASES.filter((x) => !x.first_match_id_after && Date.parse(x.rollout_by) > Date.parse(r.rollout_by) && !startedBefore(id, x, checked)) : [];
    if (r && unplaced.length) {
      const newer = Number.isInteger(match?.patch) && match.patch > (r.major_id ?? MAJOR_ID[r.major] ?? Infinity);
      if (!newer) return found(r, 'match_id', false, `may_be_${unplaced[0].name}_or_later_whose_match_ids_are_not_indexed`, { id });
    } else if (r) return found(r, 'match_id', true, undefined, { id });
    if (id <= placed[0].last_match_id_before) return { release: null, id: null, how: null, exact: false, reason: `older_than_${first.name}` };
  }
  if (Number.isInteger(match?.patch)) return { release: null, id: match.patch, how: 'match_data', exact: false, reason: 'letter_release_unknown' };
  return { release: null, id: null, how: null, exact: false, reason: 'patch_of_this_game_unknown' };
}

/** patchData for a game, with how its release is known (`how`) and, when it is not known exactly, why (`reason`). */
export function patchForGame(matchId, match) {
  const g = gamePatch(matchId, match);
  if (g.release) {
    const pd = patchData(g.release, { hotfix: g.hotfix ?? null });
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
  // The current table says "built" through the names table; a snapshot through Valve's recipe marker (Dagon 2–5 have
  // one and no component list), or its components.
  const built = pd.items === ITEMS ? NAMES.items[key]?.built === true : it.created === true || (Array.isArray(it.components) && it.components.length > 0);
  return built && it.cost >= minCost;
}
