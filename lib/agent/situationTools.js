/**
 * Situation tools for the review agent: what the player was up against, and
 * what their own choices answered — so the review reads the game before it
 * judges it, and its advice names an item or a moment instead of a virtue.
 *
 * - build_check: where the damage in the player's deaths came from (whose
 *   attacks, whose spells), what each big item the player bought is for
 *   (the site's curated answer lists plus the stats Valve lists for it —
 *   never "offensive" or "defensive" from memory), the gold put into each
 *   purpose, the items that answer the damage that actually killed them
 *   with what each does, and the hero's most-built professional items next
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
import { STATIC_HEROES } from '../../packages/review-engine/src/staticHeroes.js';
import { deathContext, itemTimeline, traceClock } from '../../packages/review-engine/src/trace/index.js';
import { buildCoachReport } from '../coach/analyze.js';
import { ANSWERS, GAP_CLOSERS, THREAT_TAGS, answersFor, archetypeOf } from '../coach/knowledge.js';
import { MATCHUP_SOURCE, heroVs, itemLifts } from '../coach/matchups.js';
import { BRACKET_LABEL, RANK_SOURCE, heroVsRank, reviewBracket } from '../coach/matchupsRank.js';
import { isSpikeItem } from '../coach/spikes.js';

const require = createRequire(import.meta.url);
const ABILITIES = require('../coach/data/abilities.json');
const HERO_ITEMS = require('../coach/data/hero-items.json');
const ITEM_NAMES = require('../coach/data/names.json').items;
const ITEMS = require('../data/constants/items.json');

const BY_SLUG = new Map(Object.values(STATIC_HEROES).map((h) => [h.internalSlug, h]));
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
};
/** What Valve's data lists for an item: its cost, the stats above, and its active or passive in Valve's own words. */
function itemFacts(key) {
  const it = ITEMS[key];
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
function purposesOf(key) {
  const out = new Set();
  if (GAP.has(key)) out.add('initiation_or_gap_closer');
  for (const tag of ANSWER_TAGS.get(key) ?? []) out.add(PURPOSE_OF_TAG[tag]);
  const gives = itemFacts(key).gives ?? {};
  if (gives.magic_resistance_percent) out.add('magic_resistance');
  if (gives.armor >= 4) out.add('armor');
  return [...out];
}
/** The player's role and how the hero is played in this game (lib/coach), or nulls without the match data. */
function roleOf(match, hero) {
  if (!match) return { kind: null, archetype: null, patch: null, bracket: null };
  try {
    const report = buildCoachReport(match);
    const me = report.players.find((p) => p.hero?.id === hero.id);
    const role = me ? report.reviews?.[me.slot]?.role ?? null : null;
    return { kind: role?.kind ?? null, archetype: me && role ? archetypeOf(me.hero, role) : null, patch: Number.isInteger(match.patch) ? match.patch : null, bracket: me ? reviewBracket(report.players, me)?.key ?? null : null };
  } catch { return { kind: null, archetype: null, patch: Number.isInteger(match?.patch) ? match.patch : null, bracket: null }; }
}
const curatedTraits = (slug) => Object.entries(THREAT_TAGS).filter(([, list]) => list.includes(slug)).map(([tag]) => tag);

export function buildCheck(trace, args = {}, ctx = {}) {
  const slug = slugOf(args.hero);
  const seat = trace.heroes.find((h) => h.key === slug);
  const hero = BY_SLUG.get(slug);
  if (!seat || !hero) return { error: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
  const lang = ctx.lang === 'zh' ? 'zh' : 'en';
  const enemies = trace.heroes.filter((h) => h.team !== seat.team);
  const role = roleOf(ctx.match, hero);

  // Where the damage in the deaths came from: the death tool's own shares, regrouped by enemy.
  const deaths = deathContext(trace, { hero: slug });
  const shares = deaths.error ? {} : deaths.damage_share_in_death_windows ?? {};
  const kills = deaths.error ? {} : deaths.killed_by ?? {};
  const sum = (suffix) => r2(Object.entries(shares).filter(([k]) => k.endsWith(suffix)).reduce((a, [, v]) => a + v, 0));
  const fromAttacks = sum(': attacks'); const fromSpells = sum(': abilities and items');
  const byEnemy = enemies.map((e) => ({
    enemy: e.key, kills_of_me: kills[e.key] ?? 0,
    share_from_their_attacks: shares[`${e.key}: attacks`] ?? 0, share_from_their_abilities_and_items: shares[`${e.key}: abilities and items`] ?? 0,
    ...(curatedTraits(e.key).length ? { known_for: curatedTraits(e.key) } : {}),
  })).filter((e) => e.kills_of_me || e.share_from_their_attacks || e.share_from_their_abilities_and_items)
    .sort((a, b) => (b.share_from_their_attacks + b.share_from_their_abilities_and_items) - (a.share_from_their_attacks + a.share_from_their_abilities_and_items));

  // The player's big items in the order they were first held, each with what the data says it is for.
  const timeline = itemTimeline(trace, { hero: slug }).items ?? [];
  const firstHeld = new Map(timeline.map((i) => [i.item, i.first_held]));
  const mine = timeline.filter((i) => isSpikeItem(i.item)).sort((a, b) => a.first_held.t - b.first_held.t)
    .map((i) => ({ ref: i.ref, item: i.item, name: itemName(i.item, lang), first_held: i.first_held.clock, ...itemFacts(i.item), built_for: purposesOf(i.item) }));
  const goldBy = {};
  for (const i of mine) for (const p of (i.built_for.length ? i.built_for : ['not_classified'])) { goldBy[p] ??= { gold: 0, items: [], first_at: i.first_held }; goldBy[p].gold += i.cost ?? 0; goldBy[p].items.push(i.name); }

  // The items that answer the damage that killed the player, for this role, with what each does and whether it was held.
  const top = byEnemy[0]?.enemy ? BY_SLUG.get(byEnemy[0].enemy) : null;
  const lifts = new Map((top ? itemLifts(hero.id, top.id) : []).map((x) => [x.key, x]));
  const answerList = (tag) => {
    const kinds = role.kind ? [role.kind] : ['core', 'support'];
    const keys = [...new Set(kinds.flatMap((k) => answersFor(tag, k, role.patch, role.archetype)))].filter((k) => ITEM_NAMES[k]);
    return keys.map((k) => {
      const lift = lifts.get(k);
      return { item: k, name: itemName(k, lang), ...itemFacts(k), player_first_held: firstHeld.get(k)?.clock ?? null, ...(lift ? { pros_on_this_hero_against_the_top_killer: { share: lift.rate, share_usually: lift.base, pro_games: lift.n } } : {}) };
    });
  };

  // The hero's most-built professional items, next to when the player had them, and when the gap closers arrived.
  const row = HERO_ITEMS.heroes?.[String(hero.id)];
  const core = row ? row.items.slice(0, 3).map((i) => ({ item: i.key, name: itemName(i.key, lang), share_of_pro_games_with_it_by_24_59: r2(i.n / row.games), player_first_held: firstHeld.get(i.key)?.clock ?? null, ...(firstHeld.has(i.key) ? { player_had_it_by_24_59: firstHeld.get(i.key).t < 1500 } : {}), built_for: purposesOf(i.key) })) : [];
  const gapOf = (key) => (itemTimeline(trace, { hero: key }).items ?? []).filter((i) => GAP.has(i.item)).sort((a, b) => a.first_held.t - b.first_held.t)[0] ?? null;
  const myGap = gapOf(slug);
  const theirGaps = enemies.map((e) => ({ e, g: gapOf(e.key) })).filter((x) => x.g).sort((a, b) => a.g.first_held.t - b.g.first_held.t)
    .map(({ e, g }) => ({ enemy: e.key, item: g.item, name: itemName(g.item, lang), first_held: g.first_held.clock, ...(myGap ? { before_my_first_gap_closer: g.first_held.t < myGap.first_held.t } : {}) }));

  return {
    ref: `build:${slug}`, hero: slug,
    ...(role.kind ? { my_role: role.kind } : {}), ...(role.archetype ? { played_as: role.archetype } : {}),
    deaths_total: deaths.error ? 0 : deaths.deaths_total ?? 0,
    // The death tool's own count, here too: a sentence that states it may cite this record.
    killed_by: kills,
    damage_in_my_deaths: { share_from_enemy_attacks: fromAttacks, share_from_enemy_abilities_and_items: fromSpells, by_enemy: byEnemy },
    my_big_items_in_order: mine,
    gold_in_big_items_by_purpose: Object.fromEntries(Object.entries(goldBy).map(([p, v]) => [p, { gold: v.gold, items: v.items, first_at: v.first_at }])),
    items_that_answer_attack_damage: answerList('physical'),
    items_that_answer_spell_damage: answerList('magic'),
    most_built_by_pros_on_this_hero: core.length ? { pro_games: row.games, window: 'finished between 10:00 and 24:59', items: core } : null,
    gap_closers: { mine: myGap ? { item: myGap.item, name: itemName(myGap.item, lang), first_held: myGap.first_held.clock } : null, enemies: theirGaps },
    note: 'built_for is what the site\'s curated lists and Valve\'s item stats say an item is for; an empty list means "not classified", not "offensive". The answer lists are curated and are for this role; "gives" and "does" are Valve\'s data. Shares of damage are over the 12 seconds before each death. Pro shares are professional games, not this bracket.',
    gaps: [
      ...(role.kind ? [] : [{ topic: 'role', reason: 'no_match_data_for_this_game' }]),
      ...(row ? [] : [{ topic: 'pro_mid_game_items', reason: 'no_pro_sample_for_hero' }]),
      { topic: 'damage_type_of_abilities', reason: 'spell_damage_is_not_split_into_magical_and_physical_here' },
      { topic: 'gold_spent_on_small_items', reason: 'only_big_items_are_counted' },
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
  const role = roleOf(ctx.match, hero);
  const bigItems = (key) => (itemTimeline(trace, { hero: key }).items ?? []).filter((i) => isSpikeItem(i.item)).sort((a, b) => a.first_held.t - b.first_held.t);
  const npc = trace.names.indexOf(seat.npc);
  const myDeaths = trace.deaths.filter((d) => d[1] === npc).map((d) => ({ t: d[0], killer: trace.heroes.find((h) => h.npc === trace.names[d[2]])?.key ?? null }));

  const mine = levelsOf(trace, seatIndex);
  const ult = ABILITIES.ultimates?.[String(hero.id)];
  const levelAt = {};
  for (const [clock, level] of Object.entries(mine.at)) levelAt[clock] = { me: level };

  const enemies = trace.heroes.map((h, i) => ({ h, i })).filter(({ h }) => h.team !== seat.team).map(({ h, i }) => {
    const lv = levelsOf(trace, i);
    for (const [clock, level] of Object.entries(lv.at)) (levelAt[clock] ??= {})[h.key] = level;
    const kills = myDeaths.filter((d) => d.killer === h.key);
    const other = BY_SLUG.get(h.key);
    const pub = other && role.bracket ? heroVsRank(hero.id, other.id, role.bracket) : null;
    const pro = other ? heroVs(hero.id, other.id) : null;
    return {
      enemy: h.key, kills_of_me_total: kills.length, reached: lv.reached,
      big_items: bigItems(h.key).map((it) => ({
        ref: it.ref, item: it.item, name: itemName(it.item, lang), first_held: it.first_held.clock,
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
    ref: `spikes:${slug}`, hero: slug,
    kills_of_me: Object.fromEntries(enemies.filter((e) => e.kills_of_me_total).map((e) => [e.enemy, e.kills_of_me_total])),
    kills_of_me_before_their_item: before,
    kills_of_me_from_their_item_on: after,
    me: {
      reached: mine.reached,
      ...(ult?.key ? { ultimate: { ability: ult.key, name: ult[lang] ?? ult.en ?? ult.key, ...(Array.isArray(ult.cd) ? { cooldown_by_level: ult.cd } : {}) } } : {}),
      big_items: bigItems(slug).map((it) => ({ ref: it.ref, item: it.item, name: itemName(it.item, lang), first_held: it.first_held.clock, ...(GAP.has(it.item) ? { gap_closer: true } : {}) })),
    },
    enemies,
    level_at: levelAt,
    ...(role.bracket ? { public_source: { bracket: role.bracket, bracket_name: BRACKET_LABEL[role.bracket]?.[lang] ?? role.bracket, source: 'STRATZ', patch: RANK_SOURCE.patch } } : {}),
    pro_source: { since: MATCHUP_SOURCE.since, games: MATCHUP_SOURCE.games },
    note: 'A level or an item is when a hero could do more, not proof that it did. kills_of_me_before / from_then_on count this hero\'s kills of the player around the moment the item was first held. A matchup is how the two heroes fare on opposite teams over many games (the win rate of the player\'s hero with that enemy against it, next to its usual one), not what should have happened here; "even" means no measurable difference.',
    gaps: [
      ...(role.bracket ? [] : [{ topic: 'public_matchups', reason: ctx.match ? 'bracket_unknown_for_this_game' : 'no_match_data_for_this_game' }]),
      { topic: 'ability_levels_of_enemies', reason: 'only_hero_levels_are_read_here' },
      { topic: 'net_worth_over_time', reason: 'not_in_the_replay_trace' },
    ],
  };
}

const HERO = { type: 'string', description: 'Hero key as in match_overview, e.g. "beastmaster". Use the player\'s hero.' };
export const SITUATION_TOOLS = [
  {
    name: 'build_check',
    description: 'The player\'s build against what killed them. Where the damage in their deaths came from (which enemy, attacks or abilities), each big item they bought in order with its cost, what Valve lists for it and what it is for (built_for: an answer to attack damage, to spell damage, to disables, a gap closer, magic resistance, armor — empty means not classified), the gold put into each purpose, the items that answer attack damage and spell damage for this role with what each does and whether the player held it, the hero\'s most-built professional items with when the player had them, and when each side got its first gap closer (Blink Dagger and the like). Use it before saying anything about what an item is, what the player\'s build answered, or what to buy.',
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
