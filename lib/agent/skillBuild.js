/**
 * skill_build: chronological ability leveling timeline, level-6 and level-10 skill distributions,
 * maxed order, ultimate levels, and talents (when available) for one hero from the replay trace.
 *
 * Pure, deterministic. Unknown stays null with a stated gap — never guessed or invented.
 */
import { createRequire } from 'node:module';
import { HEROES_BY_KEY } from '../../packages/review-engine/src/staticHeroes.js';
import { GENERIC_MAP_ABILITIES, traceClock } from '../../packages/review-engine/src/trace/index.js';
import { abilityLevel } from '../../packages/review-engine/src/trace/query.js';
import { patchForGame } from './patchData.js';
import { ultimatesOf } from './ultimates.js';

const require = createRequire(import.meta.url);
const ABILITIES = require('../coach/data/abilities.json');
const ALL_ABILITIES = require('../data/constants/abilities.json');

// Each hero's own abilities, then those from Aghanim's Shard or Scepter and the innate ones (#495: those had no name).
const ABILITY_BY_ID = new Map([...Object.entries(ABILITIES.granted ?? {}).map(([id, { en, zh }]) => [id, { id, en, zh }]), ...Object.values(ABILITIES.heroes ?? {}).flat().map((a) => [a.id, a])]);
const CURRENT_GRANTED_ABILITIES = new Set(
  Object.values(ABILITIES.heroes ?? {}).flat()
    .filter((a) => a.granted_by === 'scepter' || a.granted_by === 'shard')
    .map((a) => a.id),
);
const slugOf = (hero) => String(hero ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_');

/**
 * Known non-ultimate learnable abilities whose max level is not 4 and whose static constants
 * store scalar cooldown/mana values rather than per-level arrays.
 */
const KNOWN_NON_ULT_MAX_LEVEL = Object.freeze({
  invoker_quas: 7,
  invoker_wex: 7,
  invoker_exort: 7,
});

/**
 * Hero abilities generated or automatically mirrored by another skill rather than consuming
 * independent skill points (Invoker's 10 invoked spells and linked sub-abilities).
 */
const GENERATED_OR_LINKED_ABILITIES = new Set([
  'invoker_cold_snap',
  'invoker_ghost_walk',
  'invoker_ice_wall',
  'invoker_emp',
  'invoker_tornado',
  'invoker_alacrity',
  'invoker_sun_strike',
  'invoker_forge_spirit',
  'invoker_chaos_meteor',
  'invoker_deafening_blast',
  'ember_spirit_activate_fire_remnant',
  'morphling_morph_str',
  'troll_warlord_whirling_axes_melee',
]);

function abilityBehaviors(raw) {
  const b = raw?.behavior;
  return Array.isArray(b) ? b : typeof b === 'string' ? [b] : [];
}

function isNonSkillPointSubAbility(k, pdEntry) {
  if (GENERATED_OR_LINKED_ABILITIES.has(k)) return true;
  // Scepter/Shard-granted abilities (e.g. Enchantress Sproink, Beastmaster Summon Ancient Thunderhide)
  // may carry Valve's "Hidden" behavior until granted; keep them visible in upgrade_timeline
  // while excluding confirmed ones from at_level_6/at_level_10 skill-point distributions below.
  if (pdEntry?.granted_by === 'scepter' || pdEntry?.granted_by === 'shard' || CURRENT_GRANTED_ABILITIES.has(k)) return false;
  const beh = abilityBehaviors(ALL_ABILITIES[k]);
  if (beh.includes('Not Learnable')) return true;
  // Active Hidden abilities inside pd.heroAbilities() (Invoker invoked spells, Tiny Toss Tree,
  // Io Spirits In/Out, Ringmaster souvenirs, Kez Sai-stance mirrors, Largo songs, etc.) are
  // generated/linked sub-abilities; passive Hidden abilities outside pd.heroAbilities() are innates.
  return Boolean(pdEntry) && beh.includes('Hidden');
}

function nonEmptyLen(arr) {
  return Array.isArray(arr) ? arr.filter((x) => x !== '' && x != null).length : 0;
}

/**
 * Resolve a non-ultimate ability's level cap from ability metadata.
 * Never applies a blind 4-level cap when the trace upgrades past 4 or when metadata cannot establish one.
 */
function abilityMaxLevel(k, pdEntry, rawEntry, maxObserved, isLearnable) {
  if (Number.isInteger(pdEntry?.max_level) && pdEntry.max_level > 0) return { cap: pdEntry.max_level, unknown: false };
  if (Number.isInteger(rawEntry?.max_level) && rawEntry.max_level > 0) return { cap: rawEntry.max_level, unknown: false };
  if (k in KNOWN_NON_ULT_MAX_LEVEL) return { cap: KNOWN_NON_ULT_MAX_LEVEL[k], unknown: false };
  const metaLen = Math.max(nonEmptyLen(rawEntry?.cd), nonEmptyLen(rawEntry?.mc), nonEmptyLen(pdEntry?.cd));
  if (metaLen >= 4) {
    return maxObserved > metaLen ? { cap: null, unknown: true } : { cap: metaLen, unknown: false };
  }
  if (metaLen >= 2) return { cap: null, unknown: false };
  if (isLearnable) {
    return maxObserved > 4 ? { cap: null, unknown: true } : { cap: 4, unknown: false };
  }
  return { cap: null, unknown: maxObserved > 1 };
}

/** Sampled hero level at second `t` (±2 s), or null when level samples are missing. */
function levelAt(trace, seatIndex, t) {
  const levels = trace.states?.[seatIndex]?.level;
  if (!Array.isArray(levels)) return null;
  const i0 = Math.round(t) - trace.t0;
  for (const d of [0, -1, 1, -2, 2]) {
    const i = i0 + d;
    if (i >= 0 && i < trace.n && Number.isFinite(levels[i])) return levels[i];
  }
  return null;
}

/** Monotonically increasing `[t, level]` upgrade steps from a raw ability `levels` array. */
function upgradeSequence(levels) {
  const sorted = [...levels].sort((a, b) => a[0] - b[0]);
  const seq = [];
  let highest = 0;
  for (const [at, lv] of sorted) {
    if (!(lv > highest)) continue;
    seq.push([at, lv]);
    highest = lv;
  }
  return seq;
}

/** Two ultimate abilities share one skill point when they have identical non-empty level progressions within 1 s. */
function sameUpgradeSequence(a, b) {
  if (!a.length || a.length !== b.length) return false;
  return a.every(([tA, lvA], i) => lvA === b[i][1] && Math.abs(tA - b[i][0]) <= 1);
}

/**
 * Snapshot of non-innate ability levels shortly after the hero first reached `targetLevel`.
 * Returns `null` when level samples are missing, the hero never reached `targetLevel`, or
 * missing samples right before crossing `targetLevel` leave the timing unsettled.
 */
function snapshotAtHeroLevel(trace, seatIndex, targetLevel, heroAbilitiesList, initialOnlyKeys, linkedGroupKeyByMember) {
  const levels = trace.states?.[seatIndex]?.level;
  if (!Array.isArray(levels) || !levels.some((v) => Number.isFinite(v))) return null;
  const i = levels.findIndex((v) => Number.isFinite(v) && v >= targetLevel);
  if (i < 0) return null;
  // Require an observed sample immediately before crossing `targetLevel` so blanked earlier samples
  // do not pretend the hero first reached `targetLevel` at the first non-null second.
  if (i === 0) {
    if (levels[0] !== targetLevel) return null;
  } else if (!Number.isFinite(levels[i - 1]) || levels[i - 1] >= targetLevel) {
    return null;
  }
  const reachedT = i + trace.t0;
  let nextLevelT = Infinity;
  for (let j = i + 1; j < levels.length; j += 1) {
    if (Number.isFinite(levels[j]) && levels[j] > levels[i]) {
      nextLevelT = j + trace.t0;
      break;
    }
  }
  const traceEnd = trace.t0 + trace.n - 1;
  const evalT = Math.max(reachedT, Math.min(reachedT + 5, nextLevelT - 1, traceEnd));
  const abilities = {};
  for (const [k, entry] of heroAbilitiesList) {
    if (initialOnlyKeys.has(k)) continue;
    const lv = abilityLevel(entry, evalT);
    if (lv > 0) {
      const outKey = linkedGroupKeyByMember.get(k) ?? k;
      abilities[outKey] = Math.max(abilities[outKey] ?? 0, lv);
    }
  }
  return { clock: traceClock(reachedT), abilities };
}

/** Parse talents only when match data explicitly provides string `special_bonus_*` keys (never guess numeric IDs). */
function parseTalents(match, heroId) {
  const player = (match?.players ?? []).find((p) => p && p.hero_id === heroId);
  const arr = player?.ability_upgrades_arr;
  if (!Array.isArray(arr) || !arr.length) return null;
  const stringTalents = arr.filter((x) => typeof x === 'string' && x.startsWith('special_bonus_'));
  if (!stringTalents.length) return null;
  return stringTalents.map((key) => ({ ability: key, name: ALL_ABILITIES[key]?.dname ?? key }));
}

export function skillBuild(trace, args = {}, ctx = {}) {
  const slug = slugOf(args.hero);
  const seatIndex = Array.isArray(trace?.heroes) ? trace.heroes.findIndex((h) => h.key === slug) : -1;
  const hero = HEROES_BY_KEY.get(slug);
  if (seatIndex < 0 || !hero) return { error: 'unknown_hero', heroes: (trace?.heroes ?? []).map((h) => h.key) };

  const pd = patchForGame(trace.match_id, ctx.match);
  const lang = ctx.lang === 'zh' ? 'zh' : 'en';
  const pdList = pd.heroAbilities(hero.id) ?? [];
  const pdMap = new Map(pdList.map((a) => [a.id, a]));
  const ultKeys = new Set([
    ...ultimatesOf(slug),
    ...pdList.filter((a) => a.ult).map((a) => a.id),
    ...(pd.ultimate(hero.id)?.key ? [pd.ultimate(hero.id).key] : []),
  ]);
  const slugPrefix = `${slug}_`;
  const internalPrefix = `${hero.internalSlug}_`;
  const abilityDisplayName = (k) => pdMap.get(k)?.[lang] ?? pdMap.get(k)?.en ?? ABILITY_BY_ID.get(k)?.[lang] ?? ABILITY_BY_ID.get(k)?.en ?? ALL_ABILITIES[k]?.dname ?? k;

  const rawAbilities = trace.abilities?.[seatIndex];
  const heroEntries = rawAbilities && typeof rawAbilities === 'object'
    ? Object.entries(rawAbilities).filter(([k]) => {
      if (GENERIC_MAP_ABILITIES.has(k) || k.startsWith('plus_') || k.startsWith('seasonal_') || k.startsWith('special_bonus')) return false;
      const pdEntry = pdMap.get(k);
      if (!(pdEntry || k.startsWith(slugPrefix) || k.startsWith(internalPrefix))) return false;
      return !isNonSkillPointSubAbility(k, pdEntry);
    })
    : [];
  const validLevelRows = (levels) => Array.isArray(levels) && levels.every((row) => Array.isArray(row) && typeof row[0] === 'number' && typeof row[1] === 'number');
  const missingLevelAbilities = heroEntries
    .filter(([, e]) => !validLevelRows(e?.levels))
    .map(([k]) => k)
    .sort();
  const heroAbilitiesList = heroEntries.filter(([, e]) => validLevelRows(e?.levels) && e.levels.some(([, lv]) => lv > 0));

  const talents = parseTalents(ctx.match, hero.id);
  const talentGap = talents == null ? [{ topic: 'talents', reason: 'not_in_trace_or_match_data' }] : [];

  if (!heroAbilitiesList.length) {
    return {
      ref: `skill_build:${slug}`,
      hero: slug,
      data_patch: pd.name,
      upgrade_timeline: null,
      at_level_6: null,
      at_level_10: null,
      maxed_order: null,
      ultimate_levels: null,
      talents,
      gaps: [
        { topic: 'skill_build', reason: 'no_ability_levels_in_trace', ...(missingLevelAbilities.length ? { abilities: missingLevelAbilities } : {}) },
        ...talentGap,
      ],
    };
  }

  // Detect linked dual/multi ultimates that level together on a single skill point (e.g. Dark Willow Bedlam + Terrorize,
  // Kez Raptor Dance + Raven's Veil) so both stay visible in timeline/ultimate_levels while at_level_6/10 count them once.
  const primaryUltKey = pd.ultimate(hero.id)?.key ?? ultimatesOf(slug)[0] ?? null;
  const ultEntries = heroAbilitiesList
    .filter(([k]) => ultKeys.has(k))
    .map(([k, entry]) => ({ key: k, seq: upgradeSequence(entry.levels) }))
    .sort((a, b) => (a.key === primaryUltKey ? -1 : b.key === primaryUltKey ? 1 : a.key.localeCompare(b.key)));
  const ultGroups = [];
  for (const item of ultEntries) {
    const match = ultGroups.find((g) => sameUpgradeSequence(g.seq, item.seq));
    if (match) match.keys.push(item.key);
    else ultGroups.push({ seq: item.seq, keys: [item.key] });
  }
  const linkedUltimates = ultGroups.filter((g) => g.keys.length > 1).map((g) => g.keys);
  const linkedWithMap = new Map();
  const linkedGroupKeyByMember = new Map();
  for (const group of linkedUltimates) {
    const combinedKey = group.join('+');
    for (const k of group) {
      linkedWithMap.set(k, group.filter((other) => other !== k));
      linkedGroupKeyByMember.set(k, combinedKey);
    }
  }

  const upgradeTimeline = [];
  // Non-skill-point abilities established by exact Valve metadata:
  // - Scepter/Shard-granted skills carry `granted_by: 'scepter' | 'shard'` in `pdMap`;
  // - Innate abilities stay excluded from `ABILITIES.heroes` (`!ability_is_innate`).
  // Normal learnable skills left at level 1 are in `pdMap` without `granted_by` and are NEVER excluded.
  const innateMetaExact = Boolean(pd.exact && pd.major === ABILITIES.patch);
  const nonPointKeys = new Set();
  let innateUncertain = false;
  let grantedUncertain = false;
  let unknownMaxLevel = false;
  const maxedEntries = [];

  for (const [k, entry] of heroAbilitiesList) {
    const sorted = [...entry.levels].sort((a, b) => a[0] - b[0]);
    const firstLearned = sorted.find(([, lv]) => lv > 0);
    const maxLv = sorted.reduce((m, [, lv]) => (lv > m ? lv : m), 0);
    const isUlt = ultKeys.has(k);
    const linkedWith = linkedWithMap.get(k);
    const pdEntry = pdMap.get(k);
    const grantedBy = pdEntry?.granted_by === 'scepter' || pdEntry?.granted_by === 'shard' ? pdEntry.granted_by : null;
    const mayBeGranted = Boolean(grantedBy || CURRENT_GRANTED_ABILITIES.has(k));
    const isExactGranted = Boolean(grantedBy && pd.exact);
    const isLearnable = !mayBeGranted && (Boolean(pdEntry) || isUlt);
    const isMetadataNonPoint = isExactGranted || (!isLearnable && !mayBeGranted && innateMetaExact && Boolean(ALL_ABILITIES[k]));
    const isKnownInnate = !isExactGranted && isMetadataNonPoint && Boolean(firstLearned && firstLearned[0] <= trace.t0 + 2 && firstLearned[1] === 1);
    if (isMetadataNonPoint) nonPointKeys.add(k);
    else if (mayBeGranted) grantedUncertain = true;
    else if (!isLearnable) innateUncertain = true;

    const { cap, unknown: capUnknown } = isUlt || isMetadataNonPoint
      ? { cap: null, unknown: false }
      : abilityMaxLevel(k, pdEntry, ALL_ABILITIES[k], maxLv, Boolean(pdEntry) && !mayBeGranted);
    if (capUnknown) unknownMaxLevel = true;

    let highest = 0;
    let maxedRecorded = false;
    for (const [at, lv] of sorted) {
      if (!(lv > highest)) continue;
      const isInitialInnate = highest === 0 && isKnownInnate;
      const heroLevel = levelAt(trace, seatIndex, at);
      upgradeTimeline.push({
        clock: traceClock(at),
        t: at,
        hero_level: heroLevel,
        ability: k,
        name: abilityDisplayName(k),
        ability_level: lv,
        ...(isUlt ? { ultimate: true } : {}),
        ...(isExactGranted ? { granted_by: grantedBy } : {}),
        ...(linkedWith ? { linked_with: linkedWith } : {}),
        ...(isInitialInnate ? { initial: true, innate: true } : {}),
      });
      if (cap != null && !maxedRecorded && lv >= cap) {
        maxedRecorded = true;
        maxedEntries.push({
          t: at,
          ability: k,
          name: abilityDisplayName(k),
          level: lv,
          clock: traceClock(at),
          hero_level: heroLevel,
        });
      }
      highest = lv;
    }
  }

  upgradeTimeline.sort((a, b) => a.t - b.t || a.ability_level - b.ability_level || a.ability.localeCompare(b.ability));
  maxedEntries.sort((a, b) => a.t - b.t || a.ability.localeCompare(b.ability));

  const levelsArr = trace.states?.[seatIndex]?.level;
  const levelsMissing = !Array.isArray(levelsArr) || !levelsArr.some((v) => Number.isFinite(v));
  // If any hero ability entry is missing level samples, skill-point distributions and maxing order are
  // incomplete — fail closed to null rather than reporting partial totals as complete.
  const hasIncompleteLevels = missingLevelAbilities.length > 0;
  const ultLevelsIncomplete = missingLevelAbilities.some((k) => ultKeys.has(k));
  const atLevel6 = hasIncompleteLevels ? null : snapshotAtHeroLevel(trace, seatIndex, 6, heroAbilitiesList, nonPointKeys, linkedGroupKeyByMember);
  const atLevel10 = hasIncompleteLevels ? null : snapshotAtHeroLevel(trace, seatIndex, 10, heroAbilitiesList, nonPointKeys, linkedGroupKeyByMember);
  const maxedOrder = hasIncompleteLevels ? null : maxedEntries.map(({ t: _t, ...rest }) => rest);
  const ultimateLevels = ultLevelsIncomplete
    ? null
    : upgradeTimeline
      .filter((u) => u.ultimate === true)
      .map((u) => ({
        ability: u.ability,
        name: u.name,
        level: u.ability_level,
        clock: u.clock,
        hero_level: u.hero_level,
        ...(u.linked_with ? { linked_with: u.linked_with } : {}),
      }));

  return {
    ref: `skill_build:${slug}`,
    hero: slug,
    data_patch: pd.name,
    upgrade_timeline: upgradeTimeline,
    at_level_6: atLevel6,
    at_level_10: atLevel10,
    maxed_order: maxedOrder,
    ultimate_levels: ultimateLevels,
    ...(linkedUltimates.length ? { linked_ultimates: linkedUltimates } : {}),
    talents,
    note: 'Upgrade times come from replay ability-level samples. Innate and Scepter/Shard-granted abilities established by Valve patch metadata are excluded from at_level_6 / at_level_10 skill-point distributions (innates are marked innate: true, initial: true); normal learnable skills kept at level 1 stay included. Linked ultimates that level together on one skill point (e.g. Dark Willow Bedlam + Terrorize) stay listed in upgrade_timeline and ultimate_levels with linked_with, and are combined under a "+" key in at_level_6 / at_level_10 so each shared skill point is counted once. maxed_order records when each non-ultimate ability reaches its ability cap.',
    gaps: [
      ...(hasIncompleteLevels ? [{ topic: 'skill_build', reason: 'incomplete_ability_level_samples', abilities: missingLevelAbilities }] : []),
      ...(levelsMissing ? [{ topic: 'hero_levels', reason: 'level_samples_missing_in_trace' }] : []),
      ...(innateUncertain ? [{ topic: 'innate_abilities', reason: 'innate_metadata_unavailable_for_patch' }] : []),
      ...(grantedUncertain ? [{ topic: 'granted_abilities', reason: 'granted_ability_metadata_unavailable_for_patch' }] : []),
      ...(unknownMaxLevel ? [{ topic: 'maxed_order', reason: 'ability_max_level_unknown' }] : []),
      ...talentGap,
    ],
  };
}

export const SKILL_BUILD_TOOL = {
  name: 'skill_build',
  description: 'A hero\'s skill build from the replay: chronological ability upgrade timeline (`upgrade_timeline`), skill point distribution shortly after reaching level 6 (`at_level_6`) and level 10 (`at_level_10`), order in which non-ultimate abilities were maxed (`maxed_order`), ultimate leveling timings (`ultimate_levels`), and `talents` when available in match data (null with a gap when unavailable). Use this before commenting on skill-leveling choices.',
  input_schema: {
    type: 'object',
    properties: {
      hero: { type: 'string', description: 'Hero key as in match_overview, e.g. "beastmaster".' },
    },
    required: ['hero'],
    additionalProperties: false,
  },
  run: skillBuild,
};
