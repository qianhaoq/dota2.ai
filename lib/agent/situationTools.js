/**
 * Situation tools for the review agent: what the player was up against, and
 * what their own choices answered — so the review reads the game before it
 * judges it, and its advice names an item or a moment instead of a virtue.
 *
 * - build_check: where the damage in the player's deaths came from (whose
 *   attacks, whose spells), what each big item the player bought is for
 *   (the site's curated answer lists plus the stats Valve lists for it —
 *   never "offensive" or "defensive" from memory), the gold put into each
 *   purpose, for the enemies who killed them most what their abilities do
 *   (Valve's text) and what pros build against them, and the hero's most-built professional items next
 *   to when the player had them and when the enemies had their gap closers.
 *
 * - power_spikes: when each side became strong — the levels 6 / 12 / 18 and
 *   the big items of the player and of every enemy, the levels at 10:00,
 *   20:00 and 30:00, how often each enemy killed the player before and after
 *   each of that enemy's items, and how the player's hero usually fares
 *   against each enemy hero (public games of the bracket, professional games).
 *
 * Both are pure functions of the replay trace and the repository's data
 * snapshots. What the data does not say is left out or listed under gaps:
 * an item the lists do not classify has no purpose here, not a guessed one.
 */
import { createRequire } from 'node:module';
import { HEROES_BY_KEY } from '../../packages/review-engine/src/staticHeroes.js';
import { deathContext, itemTimeline, netWorthGraph, realDeaths, traceClock } from '../../packages/review-engine/src/trace/index.js';
import { stateAt } from '../../packages/review-engine/src/trace/query.js';
import { buildCoachReport, heroInfo as coachHeroInfo } from '../coach/analyze.js';
import { ALWAYS_KEY_ITEMS, ANSWERS, GAP_CLOSERS, KEY_ITEM_MIN_COST, THREAT_TAGS, archetypeOf } from '../coach/knowledge.js';
import { roleFromReplay } from './roleFromReplay.js';
import { isBigItemIn, patchData, patchForGame } from './patchData.js';
import { MIN_FEW_GAMES, proItemsFor } from './proItems.js';
import { ITEM_VS_SOURCE, MATCHUP_SOURCE, heroVs, itemLifts } from '../coach/matchups.js';
import { BRACKET_LABEL, RANK_SOURCE, heroVsRank, reviewBracket } from '../coach/matchupsRank.js';
import { ROLE_GROUP_LABEL, bracketItemsFor } from '../coach/bracketItems.js';

const require = createRequire(import.meta.url);
const ITEM_NAMES = require('../coach/data/names.json').items;
// Valve's description of each ability, from the current table: a release's snapshot keeps the flags, not the text.
const ABILITY_TEXT = require('../data/constants/abilities.json');
// OpenDota's hero constants by hero id: how each hero attacks (attack_type, attack_range).
const HERO_CONST = require('../data/constants/heroes.json');
// OpenDota's item constants: whom an item's active is cast on (target_team), which a release's snapshot does not keep.
const ITEM_CONST = require('../data/constants/items.json');
// What abilities and items did in archived replays (scripts/observe-effects.mjs, #508): where their modifiers landed
// and the engine's state of a hero under each. Absent → nothing observed is said.
const OBSERVED = (() => { try { return require('../coach/data/observed-effects.json'); } catch { return null; } })();
const DMG_WORD = { P: 'physical', M: 'magical', U: 'pure' };
/** How many of the enemies who did the most to the player's deaths get their own answers. */
const TOP_KILLERS = 2;

