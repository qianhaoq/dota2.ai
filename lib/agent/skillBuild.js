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

const ABILITY_BY_ID = new Map(Object.values(ABILITIES.heroes ?? {}).flat().map((a) => [a.id, a]));
const slugOf = (hero) => String(hero ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_');

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

/**
 * Snapshot of non-innate ability levels shortly after the hero first reached `targetLevel`.
 * Returns `null` when level samples are missing, the hero never reached `targetLevel`, or
 * missing samples right before crossing `targetLevel` leave the timing unsettled.
 */
function snapshotAtHeroLevel(trace, seatIndex, targetLevel, heroAbilitiesList, initialOnlyKeys) {
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
    if (lv > 0) abilities[k] = lv;
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
  const heroAbilitiesList = rawAbilities && typeof rawAbilities === 'object'
    ? Object.entries(rawAbilities).filter(([k, e]) => {
      if (GENERIC_MAP_ABILITIES.has(k) || k.startsWith('plus_') || k.startsWith('seasonal_') || k.startsWith('special_bonus')) return false;
      if (!(pdMap.has(k) || k.startsWith(slugPrefix) || k.startsWith(internalPrefix))) return false;
      return Array.isArray(e?.levels) && e.levels.some(([, lv]) => lv > 0);
    })
    : [];

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
      gaps: [{ topic: 'skill_build', reason: 'no_ability_levels_in_trace' }, ...talentGap],
    };
  }

  const upgradeTimeline = [];
  const initialOnlyKeys = new Set();
  const maxedEntries = [];

  for (const [k, entry] of heroAbilitiesList) {
    const sorted = [...entry.levels].sort((a, b) => a[0] - b[0]);
    const maxLv = sorted.reduce((m, [, lv]) => (lv > m ? lv : m), 0);
    const isUlt = ultKeys.has(k);
    let highest = 0;
    let maxedRecorded = false;
    for (const [at, lv] of sorted) {
      if (!(lv > highest)) continue;
      const isInitial = highest === 0 && lv === 1 && maxLv === 1 && at <= trace.t0 + 2;
      if (isInitial) initialOnlyKeys.add(k);
      const heroLevel = levelAt(trace, seatIndex, at);
      upgradeTimeline.push({
        clock: traceClock(at),
        t: at,
        hero_level: heroLevel,
        ability: k,
        name: abilityDisplayName(k),
        ability_level: lv,
        ...(isUlt ? { ultimate: true } : {}),
        ...(isInitial ? { initial: true } : {}),
      });
      if (!isUlt && !maxedRecorded && lv >= 4) {
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
  const atLevel6 = snapshotAtHeroLevel(trace, seatIndex, 6, heroAbilitiesList, initialOnlyKeys);
  const atLevel10 = snapshotAtHeroLevel(trace, seatIndex, 10, heroAbilitiesList, initialOnlyKeys);
  const maxedOrder = maxedEntries.map(({ t: _t, ...rest }) => rest);
  const ultimateLevels = upgradeTimeline
    .filter((u) => u.ultimate === true)
    .map((u) => ({ ability: u.ability, name: u.name, level: u.ability_level, clock: u.clock, hero_level: u.hero_level }));

  return {
    ref: `skill_build:${slug}`,
    hero: slug,
    data_patch: pd.name,
    upgrade_timeline: upgradeTimeline,
    at_level_6: atLevel6,
    at_level_10: atLevel10,
    maxed_order: maxedOrder,
    ultimate_levels: ultimateLevels,
    talents,
    note: 'Upgrade times come from replay ability-level samples. Abilities already at level 1 at trace start that never leveled further (such as innate abilities) are marked initial: true and omitted from at_level_6 / at_level_10 point distributions.',
    gaps: [
      ...(levelsMissing ? [{ topic: 'hero_levels', reason: 'level_samples_missing_in_trace' }] : []),
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
