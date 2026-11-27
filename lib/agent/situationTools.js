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
import { HEROES_BY_KEY } from '../../packages/review-engine/src/staticHeroes.js';
import { deathContext, itemTimeline, netWorthGraph, realDeaths, traceClock } from '../../packages/review-engine/src/trace/index.js';
import { buildCoachReport, heroInfo as coachHeroInfo } from '../coach/analyze.js';
import { ALWAYS_KEY_ITEMS, ANSWERS, GAP_CLOSERS, KEY_ITEM_MIN_COST, THREAT_TAGS, answersFor, archetypeOf } from '../coach/knowledge.js';
import { roleFromReplay } from './roleFromReplay.js';
import { isBigItemIn, patchData, patchForGame } from './patchData.js';
import { MIN_FEW_GAMES, proItemsFor } from './proItems.js';
import { MATCHUP_SOURCE, heroVs, itemLifts } from '../coach/matchups.js';
import { BRACKET_LABEL, RANK_SOURCE, heroVsRank, reviewBracket } from '../coach/matchupsRank.js';
import { ROLE_GROUP_LABEL, bracketItemsFor } from '../coach/bracketItems.js';

const require = createRequire(import.meta.url);
const ITEM_NAMES = require('../coach/data/names.json').items;

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
};
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

  // The player's big items in the order they were first held, each with what the data says it is for.
  const timeline = itemTimeline(trace, { hero: slug }).items ?? [];
  const firstHeld = new Map(timeline.map((i) => [i.item, i.first_held]));
  const mine = timeline.filter((i) => big(i.item)).sort((a, b) => a.first_held.t - b.first_held.t)
    // No ref of their own: cost, purpose and Valve's text are this record's, cited as build:<hero>.
    .map((i) => ({ item: i.item, name: itemName(i.item, lang), first_held: i.first_held.clock, ...itemFacts(i.item, pd.items), built_for: purposesOf(i.item, pd.items) }));
  // An item built from a big item the player already held (Blink Dagger into Arcane Blink) cost only the rest:
  // the part is not paid for twice.
  const onTop = goldOnTop(mine.map((i) => i.item), pd.items);
  mine.forEach((i, n) => { if (onTop[n] != null) i.gold_on_top_of_items_already_held = onTop[n]; });
  const goldBy = {};
  for (const i of mine) for (const p of (i.built_for.length ? i.built_for : ['not_classified'])) { goldBy[p] ??= { gold: 0, items: [], first_at: i.first_held }; goldBy[p].gold += i.gold_on_top_of_items_already_held ?? i.cost ?? 0; goldBy[p].items.push(i.name); }

  // The items that answer the damage that killed the player, for this role, with what each does and whether it was held.
  const top = byEnemy[0]?.enemy ? BY_SLUG.get(byEnemy[0].enemy) : null;
  const lifts = new Map((top ? itemLifts(hero.id, top.id) : []).map((x) => [x.key, x]));
  const answerList = (tag) => {
    const kinds = role.kind ? [role.kind] : ['core', 'support'];
    const keys = [...new Set(kinds.flatMap((k) => answersFor(tag, k, pd.id, role.archetype)))].filter((k) => ITEM_NAMES[k] && pd.has(k));
    return keys.map((k) => {
      const lift = lifts.get(k);
      const facts = itemFacts(k, pd.items);
      const farmMin = economy?.gold_per_min > 0 && Number.isFinite(facts.cost) ? Math.round((facts.cost / economy.gold_per_min) * 10) / 10 : null;
      return { item: k, name: itemName(k, lang), ...facts, ...(farmMin != null ? { estimated_minutes_of_my_farm: farmMin } : {}), player_first_held: firstHeld.get(k)?.clock ?? null, ...(lift ? { pros_on_this_hero_against_the_top_killer: { share: lift.rate, share_usually: lift.base, pro_games: lift.n } } : {}) };
    });
  };

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
    deaths_total: deaths.error ? 0 : deaths.deaths_total ?? 0,
    // The death tool's own count, here too: a sentence that states it may cite this record.
    killed_by: kills,
    damage_in_my_deaths: { share_from_enemy_attacks: fromAttacks, share_from_enemy_abilities_and_items: fromSpells, by_enemy: byEnemy },
    my_big_items_in_order: mine,
    gold_in_big_items_by_purpose: Object.fromEntries(Object.entries(goldBy).map(([p, v]) => [p, { gold: v.gold, items: v.items, first_at: v.first_at }])),
    player_already_held_for_this_purpose: {
      attack_damage_or_armor: heldFor('answer_to_attack_damage', 'armor'),
      spell_damage_or_magic_resistance: heldFor('answer_to_spell_damage', 'magic_resistance'),
      disables_or_silences: heldFor('answer_to_disables', 'answer_to_silences'),
      initiation_or_gap_closer: heldFor('initiation_or_gap_closer'),
    },
    items_that_answer_attack_damage: answerList('physical'),
    items_that_answer_spell_damage: answerList('magic'),
    most_built_in_this_bracket: bracketCore,
    most_built_by_pros_on_this_hero: core.length ? { pro_games: row.games, played_on_releases: row.releases, ...(fromBefore ? { from_the_patch_before_this_game: true } : sample.few_games ? { few_games: true } : {}), window: 'finished between 10:00 and 24:59', items: core } : null,
    gap_closers: { mine: myGap ? { item: myGap.item, name: itemName(myGap.item, lang), first_held: myGap.first_held.clock } : null, enemies: theirGaps },
    note: 'built_for is what the site\'s curated lists and Valve\'s item stats say an item is for; an empty list means "not classified", not "offensive". The answer lists are curated and are for this role (with estimated_minutes_of_my_farm = item cost / my_economy.gold_per_min when economy is known); "gives" and "does" are Valve\'s data. player_already_held_for_this_purpose groups big items the player already finished by the threats they cover. Shares of damage are over the 12 seconds before each death, of all damage taken in them (the two sums count enemy heroes only). An item built from a big item already held counts only the gold on top of it (gold_on_top_of_items_already_held). Pro shares are professional games, not this bracket; most_built_in_this_bracket (when present) is public games of this bracket and role (STRATZ).',
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
    description: 'The player\'s build against what killed them. Gives their role and 1–5 position (from parsed match lanes or inferred from the replay), their economy (`my_economy`: GPM, net worth / 20:00 gold when known), where the damage in their deaths came from (which enemy, attacks or abilities), each big item they bought in order with its cost, what Valve lists for it and what it is for (built_for: an answer to attack damage, to spell damage, to disables, a gap closer, magic resistance, armor — empty means not classified), the gold put into each purpose, which big items the player already held for each purpose (player_already_held_for_this_purpose), the items that answer attack damage and spell damage for this role with what each does, `estimated_minutes_of_my_farm` (item cost divided by the player\'s GPM) and whether the player held it, what players of this bracket and role build on the hero in public games (most_built_in_this_bracket, when known), the hero\'s most-built professional items with when the player had them, and when each side got its first gap closer (Blink Dagger and the like). Use it before saying anything about what an item is, what the player\'s build answered, or what to buy.',
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