// By the key a replay uses for the hero, which is not always the internal slug ("queen_of_pain" for queenofpain).
const BY_SLUG = HEROES_BY_KEY;
const slugOf = (hero) => String(hero ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_');
const r2 = (n) => Math.round(n * 100) / 100;
const itemName = (key, lang) => ITEM_NAMES[key]?.[lang] ?? key;
const GAP = new Set(GAP_CLOSERS);

/** What an item answers, from the curated lists (either role's): "magic", "physical", "disable"… */
const ANSWER_TAGS = (() => {
  const out = new Map();
  for (const [tag, byRole] of Object.entries(ANSWERS)) for (const key of [...byRole.core, ...byRole.support]) out.set(key, (out.get(key) ?? new Set()).add(tag));
  return out;
})();
const PURPOSE_OF_TAG = {
  magic: 'answer_to_spell_damage', physical: 'answer_to_attack_damage', disable: 'answer_to_disables', silence: 'answer_to_silences',
  evasion: 'answer_to_evasion', invisibility: 'answer_to_invisibility', illusions: 'answer_to_illusions', healing: 'answer_to_healing',
};
/** Valve's item stats that say what an item protects against or adds, in words. Anything else is not read. */
const STAT_WORDS = {
  bonus_magical_armor: 'magic_resistance_percent', bonus_spell_resist: 'magic_resistance_percent', magic_resistance: 'magic_resistance_percent',
  bonus_armor: 'armor', bonus_evasion: 'evasion_percent', bonus_health: 'health', bonus_damage: 'attack_damage', bonus_attack_speed: 'attack_speed',
  bonus_strength: 'strength', bonus_all_stats: 'all_attributes', spell_amp: 'spell_amplification_percent', bonus_movement_speed: 'movement_speed',
  bonus_agility: 'agility', bonus_intellect: 'intelligence', bonus_mana: 'mana', bonus_mana_regen: 'mana_regen', bonus_health_regen: 'health_regen',
};
/** OpenDota's primary attribute words. */
const ATTR_WORD = { str: 'strength', agi: 'agility', int: 'intelligence', all: 'universal' };
/** What Valve's data lists for an item: its cost, the stats above, and its active or passive in Valve's own words. */
/** `items`: the item data of the game's patch (patchData). */
function itemFacts(key, items) {
  const it = items[key];
  if (!it) return {};
  const gives = {};
  for (const a of it.attrib ?? []) { const w = STAT_WORDS[a?.key]; const v = Number(a?.value); if (w && Number.isFinite(v) && v !== 0 && gives[w] === undefined) gives[w] = v; }
  const does = (it.abilities ?? []).filter((a) => a?.title && a?.description).slice(0, 2).map((a) => ({ kind: a.type, title: a.title, valve_text: String(a.description).replace(/\s+/g, ' ').slice(0, 320) }));
  return { ...(Number.isFinite(it.cost) ? { cost: it.cost } : {}), ...(Object.keys(gives).length ? { gives } : {}), ...(does.length ? { does } : {}) };
}
/**
 * What an item is for, as far as the data says: the curated answer lists, a gap closer, and — from Valve's stats —
 * magic resistance or armor. Empty when the data does not classify it: that is "not classified", not "offensive".
 */
function purposesOf(key, items) {
  const out = new Set();
  if (GAP.has(key)) out.add('initiation_or_gap_closer');
  for (const tag of ANSWER_TAGS.get(key) ?? []) out.add(PURPOSE_OF_TAG[tag]);
  const gives = itemFacts(key, items).gives ?? {};
  if (gives.magic_resistance_percent) out.add('magic_resistance');
  if (gives.armor >= 4) out.add('armor');
  return [...out];
}
/**
 * What an item does to attack damage or to spell damage, read off Valve's data for the game's patch (its stats and
 * its active's or passive's own words), never from a list of the site's: "disarms_target" (Heaven's Halberd: "Prevents a
 * target from attacking"), "moves_a_unit" (Force Staff), "physical_immunity" (Ghost Scepter)… Empty when Valve's data
 * says none of these. #495: build_check named only the items pros lift against a hero (Eul's Scepter against Ursa),
 * and the model reached past Halberd and Force Staff for Shiva's Guard, lifted against two other enemies.
 */
/** Armor on its own is named from this much on (Lotus Orb 10, Shiva's Guard 17); a few points ride on many items. */
const ARMOR_WORTH_NAMING = 8;
const ATTACK_WAYS = [
  ['disarms_target', (it, text) => /disarm|prevents a target from attacking/i.test(text)],
  ['physical_immunity', (it, text) => /immune to physical damage/i.test(text)],
  ['moves_a_unit', (it) => stat(it, 'push_length') > 0],
  ['makes_a_unit_invulnerable', (it) => stat(it, 'cyclone_duration') > 0],
  ['lowers_enemy_attack_speed', (it) => (it.attrib ?? []).some((a) => /attack_speed/.test(a?.key ?? '') && Number(a?.value) < 0)],
  ['returns_attack_damage', (it) => (it.attrib ?? []).some((a) => /reflection/.test(a?.key ?? ''))],
  ['blocks_attack_damage', (it, text) => stat(it, 'block_damage_melee') > 0 || /physical damage barrier/i.test(text)],
  ['evasion', (it) => stat(it, 'bonus_evasion') > 0],
  ['armor', (it) => stat(it, 'bonus_armor') >= ARMOR_WORTH_NAMING],
];
/** The dispel an item applies, in Valve's words ("Dispel Type: Basic Dispel", "Applies a strong dispel"): 'strong', 'basic' or null. */
function dispelOf(text) {
  if (/strong dispel/i.test(text)) return 'strong';
  if (/basic dispel|dispels? the target/i.test(text)) return 'basic';
  return null;
}
/**
 * On whom an item's dispel lands: 'an_enemy_target' (OpenDota's target_team Enemy or Both, or Valve's "can only be
 * cast on enemy units or yourself" — Eul's), 'self_or_allies' (no target, or Friendly), or null when neither says.
 */
function dispelTarget(key, text) {
  const team = ITEM_CONST[key]?.target_team;
  const teams = (Array.isArray(team) ? team : [team]).filter(Boolean);
  if (teams.includes('Enemy') || teams.includes('Both') || /can (?:only )?be cast on[^.]*enemy units|dispels the target/i.test(text)) return 'an_enemy_target';
  const beh = ITEM_CONST[key]?.behavior;
  if (teams.includes('Friendly') || (Array.isArray(beh) ? beh : [beh]).includes('No Target') || /applies a (basic|strong) dispel|is applied and you/i.test(text)) return 'self_or_allies';
  return null;
}
const DISPEL_WAY = ['applies_a_dispel', (it, text) => dispelOf(text) != null];
ATTACK_WAYS.push(DISPEL_WAY);
const SPELL_WAYS = [
  ['spell_immunity', (it, text) => /negative effect from enemy spells has no effect|debuff immunity to (yourself|you)/i.test(text)],
  ['magic_damage_barrier', (it, text) => /magic damage barrier/i.test(text)],
  ['reflects_or_blocks_targeted_spells', (it, text) => /re-casts most targeted spells|blocks most targeted spells/i.test(text)],
  ['makes_a_unit_invulnerable', (it) => stat(it, 'cyclone_duration') > 0],
  ['magic_resistance', (it) => ['bonus_magical_armor', 'bonus_spell_resist', 'magic_resistance', 'spell_reduce'].some((k) => stat(it, k) > 0)],
];
function stat(it, key) { const a = (it?.attrib ?? []).find((x) => x?.key === key); const v = parseFloat(String(a?.value ?? '')); return Number.isFinite(v) ? v : null; }
function waysOf(it, ways) {
  const text = (it?.abilities ?? []).map((a) => `${a?.title ?? ''}: ${a?.description ?? ''}`).join(' ');
  return ways.filter(([, test]) => test(it, text)).map(([w]) => w);
}
/**
 * How a hero attacks, from OpenDota's hero constants: { type: 'melee' | 'ranged', range? }, or null when the
 * constants do not hold the hero or its attack type (unknown, never a guess).
 * @param {number | string | null | undefined} heroId
 * @param {Record<string, { attack_type?: string, attack_range?: number }>} [constants]
 */
export function attackOf(heroId, constants = HERO_CONST) {
  const h = heroId == null ? null : constants?.[String(heroId)];
  const type = typeof h?.attack_type === 'string' ? h.attack_type.toLowerCase() : null;
  if (type !== 'melee' && type !== 'ranged') return null;
  return { type, ...(Number.isFinite(h.attack_range) ? { range: h.attack_range } : {}) };
}
/** Seconds without damage that end a run of an enemy's damage to the player (the trace logs damage per second). */
const CONTACT_GAP = 2;
/** How far before a death the killer's damage must reach for the death to have a run at all. */
const CONTACT_LOOKBACK = 20;
/**
 * How an enemy killed the player, death by death, from the trace's damage log (summed per second): when their last
 * unbroken run of damage on the player began (no gap over CONTACT_GAP s), how many seconds it lasted to the death,
 * their attack and ability damage in it, and the player's health when it began. Each death they were the killer of,
 * numbered as death_context numbers the player's deaths (`death`). The run is followed back to its real gap however
 * long it lasted (#504 review: a cut at the look-back would have given a made-up start). Null without a damage log; a
 * death in which they did no damage in the last CONTACT_LOOKBACK s has `contact_seconds: null` (not 0).
 */
export function contactBeforeDeaths(trace, h, enemyKey) {
  if (!Array.isArray(trace?.damage) || !Array.isArray(trace?.names)) return null;
  const me = trace.names.indexOf(trace.heroes[h]?.npc);
  const enemy = trace.heroes.find((x) => x.key === enemyKey);
  const them = enemy ? trace.names.indexOf(enemy.npc) : -1;
  if (me < 0 || them < 0) return null;
  const mine = realDeaths(trace).filter((d) => d[1] === me);
  return mine.map((d, i) => ({ d, n: i + 1 })).filter(({ d }) => d[2] === them).map(({ d, n }) => {
    const t = d[0];
    const bySec = new Map();
    for (const [sec, a, target, infl, value] of trace.damage) {
      if (a !== them || target !== me || sec > t) continue;
      const x = bySec.get(sec) ?? { attacks: 0, abilities: 0 };
      if (infl >= 0) x.abilities += value; else x.attacks += value;
      bySec.set(sec, x);
    }
    const secs = [...bySec.keys()].sort((a, b) => a - b);
    // Damage of theirs only long before (an earlier fight): no run that ended in this death.
    if (!secs.length || secs[secs.length - 1] < Math.floor(t) - CONTACT_LOOKBACK) return { death: n, clock: traceClock(t), contact_seconds: null };
    let start = secs[secs.length - 1];
    for (let k = secs.length - 2; k >= 0 && start - secs[k] <= CONTACT_GAP; k -= 1) start = secs[k];
    let attacks = 0; let abilities = 0;
    for (const sec of secs) if (sec >= start) { attacks += bySec.get(sec).attacks; abilities += bySec.get(sec).abilities; }
    const s = stateAt(trace, h, start);
    // What they cast in the 15 s before it, on anything (their own buffs included: Overpower, Enrage).
    const theirCasts = Array.isArray(trace.casts) ? trace.casts.filter((c) => c[1] === them && c[0] >= t - 15 && c[0] <= t)
      .map((c) => ({ ability: trace.names[c[2]], dt: Math.round((c[0] - t) * 10) / 10, target: c[3] === them ? 'self' : c[3] < 0 ? 'none' : c[3] === me ? 'me' : trace.heroes.find((x) => x.npc === trace.names[c[3]])?.key ?? 'other' })) : null;
    return {
      death: n, clock: traceClock(t), began: traceClock(start),
      ...(theirCasts ? { their_casts_in_the_15s_before: theirCasts } : {}),
      contact_seconds: Math.max(1, Math.round((t - start) * 10) / 10),
      their_attack_damage: Math.round(attacks), their_ability_damage: Math.round(abilities),
      ...(s && Number.isFinite(s.hp) ? { my_hp_when_it_began: s.hp, my_max_hp: s.max_hp } : {}),
    };
  });
}
/** A state counts as what a hero under a modifier is when at least this share of its samples had it (a sample can trail the engine by a tick at either end). */
const STATE_SHARE = 0.9;
/** Fewer state samples than this under a modifier say nothing about it. */
const MIN_STATE_SAMPLES = 8;
/**
 * The modifiers a source (`ability:<key>` or `item:<key>`) put on heroes in the observed replays, the main one first:
 * the one named exactly after it (`modifier_<key>`), else every one named after it.
 */
function observedModifiers(source, observed) {
  const mods = observed?.sources?.[source]?.modifiers;
  if (!mods) return [];
  const key = source.split(':')[1];
  const exact = mods[`modifier_${key}`];
  return exact ? [[`modifier_${key}`, exact]] : Object.entries(mods);
}
/**
 * Where an ability's effect sat in the observed replays: 'on_them' (only ever on the caster or the caster's allies),
 * 'on_the_player' (only ever on enemy heroes), with how many times and in how many games. Null when it was never seen
 * on a hero, or seen on both sides (Ghost Shroud: on Necrophos and, as an aura, on his enemies) — not placed.
 */
export function observedPlacement(abilityKey, observed = OBSERVED) {
  const mods = observedModifiers(`ability:${abilityKey}`, observed);
  let mine = 0; let theirs = 0; let games = 0;
  for (const [, m] of mods) { mine += (m.self ?? 0) + (m.ally_hero ?? 0); theirs += m.enemy_hero ?? 0; games = Math.max(games, m.games ?? 0); }
  if (mine > 0 && theirs === 0) return { sits: 'on_them', seen: mine, games };
  if (theirs > 0 && mine === 0) return { sits: 'on_the_player', seen: theirs, games };
  return null;
}
/**
 * The engine's state of a hero while an item's effect was on it, in the observed replays: each state at least
 * STATE_SHARE of the samples had (stunned, disarmed, invulnerable…), the samples (a debuff-immune target's are not
 * among them), games, and how often it was put on an enemy hero. Null without enough samples or with no such state.
 */
export function observedTargetState(itemKey, observed = OBSERVED) {
  const best = observedModifiers(`item:${itemKey}`, observed).filter(([, m]) => (m.target_state?.samples ?? 0) >= MIN_STATE_SAMPLES)
    .sort((a, b) => b[1].target_state.samples - a[1].target_state.samples)[0];
  if (!best) return null;
  const [modifier, m] = best;
  const n = m.target_state.samples;
  const states = Object.entries(m.target_state).filter(([k, v]) => k !== 'samples' && k !== 'samples_while_debuff_immune' && v / n >= STATE_SHARE).map(([k]) => k).sort();
  void modifier;
  // Nothing stood out (a slow, a mute the extract has no flag for): no states to say, so nothing is said.
  if (!states.length) return null;
  return { states, samples: n, games: m.games ?? null, ...(m.enemy_hero > 0 ? { on_enemy_heroes: m.enemy_hero } : {}) };
}
/**
 * How often an item's effect was seen taking an ability's modifier off a hero it landed on, landing on one of `sides`
 * (`enemy_hero`, or `self` / `ally_hero`), in the observed replays: { removed, games }, or null when never seen.
 */
export function observedRemoval(itemKey, abilityKey, sides, observed = OBSERVED) {
  const removals = observed?.removals?.[`item:${itemKey}`];
  const mods = observed?.sources?.[`ability:${abilityKey}`]?.modifiers;
  if (!removals || !mods) return null;
  // The data counts games per removed modifier, over every side: the games of this side alone are known only when all
  // of that modifier's removals were on it (#510 review: Plasma Field off an enemy once, games 2) — otherwise null.
  let removed = 0; let games = 0; let gamesKnown = true;
  for (const name of Object.keys(mods)) {
    const r = removals[name];
    if (!r) continue;
    const n = sides.reduce((x, s) => x + (r.on?.[s] ?? 0), 0);
    if (n === 0) continue;
    removed += n;
    if (n === r.removed && Number.isFinite(r.games)) games = Math.max(games, r.games); else gamesKnown = false;
  }
  return removed > 0 ? { removed, games: gamesKnown ? games : null } : null;
}
/**
 * The enemy's abilities an item's dispel removes, as two facts both required: Valve marks the ability removable by that
 * dispel (`dispel`: basic, or strong too for a strong dispel), and the item was seen, in the observed replays, removing
 * that ability's modifier as it landed on that side (cast on an enemy, or on the player and allies). A removal at the
 * same instant alone can be an expiry or another effect (#510 review: Berserker's Call, which Valve marks
 * undispellable, "removed" by Black King Bar). [{ name, removed, games }]; [] when this item was seen removing
 * modifiers and none of these; null when that is not known.
 * @param {string} itemKey
 * @param {'an_enemy_target' | 'self_or_allies' | null} on
 * @param {'basic' | 'strong' | null} dispel
 * @param {{ id: string, en?: string, zh?: string, dispel?: string }[] | null} kit  the enemy's abilities (patchData heroAbilities)
 */
export function effectsRemovedBy(itemKey, on, dispel, kit, lang = 'en', observed = OBSERVED) {
  const side = on === 'an_enemy_target' ? ['enemy_hero'] : on === 'self_or_allies' ? ['self', 'ally_hero'] : null;
  // Unknown, not "none" (#510 review): no landing side, no dispel, no kit, no observations, or this item never seen
  // removing anything in them — null. [] only when this item's removals were seen and none is one of these abilities.
  if (!side || !dispel || !Array.isArray(kit) || !observed?.removals?.[`item:${itemKey}`]) return null;
  return kit.filter((a) => a.dispel === 'basic' || (dispel === 'strong' && a.dispel === 'strong'))
    .map((a) => ({ a, r: observedRemoval(itemKey, a.id, side, observed) })).filter(({ r }) => r)
    .map(({ a, r }) => ({ name: a[lang] ?? a.en, removed: r.removed, games: r.games }));
}
/** How long an item's effect lasts, from Valve's stats: a disarm, a cyclone, ghost or ethereal form. Null when not stated. */
function lastsSeconds(it, how) {
  if (how.includes('disarms_target')) return stat(it, 'disarm_melee') ?? stat(it, 'disarm_range') ?? stat(it, 'duration');
  if (how.includes('makes_a_unit_invulnerable')) return stat(it, 'cyclone_duration');
  if (how.includes('physical_immunity')) return stat(it, 'duration');
  return null;
}
/** The player's hero for an item choice: primary attribute, attack, and deaths with a spell off cooldown but no mana. */
export function myHeroFacts(heroId, deaths) {
  const h = HERO_CONST[String(heroId)];
  const attr = ATTR_WORD[h?.primary_attr] ?? null;
  // Only a death whose mana the trace shows (most_mana_in_window) can say it was short of it: an older trace without
  // mana samples is unknown (null), never "no death was short of mana" (#504 review).
  const list = Array.isArray(deaths?.deaths) ? deaths.deaths : [];
  const known = list.filter((d) => Number.isFinite(d?.most_mana_in_window));
  const short = known.filter((d) => Array.isArray(d.off_cooldown_without_the_mana) && d.off_cooldown_without_the_mana.length > 0);
  return {
    primary_attribute: attr, attack: attackOf(heroId),
    deaths_with_a_spell_off_cooldown_but_short_of_mana: known.length ? short.length : null,
    ...(known.length ? { of_deaths_with_mana_known: known.length } : {}),
    ...(short.length ? { at: short.map((d) => d.clock) } : {}),
  };
}
/** At most this many shop items per enemy, cheapest first. */
const MAX_ITEMS_ON_THEIR_DAMAGE = 18;

/**
 * The player's role and how the hero is played in this game:
 * 1. OpenDota parsed lanes (`match_record_lanes`) when the match record has full 1–5 lane roles;
 * 2. Replay-based 1–5 inference (`roleFromReplay`: lanes from 1:00–10:00 positions + 0–10m farm, or
 *    replay lanes + scoreboard on legacy traces without creep_kills/gold);
 * 3. Unparsed scoreboard GPM rank (`scoreboard_farm`) only when replay positions are missing;
 * 4. Null (unknown, with `gaps`) when neither match nor replay can settle it.
 */
function roleOf(match, hero, trace = null, seatKey = null) {
  let coachRole = null;
  let coachHero = null;
  let patch = Number.isInteger(match?.patch) ? match.patch : null;
  let bracket = null;
  if (match) {
    try {
      const report = buildCoachReport(match);
      const me = report.players.find((p) => p.hero?.id === hero.id);
      coachHero = me?.hero ?? null;
      coachRole = me ? report.reviews?.[me.slot]?.role ?? null : null;
      bracket = me ? reviewBracket(report.players, me)?.key ?? null : null;
    } catch { /* fall through to replay inference */ }
  }
  if (coachRole?.source === 'lanes' && coachRole.kind) {
    return {
      kind: coachRole.kind,
      pos: Number.isInteger(coachRole.pos) ? coachRole.pos : null,
      archetype: coachHero ? archetypeOf(coachHero, coachRole) : archetypeOf(coachHeroInfo(hero.id), coachRole),
      patch,
      bracket,
      source: 'match_record_lanes',
      gaps: [],
    };
  }
  const rep = trace && seatKey ? roleFromReplay(trace, seatKey, match) : { pos: null, kind: null, source: null, gaps: [] };
  if (rep.kind) {
    const meta = coachHero ?? coachHeroInfo(hero.id);
    return {
      kind: rep.kind,
      pos: rep.pos,
      archetype: archetypeOf(meta, { kind: rep.kind, pos: rep.pos }),
      patch,
      bracket,
      source: rep.source,
      gaps: [],
    };
  }
  if (coachRole?.kind) {
    return {
      kind: coachRole.kind,
      pos: Number.isInteger(coachRole.pos) ? coachRole.pos : null,
      archetype: coachHero ? archetypeOf(coachHero, coachRole) : archetypeOf(coachHeroInfo(hero.id), coachRole),
      patch,
      bracket,
      source: 'scoreboard_farm',
      gaps: [],
    };
  }
  return { kind: null, pos: null, archetype: null, patch, bracket, source: null, gaps: rep.gaps };
}

/**
 * The player's economy in this game, from the match record or the replay trace (null when neither has it).
 * Used to give candidate items an honest `estimated_minutes_of_my_farm` so poor supports are not told to
 * buy core-priced items without seeing the gold cost in minutes of their own income.
 */
function economyOf(trace, seatIndex, hero, match) {
  const fort = (trace.buildings ?? []).find((b) => /_fort$/.test(trace.names?.[b[1]] ?? ''));
  const durationSec = Number.isFinite(match?.duration) && match.duration > 0
    ? match.duration
    : fort ? fort[0] : (Number.isFinite(trace.t0) && trace.n > 0 ? trace.t0 + trace.n - 1 : null);
  const durationMin = durationSec && durationSec > 0 ? durationSec / 60 : null;
  const nx = trace.names?.indexOf(trace.heroes[seatIndex].npc) ?? -1;
  const logGoldBefore = (minLimit) => {
    if (!Array.isArray(trace.gold) || nx < 0) return null;
    let sum = 0;
    for (const g of trace.gold) if (g[1] === nx && g[0] < minLimit && g[2] !== 6 && g[3] > 0) sum += g[3];
    return sum;
  };
  const nwArr = Array.isArray(trace.net_worth?.[seatIndex]) && trace.net_worth[seatIndex].length ? trace.net_worth[seatIndex] : null;
  const nwGraph = netWorthGraph(trace);
  const nwAt20 = nwGraph && nwGraph[seatIndex].length > 20 && Number.isFinite(nwGraph[seatIndex][20]) ? Math.round(nwGraph[seatIndex][20]) : null;
  const p = Array.isArray(match?.players) ? match.players.find((x) => x && x.hero_id === hero.id) : null;
  if (p && Number.isFinite(p.gold_per_min) && p.gold_per_min > 0) {
    let gold20 = null;
    let gold20Source = null;
    if (Array.isArray(p.gold_t) && Number.isFinite(p.gold_t[20])) {
      gold20 = Math.round(p.gold_t[20]);
      gold20Source = 'match_record';
    } else if (durationMin && durationMin >= 20) {
      const log20 = logGoldBefore(20);
      if (log20 != null) {
        gold20 = Math.round(log20);
        gold20Source = 'replay_gold_log';
      }
    }
    return {
      source: 'match_record',
      gold_per_min: Math.round(p.gold_per_min),
      net_worth: Number.isFinite(p.net_worth) ? Math.round(p.net_worth) : null,
      gold_at_20_00: gold20,
      ...(gold20Source ? { gold_at_20_00_source: gold20Source } : {}),
      ...(gold20 == null && nwAt20 != null ? { net_worth_at_20_00: nwAt20 } : {}),
    };
  }
  if (Array.isArray(trace.gold) && durationMin && nx >= 0) {
    const earned = logGoldBefore(Infinity);
    if (earned != null && earned > 0) {
      const gold20 = durationMin >= 20 ? Math.round(logGoldBefore(20) ?? 0) : null;
      return {
        source: 'replay_gold_log',
        gold_per_min: Math.round(earned / durationMin),
        gold_earned_in_log: Math.round(earned),
        gold_at_20_00: gold20,
        ...(gold20 != null ? { gold_at_20_00_source: 'replay_gold_log' } : {}),
      };
    }
  }
  if (nwArr) {
    const endNw = nwArr.at(-1);
    if (Number.isFinite(endNw) && endNw > 0) {
      // Net worth is retained wealth, not total income: preserve it, but keep GPM and farm-time estimates unknown (Codex P1 on #465).
      return {
        source: 'replay_net_worth',
        gold_per_min: null,
        net_worth: Math.round(endNw),
        ...(nwAt20 != null ? { net_worth_at_20_00: nwAt20 } : {}),
      };
    }
  }
  return null;
}
/** Which patch the numbers are from, and — when that is not the game's own — why, for the gaps. */
const dataPatch = (pd) => ({ data_patch: pd.name, ...(pd.hotfix ? { data_hotfix: pd.hotfix.slice(0, 10) } : {}), ...(pd.how ? { patch_known_from: pd.how } : {}) });
const patchGap = (pd) => (pd.exact ? [] : [{ topic: 'item_and_ability_data_of_this_game_patch', reason: `${pd.reason}; ${pd.name} data used` }]);
const curatedTraits = (slug) => Object.entries(THREAT_TAGS).filter(([, list]) => list.includes(slug)).map(([tag]) => tag);

const partsOf = (key, items, seen = new Set()) => { for (const c of items[key]?.components ?? []) if (!seen.has(c)) { seen.add(c); partsOf(c, items, seen); } return seen; };
/**
 * For items in the order they were first held: what each cost on top of the listed items it was built from, or
 * null when it was built from none of them. A part is used up by the item built from it: Kaya, then Meteor
 * Hammer, then Starforge is the Starforge's price less the Meteor Hammer's (the Kaya went into the Meteor
 * Hammer), and a Soul Booster that went into a Bloodstone is not there to make an Octarine Core cheaper — the
 * timeline keeps one first-held time per item, so a second copy bought later is paid for in full here.
 * @param {string[]} keys
 * @returns {(number | null)[]}
 */
export function goldOnTop(keys, items = patchData(null).items) {
  const free = new Set();
  return keys.map((key) => {
    const cost = items[key]?.cost;
    const used = [...partsOf(key, items)].filter((k) => free.has(k));
    for (const k of used) free.delete(k);
    free.add(key);
    const already = used.reduce((a, k) => a + (items[k]?.cost ?? 0), 0);
    return already && Number.isFinite(cost) ? Math.max(0, cost - already) : null;
  });
}

export function buildCheck(trace, args = {}, ctx = {}) {
  const slug = slugOf(args.hero);
  const seatIndex = trace.heroes.findIndex((h) => h.key === slug);
  const seat = seatIndex >= 0 ? trace.heroes[seatIndex] : null;
  const hero = BY_SLUG.get(slug);
  if (!seat || !hero) return { error: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
  const lang = ctx.lang === 'zh' ? 'zh' : 'en';
  const enemies = trace.heroes.filter((h) => h.team !== seat.team);
  const role = roleOf(ctx.match, hero, trace, slug);
  const economy = economyOf(trace, seatIndex, hero, ctx.match);
  // Prices, recipes and what an item does, as they were in this game's patch.
  const pd = patchForGame(trace.match_id, ctx.match);
  const big = (k) => isBigItemIn(pd, k, { minCost: KEY_ITEM_MIN_COST, always: ALWAYS_KEY_ITEMS });

  // Where the damage in the deaths came from: the death tool's own shares, regrouped by enemy.
  // Every source, not the six largest the death tool shows: the two sums below are over all of it.
  const deaths = deathContext(trace, { hero: slug, all_damage_sources: true });
  const shares = deaths.error ? {} : deaths.damage_share_in_death_windows ?? {};
  const kills = deaths.error ? {} : deaths.killed_by ?? {};
  // Summed from the amounts, not from the rounded shares, and over the enemy heroes only: a tower's or a creep's
  // damage is in the total but in neither sum.
  const amounts = deaths.error ? {} : deaths.damage_in_death_windows ?? {};
  const total = deaths.error ? 0 : deaths.damage_in_death_windows_total ?? 0;
  const sum = (suffix) => (total ? r2(enemies.reduce((a, e) => a + (amounts[`${e.key}${suffix}`] ?? 0), 0) / total) : 0);
  const fromAttacks = sum(': attacks'); const fromSpells = sum(': abilities and items');
  const byEnemy = enemies.map((e) => ({
    enemy: e.key, kills_of_me: kills[e.key] ?? 0,
    share_from_their_attacks: shares[`${e.key}: attacks`] ?? 0, share_from_their_abilities_and_items: shares[`${e.key}: abilities and items`] ?? 0,
    ...(curatedTraits(e.key).length ? { known_for: curatedTraits(e.key) } : {}),
  })).filter((e) => e.kills_of_me || e.share_from_their_attacks || e.share_from_their_abilities_and_items)
    .sort((a, b) => (b.share_from_their_attacks + b.share_from_their_abilities_and_items) - (a.share_from_their_attacks + a.share_from_their_abilities_and_items));

  // The player's big items in the order they were first held, each with purchase vs delivery timing and what the data says it is for.
  const myAghs = typeof pd.aghsUpgrades === 'function' ? pd.aghsUpgrades(hero.id, lang) : null;
  const heroAghsNote = (key) => {
    if ((key === 'ultimate_scepter' || key === 'ultimate_scepter_2') && myAghs?.scepter?.length) return { for_this_hero: myAghs.scepter };
    if (key === 'aghanims_shard' && myAghs?.shard?.length) return { for_this_hero: myAghs.shard };
    return {};
  };
  const timelineRes = itemTimeline(trace, { hero: slug }, { ...ctx, perspective: slug, patchItems: pd.items });
  const timeline = timelineRes.items ?? [];
  const firstHeld = new Map(timeline.map((i) => [i.item, i.first_held]));
  const mine = timeline.filter((i) => big(i.item)).sort((a, b) => a.first_held.t - b.first_held.t)
    // No ref of their own: cost, purpose and Valve's text are this record's, cited as build:<hero>.
    .map((i) => ({
      item: i.item,
      name: itemName(i.item, lang),
      first_held: i.first_held.clock,
      first_purchased: i.first_purchased?.clock ?? null,
      ...(i.delivery_delay_seconds != null && i.delivery_delay_seconds > 0 ? { delivery_delay_seconds: i.delivery_delay_seconds } : {}),
      ...(i.delivery_delay_seconds != null && i.delivery_delay_seconds > 0
        ? {
          my_team_courier_deaths_during_delivery: i.my_team_courier_deaths_during_delivery == null
            ? null
            : i.my_team_courier_deaths_during_delivery.map(({ clock, killed_by }) => ({ clock, killed_by })),
        }
        : {}),
      ...itemFacts(i.item, pd.items),
      ...heroAghsNote(i.item),
      built_for: purposesOf(i.item, pd.items),
    }));
  // An item built from a big item the player already held (Blink Dagger into Arcane Blink) cost only the rest:
  // the part is not paid for twice.
  const onTop = goldOnTop(mine.map((i) => i.item), pd.items);
  mine.forEach((i, n) => { if (onTop[n] != null) i.gold_on_top_of_items_already_held = onTop[n]; });
  const goldBy = {};
  for (const i of mine) for (const p of (i.built_for.length ? i.built_for : ['not_classified'])) { goldBy[p] ??= { gold: 0, items: [], first_at: i.first_held }; goldBy[p].gold += i.gold_on_top_of_items_already_held ?? i.cost ?? 0; goldBy[p].items.push(i.name); }

  // The enemies who killed the player most, one by one: what each one's abilities do (Valve's words), the shop's items
  // whose Valve data acts on that kind of damage, and the items pros on this hero build clearly more often against that
  // hero. There is no curated list of "items that answer attack (or spell) damage" here: cut to a role, it hid Eul's
  // Scepter, the item pros on Tidehunter build against Ursa, and put Shiva's Guard in front of the model (owner,
  // 2026-11-27). What Valve's data says each item does is not cut to a role (#495). The model weighs the items itself.
  const killers = [...byEnemy].sort((a, b) => b.kills_of_me - a.kills_of_me
    || (b.share_from_their_attacks + b.share_from_their_abilities_and_items) - (a.share_from_their_attacks + a.share_from_their_abilities_and_items))
    .filter((e) => e.kills_of_me > 0).slice(0, TOP_KILLERS);
  const itemEntry = (k) => {
    const facts = itemFacts(k, pd.items);
    const farmMin = economy?.gold_per_min > 0 && Number.isFinite(facts.cost) ? Math.round((facts.cost / economy.gold_per_min) * 10) / 10 : null;
    return { item: k, name: itemName(k, lang), ...facts, ...(farmMin != null ? { estimated_minutes_of_my_farm: farmMin } : {}), player_first_held: firstHeld.get(k)?.clock ?? null };
  };
  const shopBig = Object.keys(pd.items).filter((k) => pd.has(k) && big(k));
  const itemsActingOn = (e) => {
    const a = e.share_from_their_attacks; const b = e.share_from_their_abilities_and_items;
    if (!Number.isFinite(a) || !Number.isFinite(b) || a + b <= 0) return null;
    const against = a >= b ? 'attacks' : 'abilities';
    const ways = against === 'attacks' ? ATTACK_WAYS : SPELL_WAYS;
    const items = shopBig.map((k) => ({ k, how: waysOf(pd.items[k], ways) })).filter((x) => x.how.length)
      .sort((x, y) => (pd.items[x.k].cost ?? 0) - (pd.items[y.k].cost ?? 0) || x.k.localeCompare(y.k)).slice(0, MAX_ITEMS_ON_THEIR_DAMAGE);
    // What each item does, in Valve's numbers and words: the dispel it applies and on whom it lands, disarm durations,
    // whether it goes through debuff immunity.
    const other0 = BY_SLUG.get(e.enemy);
    const kitList = other0 ? pd.heroAbilities(other0.id) : null;
    // Of the enemy's abilities, the ones whose modifiers this item's effect was seen taking off a hero it landed on, on
    // the side it lands (cast on them, or on the player and allies): a dispel observed in archived replays, never joined
    // from an ability's dispel flag and where one of its modifiers sat (#510 review: Heavenly Jump's leap on Zeus is not
    // the effect its flag is about). Not seen → not listed (sparse: few replays hold that item on that hero).
    const removedBy = (k, on, dispel) => effectsRemovedBy(k, on, dispel, kitList, lang);
    const relation = (k) => {
      const it = pd.items[k];
      const text = (it?.abilities ?? []).map((x) => `${x?.title ?? ''}: ${x?.description ?? ''}`).join(' ');
      const dispel = dispelOf(text);
      const on = dispel ? dispelTarget(k, text) : null;
      const disarm = { melee: stat(it, 'disarm_melee'), ranged: stat(it, 'disarm_range') };
      return {
        // `dispel_lands_on`: an enemy it is cast on (removes what sits on that enemy), or the player and allies
        // (removes what sits on them); null when the data does not say. `their_effects_it_removes`: see removedBy.
        ...(dispel ? { applies_dispel: dispel, dispel_lands_on: on, their_effects_it_removes: removedBy(k, on, dispel) } : {}),
        // What the engine showed its target to be while it was on: Eul's → stunned, invulnerable (observed).
        ...(observedTargetState(k) ? { observed_on_its_target: observedTargetState(k) } : {}),
        ...(disarm.melee != null || disarm.ranged != null ? { disarm_seconds: Object.fromEntries(Object.entries(disarm).filter(([, v]) => v != null)) } : {}),
        ...(/pierces debuff immunity/i.test(text) ? { goes_through_debuff_immunity: true } : {}),
      };
    };
    // An item whose effect lasts set against how long this enemy's kills of the player took: of the runs with a known
    // length, how many were over before it would have run out (arithmetic on the two numbers above, nothing more).
    const runs = (contactBeforeDeaths(trace, seatIndex, e.enemy) ?? []).map((r) => r.contact_seconds).filter((x) => Number.isFinite(x));
    const within = (lasts) => (runs.length ? { their_kills_that_took_no_longer: runs.filter((x) => x <= lasts).length, of_their_kills_timed: runs.length } : {});
    return { against_their: against, items: items.map(({ k, how }) => { const lasts = lastsSeconds(pd.items[k], how); return { ...itemEntry(k), how, ...(lasts != null ? { lasts_seconds: lasts, ...within(lasts) } : {}), ...relation(k) }; }) };
  };
  /** How the enemy attacks and the big items they held, with when: what an answer meets. */
  const theirAttack = (other) => attackOf(other?.id);
  const theirBigItems = (enemy) => (itemTimeline(trace, { hero: enemy }).items ?? [])
    .filter((i) => big(i.item)).sort((x, y) => x.first_held.t - y.first_held.t)
    .map((i) => ({ item: i.item, name: itemName(i.item, lang), first_held: i.first_held.clock }));
  const answersToTopKillers = killers.map((e) => {
    const other = BY_SLUG.get(e.enemy);
    const abilities = other ? pd.heroAbilities(other.id) : null;
    const pro = other ? itemLifts(hero.id, other.id).filter((x) => pd.has(x.key)) : [];
    const tags = curatedTraits(e.enemy);
    return {
      killer: e.enemy, kills_of_me: e.kills_of_me,
      share_from_their_attacks: e.share_from_their_attacks, share_from_their_abilities_and_items: e.share_from_their_abilities_and_items,
      their_abilities: Array.isArray(abilities) ? abilities.map((a) => {
        const text = ABILITY_TEXT[a.id]?.desc;
        return {
          ability: a.id, name: a[lang] ?? a.en, ...(a.ult ? { ultimate: true } : {}),
          ...(a.granted_by ? { granted_by: a.granted_by } : {}),
          ...(a.dmg ? { damage_type: DMG_WORD[a.dmg] } : {}),
          // Absent means Valve's data does not say; it is not "no".
          ...(typeof a.pierces === 'boolean' ? { goes_through_spell_immunity: a.pierces } : {}),
          ...(a.dispel ? { dispelled_by: a.dispel } : {}),
          // Where this ability's modifiers were seen land in archived replays — on the hero itself or its allies
          // (`them`), or on enemy heroes — with how often: a fact of its own, not which modifier dispelled_by is about.
          ...(observedPlacement(a.id) ? { observed_on: observedPlacement(a.id).sits === 'on_them' ? 'them' : 'enemy_heroes', observed_times: observedPlacement(a.id).seen } : {}),
          // How it is cast, in OpenDota's words ("No Target", "Passive", "Unit Target"); absent when not listed.
          ...(ABILITY_TEXT[a.id]?.behavior ? { cast: ABILITY_TEXT[a.id].behavior } : {}),
          ...(text ? { valve_text: String(text).replace(/\s+/g, ' ').slice(0, 320) } : {}),
        };
      }) : null,
      // Null when the constants do not say: unknown, not "ranged" or "melee".
      their_attack: theirAttack(other),
      // Death by death: how long their last unbroken run of damage on the player lasted, and what it was made of.
      how_they_killed_me: contactBeforeDeaths(trace, seatIndex, e.enemy),
      their_big_items: theirBigItems(e.enemy),
      // The shop's big items whose Valve data acts on the kind of damage this enemy did in the player's deaths, cheapest
      // first, each with what it does: every one, whatever the player's role. The model weighs them (cost, timing, this
      // hero's kit); no item is picked here. Null when the split of the damage is not known.
      items_acting_on_their_damage: itemsActingOn(e),
      // Null, not [], when no item stood out: too few pro games of the pair, or none built clearly more often.
      pro_items_against_this_killer: pro.length ? pro.map((x) => ({ ...itemEntry(x.key), share_of_pro_games_against_this_hero: x.rate, share_usually: x.base, pro_games: x.n })) : null,
      ...(tags.length ? { known_for: tags } : {}),
    };
  });

  // The hero's most-built professional items, next to when the player had them, and when the gap closers arrived.
  // From pro games of this game's own release (never a later one). A patch days old with only a handful of games of the
  // hero: the patch before, said so — what pros built then is not what they build now, so it is not the first advice.
  const sample = proItemsFor(hero.id, pd);
  const fromBefore = Boolean(sample?.few_games && sample.games < MIN_FEW_GAMES);
  const row = fromBefore ? sample.before_this_patch ?? null : sample;
  // Items that did not exist in this game's patch are not offered as what pros build.
  const core = row ? row.items.filter(([k]) => pd.has(k)).slice(0, 3).map(([k, n]) => ({ item: k, name: itemName(k, lang), share_of_pro_games_with_it_by_24_59: r2(n / row.games), player_first_held: firstHeld.get(k)?.clock ?? null, ...(firstHeld.has(k) ? { player_had_it_by_24_59: firstHeld.get(k).t < 1500 } : {}), built_for: purposesOf(k, pd.items) })) : [];
  const pub = bracketItemsFor(hero.id, { bracket: role.bracket, pos: role.pos, kind: role.kind, hasMatch: Boolean(ctx.match) }, pd, ctx.bracketData);
  const bracketCore = pub.result ? {
    bracket: pub.result.bracket,
    bracket_name: BRACKET_LABEL[pub.result.bracket]?.[lang] ?? pub.result.bracket,
    role: pub.result.role_group,
    role_name: ROLE_GROUP_LABEL[pub.result.role_group]?.[lang] ?? pub.result.role_group,
    ...(pub.result.position != null ? { position: pub.result.position } : {}),
    public_games: pub.result.public_games,
    patch: pub.result.patch,
    weeks: pub.result.weeks,
    ...(pub.result.from_another_patch ? { from_another_patch: true } : {}),
    window: pub.result.window,
    source: 'STRATZ',
    items: pub.result.items.slice(0, 3).map((x) => ({
      item: x.item,
      name: itemName(x.item, lang),
      share_of_public_games_with_it_by_24_59: x.share_of_public_games,
      win_rate: x.win_rate,
      ...(x.median_minute != null ? { median_minute: x.median_minute } : {}),
      player_first_held: firstHeld.get(x.item)?.clock ?? null,
      ...(firstHeld.has(x.item) ? { player_had_it_by_24_59: firstHeld.get(x.item).t < 1500 } : {}),
      built_for: purposesOf(x.item, pd.items),
    })),
  } : null;
  const heldFor = (...purposes) => mine
    .filter((i) => i.built_for.some((p) => purposes.includes(p)))
    .map((i) => ({ item: i.item, name: i.name, first_held: i.first_held, matched_purposes: i.built_for.filter((p) => purposes.includes(p)) }));
  const gapOf = (key) => (itemTimeline(trace, { hero: key }).items ?? []).filter((i) => GAP.has(i.item)).sort((a, b) => a.first_held.t - b.first_held.t)[0] ?? null;
  const myGap = gapOf(slug);
  const theirGaps = enemies.map((e) => ({ e, g: gapOf(e.key) })).filter((x) => x.g).sort((a, b) => a.g.first_held.t - b.g.first_held.t)
    .map(({ e, g }) => ({ enemy: e.key, item: g.item, name: itemName(g.item, lang), first_held: g.first_held.clock, ...(myGap ? { before_my_first_gap_closer: g.first_held.t < myGap.first_held.t } : {}) }));

  return {
    ref: `build:${slug}`, hero: slug, ...dataPatch(pd),
    ...(role.kind ? { my_role: role.kind } : {}), ...(role.pos != null ? { my_position: role.pos } : {}), ...(role.source ? { role_source: role.source } : {}), ...(role.archetype ? { played_as: role.archetype } : {}),
    my_economy: economy,
    // What the player's own hero brings to an item choice: its primary attribute and attack (OpenDota's constants), and
    // how often a death came with one of its spells off cooldown but short of mana (death_context's
    // off_cooldown_without_the_mana) — facts an item's stats (`gives`) can be read against. Null when not known.
    my_hero: myHeroFacts(hero.id, deaths),
    deaths_total: deaths.error ? 0 : deaths.deaths_total ?? 0,
    // The death tool's own count, here too: a sentence that states it may cite this record.
    killed_by: kills,
    damage_in_my_deaths: { share_from_enemy_attacks: fromAttacks, share_from_enemy_abilities_and_items: fromSpells, by_enemy: byEnemy },
    my_big_items_in_order: mine,
    my_team_courier_deaths: timelineRes.my_team_courier_deaths ?? null,
    gold_in_big_items_by_purpose: Object.fromEntries(Object.entries(goldBy).map(([p, v]) => [p, { gold: v.gold, items: v.items, first_at: v.first_at }])),
    player_already_held_for_this_purpose: {
      attack_damage_or_armor: heldFor('answer_to_attack_damage', 'armor'),
      spell_damage_or_magic_resistance: heldFor('answer_to_spell_damage', 'magic_resistance'),
      disables_or_silences: heldFor('answer_to_disables', 'answer_to_silences'),
      initiation_or_gap_closer: heldFor('initiation_or_gap_closer'),
    },
    // Null when the deaths could not be read: no deaths known is not "nobody killed me".
    answers_to_top_killers: deaths.error ? null : answersToTopKillers,
    most_built_in_this_bracket: bracketCore,
    most_built_by_pros_on_this_hero: core.length ? { pro_games: row.games, played_on_releases: row.releases, ...(fromBefore ? { from_the_patch_before_this_game: true } : sample.few_games ? { few_games: true } : {}), window: 'finished between 10:00 and 24:59', items: core } : null,
    gap_closers: { mine: myGap ? { item: myGap.item, name: itemName(myGap.item, lang), first_held: myGap.first_held.clock } : null, enemies: theirGaps },
    note: 'One way to read answers_to_top_killers: what makes this enemy\'s damage (a passive that stacks on their attacks, a buff that adds attack speed or damage reduction — their_abilities, with dispelled_by), how their kills went (how_they_killed_me), what each item does to exactly that (stops their attacks for lasts_seconds, removes a buff with a dispel cast on them, moves them away, or only reduces the damage), and how it sits with the player\'s own hero (my_hero, the item\'s gives) — the weighing is yours. answers_to_top_killers is per enemy who killed the player most: Valve\'s text of that hero\'s abilities (valve_text is the current release\'s wording; the flags are this game\'s release), the shop\'s big items whose Valve data acts on the kind of damage that enemy did in the deaths (items_acting_on_their_damage: against_their attacks or abilities, cheapest first, `how` each acts on it, read off this patch\'s item data, whatever the role — a list to weigh, not a pick; with an item\'s dispel: applies_dispel, dispel_lands_on an enemy it is cast on or on self_or_allies, and their_effects_it_removes — that enemy\'s abilities Valve marks removable by this dispel whose modifiers this item was also seen removing as it landed, on that side, in archived replays (removed, games; both facts required; [] = this item was seen removing modifiers in them and none of these; null = not known — the item was never seen removing anything there, or the data is missing); for the rest, each of their_abilities has dispelled_by (Valve, per ability) and observed_on — where its modifiers were seen land (them, or enemy heroes) — two facts, not one; observed_on_its_target — the engine\'s state of a hero while the item\'s effect was on it in archived replays (Eul\'s: stunned, i.e. cannot move, attack or cast, and invulnerable), with samples and games; disarm_seconds; goes_through_debuff_immunity), their_attack (melee or ranged, range), how_they_killed_me (death by death, numbered as death_context numbers the deaths: what they cast in the 15 s before it — their own buffs included (their_casts_in_the_15s_before, target self/none/me) —, when their last unbroken run of damage on the player began, contact_seconds to the death, their attack and ability damage in it, the player\'s health when it began — from the damage log, summed per second), lasts_seconds on an item whose effect has a duration (disarm, cyclone, ghost form) with their_kills_that_took_no_longer (of_their_kills_timed: how many of that enemy\'s timed kills of the player were over within that many seconds), and their_big_items (with when each was first held), the items pros on this hero build clearly more often against it (association, not proof); known_for is the site\'s curated threat tags of that hero. built_for is what the site\'s curated lists and Valve\'s item stats say an item is for; an empty list means "not classified", not "offensive". On my_big_items_in_order, first_purchased is when the player finished buying the item (direct buy or last required component/recipe, null if absent/ambiguous), first_held is when it first sat in a usable inventory slot (not stash, backpack, or courier), delivery_delay_seconds is first_held minus first_purchased when positive, and my_team_courier_deaths_during_delivery lists hero-killed team couriers in [first_purchased, first_held] (a factual lead, not proof of courier owner or cargo). estimated_minutes_of_my_farm = item cost / my_economy.gold_per_min when that is known; "gives" and "does" are Valve\'s data. player_already_held_for_this_purpose groups big items the player already finished by the threats they cover. Shares of damage are over the 12 seconds before each death, of all damage taken in them (the two sums count enemy heroes only). An item built from a big item already held counts only the gold on top of it (gold_on_top_of_items_already_held). Pro shares are professional games, not this bracket; most_built_in_this_bracket (when present) is public games of this bracket and role (STRATZ).',
    gaps: [
      ...(role.kind ? [] : [{ topic: 'role', reason: ctx.match ? (role.gaps[0] ?? 'role_not_established') : 'no_match_data_for_this_game' }]),
      ...(economy ? [
        ...(economy.source === 'replay_gold_log' || economy.gold_at_20_00_source === 'replay_gold_log' ? [{ topic: 'economy', reason: 'passive_gold_not_in_replay_gold_log' }] : []),
        ...(economy.gold_per_min == null ? [{ topic: 'economy_gpm', reason: 'net_worth_only_not_income_rate' }] : []),
      ] : [{ topic: 'economy', reason: 'no_gold_or_scoreboard_in_trace' }]),
      ...(row ? [] : [{ topic: 'pro_mid_game_items', reason: sample ? `too_few_pro_games_of_this_hero_in_${pd.name}` : 'no_pro_sample_for_hero_in_this_release' }]),
      ...(row && sample.few_games ? [{ topic: 'pro_mid_game_items', reason: `only_${sample.games}_pro_games_of_this_hero_in_${pd.major}_up_to_${pd.name}: shares are from ${row.releases.join(', ')}` }] : []),
      ...pub.gaps,
      ...patchGap(pd),
      ...answersToTopKillers.filter((k) => !k.pro_items_against_this_killer).map((k) => ({ topic: `pro_items_against_${k.killer}`, reason: `no_item_built_clearly_more_often_or_too_few_pro_games_since_${ITEM_VS_SOURCE.since}` })),
      ...(answersToTopKillers.some((k) => k.pro_items_against_this_killer) ? [{ topic: 'pro_items_against_killers', reason: `professional_matches_since_${ITEM_VS_SOURCE.since}_all_releases_together` }] : []),
      // Without the observed-effects data nothing observed is said: every their_effects_it_removes is null, not [].
      ...(OBSERVED?.removals ? [] : [{ topic: 'observed_effects', reason: 'no_observed_effects_data' }]),
      ...(answersToTopKillers.length && !pd.exact ? [{ topic: 'killer_ability_data_of_this_game_patch', reason: `${pd.reason}; ${pd.name} data used` }] : []),
      { topic: 'damage_type_of_abilities', reason: 'spell_damage_is_not_split_into_magical_and_physical_here' },
      { topic: 'gold_spent_on_small_items', reason: 'only_big_items_are_counted' },
      ...(timelineRes.gaps ?? []),
    ],
  };
}

const LEVELS = [6, 12, 18];
const MARKS = [600, 1200, 1800];
/** When a hero first had each of `LEVELS`, and its level at each of `MARKS`, from the per-second samples. */
function levelsOf(trace, h) {
  const lv = trace.states?.[h]?.level;
  if (!Array.isArray(lv)) return { reached: {}, at: {} };
  const reached = {};
  let next = 0;
  for (let i = 0; i < lv.length && next < LEVELS.length; i += 1) while (next < LEVELS.length && lv[i] != null && lv[i] >= LEVELS[next]) { reached[`level_${LEVELS[next]}`] = traceClock(i + trace.t0); next += 1; }
  const at = {};
  for (const m of MARKS) { const i = m - trace.t0; if (i >= 0 && i < lv.length && lv[i] != null) at[traceClock(m)] = lv[i]; }
  return { reached, at };
}

export function powerSpikes(trace, args = {}, ctx = {}) {
  const slug = slugOf(args.hero);
  const seatIndex = trace.heroes.findIndex((h) => h.key === slug);
  const hero = BY_SLUG.get(slug);
  if (seatIndex < 0 || !hero) return { error: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
  const lang = ctx.lang === 'zh' ? 'zh' : 'en';
  const seat = trace.heroes[seatIndex];
  const role = roleOf(ctx.match, hero, trace, slug);
  const pd = patchForGame(trace.match_id, ctx.match);
  const bigItems = (key) => (itemTimeline(trace, { hero: key }).items ?? []).filter((i) => isBigItemIn(pd, i.item, { minCost: KEY_ITEM_MIN_COST, always: ALWAYS_KEY_ITEMS })).sort((a, b) => a.first_held.t - b.first_held.t);
  const npc = trace.names.indexOf(seat.npc);
  const myDeaths = realDeaths(trace).filter((d) => d[1] === npc).map((d) => ({ t: d[0], killer: trace.heroes.find((h) => h.npc === trace.names[d[2]])?.key ?? null }));

  const mine = levelsOf(trace, seatIndex);
  // The ultimate's cooldown as it was in this game's patch.
  const ult = pd.ultimate(hero.id);
  // One entry per mark, the time as a value: a sentence that says "at 20:00" is then one this record holds.
  const levelAt = Object.entries(mine.at).map(([clock, level]) => ({ at: clock, me: level }));

  const enemies = trace.heroes.map((h, i) => ({ h, i })).filter(({ h }) => h.team !== seat.team).map(({ h, i }) => {
    const lv = levelsOf(trace, i);
    for (const [clock, level] of Object.entries(lv.at)) { const row = levelAt.find((x) => x.at === clock); if (row) row[h.key] = level; }
    const kills = myDeaths.filter((d) => d.killer === h.key);
    const other = BY_SLUG.get(h.key);
    const pub = other && role.bracket ? heroVsRank(hero.id, other.id, role.bracket) : null;
    const pro = other ? heroVs(hero.id, other.id) : null;
    return {
      enemy: h.key, kills_of_me_total: kills.length, reached: lv.reached,
      // No ref of their own: the kill counts beside them are this player's, and belong to this record's ref alone.
      big_items: bigItems(h.key).map((it) => ({
        item: it.item, name: itemName(it.item, lang), first_held: it.first_held.clock,
        ...(GAP.has(it.item) ? { gap_closer: true } : {}),
        // Only for an enemy who killed the player at all: how the kills fall around this item.
        ...(kills.length ? { kills_of_me_before: kills.filter((d) => d.t < it.first_held.t).length, kills_of_me_from_then_on: kills.filter((d) => d.t >= it.first_held.t).length } : {}),
      })),
      // How the player's hero usually fares with this enemy hero on the other team. "even" is no measurable difference.
      ...(pub ? { my_hero_against_them_in_public_games: { bracket: pub.bracket, games: pub.n, win_rate: r2(pub.wr), my_hero_usually: r2(pub.base), matchup: pub.verdict } } : {}),
      ...(pro ? { my_hero_against_them_in_pro_games: { games: pro.n, win_rate: r2(pro.wr), my_hero_usually: r2(pro.base), matchup: pro.verdict } } : {}),
    };
  }).sort((a, b) => b.kills_of_me_total - a.kills_of_me_total);

  // The same counts as flat maps ("<enemy>: <item>"), like the death tool's shares: a tool's own counts, which a sentence may quote.
  const before = {}; const after = {};
  for (const e of enemies) for (const it of e.big_items) if (typeof it.kills_of_me_before === 'number') { before[`${e.enemy}: ${it.item}`] = it.kills_of_me_before; after[`${e.enemy}: ${it.item}`] = it.kills_of_me_from_then_on; }
  return {
    ref: `spikes:${slug}`, hero: slug, ...dataPatch(pd),
    kills_of_me: Object.fromEntries(enemies.filter((e) => e.kills_of_me_total).map((e) => [e.enemy, e.kills_of_me_total])),
    kills_of_me_before_their_item: before,
    kills_of_me_from_their_item_on: after,
    me: {
      reached: mine.reached,
      ...(ult?.key ? { ultimate: { ability: ult.key, name: ult[lang] ?? ult.en ?? ult.key, ...(Array.isArray(ult.cd) ? { cooldown_by_level: ult.cd } : {}) } } : {}),
      big_items: bigItems(slug).map((it) => ({ item: it.item, name: itemName(it.item, lang), first_held: it.first_held.clock, ...(GAP.has(it.item) ? { gap_closer: true } : {}) })),
    },
    enemies,
    level_at: levelAt,
    ...(role.bracket ? { public_source: { bracket: role.bracket, bracket_name: BRACKET_LABEL[role.bracket]?.[lang] ?? role.bracket, source: 'STRATZ', patch: RANK_SOURCE.patch } } : {}),
    pro_source: { since: MATCHUP_SOURCE.since, games: MATCHUP_SOURCE.games },
    note: 'A level or an item is when a hero could do more, not proof that it did. kills_of_me_before / from_then_on count this hero\'s kills of the player around the moment the item was first held. A matchup is how the two heroes fare on opposite teams over many games (the win rate of the player\'s hero with that enemy against it, next to its usual one), not what should have happened here; "even" means no measurable difference.',
    gaps: [
      ...(role.bracket ? [] : [{ topic: 'public_matchups', reason: ctx.match ? 'bracket_unknown_for_this_game' : 'no_match_data_for_this_game' }]),
      ...patchGap(pd),
      { topic: 'ability_levels_of_enemies', reason: 'only_hero_levels_are_read_here' },
      { topic: 'net_worth_over_time', reason: 'not_in_the_replay_trace' },
    ],
  };
}

const HERO = { type: 'string', description: 'Hero key as in match_overview, e.g. "beastmaster". Use the player\'s hero.' };
export const SITUATION_TOOLS = [
  {
    name: 'build_check',
    description: 'The player\'s build against what killed them. Gives their role and 1–5 position (from parsed match lanes or inferred from the replay), their economy (`my_economy`: GPM, net worth / 20:00 gold when known), where the damage in their deaths came from (which enemy, attacks or abilities), each big item they bought in order with its purchase vs delivery timing (`first_purchased`, `first_held`, positive `delivery_delay_seconds`, and any `my_team_courier_deaths_during_delivery`, alongside match-wide `my_team_courier_deaths`), its cost, what Valve lists for it and what it is for (built_for: an answer to attack damage, to spell damage, to disables, a gap closer, magic resistance, armor — empty means not classified), the gold put into each purpose, which big items the player already held for each purpose (player_already_held_for_this_purpose), for each of the (up to two) enemies who killed them most what that hero\'s abilities do in Valve\'s words, how that enemy attacks (melee or ranged), how each of their kills of the player went (what they cast in the 15 s before it, their own buffs included; how many seconds their last run of damage lasted, attack vs ability damage, the player\'s health when it began), the big items they held with when, the shop\'s big items whose Valve data acts on that enemy\'s kind of damage (disarm, push, physical immunity, damage block or return, lowered attack speed, armor, a dispel, on whom it lands and which of that enemy\'s effects it was seen removing there; where each of their abilities\' effects was seen land (observed_on); what the item\'s effect made its target in archived replays (observed_on_its_target, e.g. stunned); or spell immunity, magic barrier, magic resistance) with their cost, and the items pros on this hero build clearly more often against that hero (answers_to_top_killers), each with what it does, `estimated_minutes_of_my_farm` (item cost divided by the player\'s GPM) and whether the player held it, what players of this bracket and role build on the hero in public games (most_built_in_this_bracket, when known), the hero\'s most-built professional items with when the player had them, and when each side got its first gap closer (Blink Dagger and the like). Use it before saying anything about what an item is, what the player\'s build answered, or what to buy.',
    input_schema: { type: 'object', properties: { hero: HERO }, required: ['hero'], additionalProperties: false },
    run: buildCheck,
  },
  {
    name: 'power_spikes',
    description: 'When each side became strong. For the player and every enemy: when they reached level 6, 12 and 18, their big items with the time of each, everyone\'s level at 10:00, 20:00 and 30:00; for each enemy how often they killed the player before and after each of their items; and how the player\'s hero usually fares against each enemy hero in public games of this bracket and in professional games. Use it to say from when an enemy was the problem, whether the player\'s own timing came before or after it, and which enemies the hero is weak or strong against.',
    input_schema: { type: 'object', properties: { hero: HERO }, required: ['hero'], additionalProperties: false },
    run: powerSpikes,
  },
];
