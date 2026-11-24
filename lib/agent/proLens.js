/**
 * learn_from_pros: what professional players do with the player's hero in
 * the same lane role, next to what the player did — the skill build, what
 * they buy before 10:00, the mid-game items — and the draft of the lane: how
 * the hero fares against its lane opponents (public games of the bracket,
 * professional games), and the mechanisms by which their abilities and the
 * hero's answer each other.
 *
 * Learning, not copying: every entry carries its source, version window and
 * sample, and the limits a reader must weigh. Professional teams are
 * coordinated five-stacks; a public game is solo queue. Professional games
 * are not the player's bracket. The sample spans patches since the previous
 * one, so it may include a release other than the game's. Under 30 games a
 * role's numbers are listed with `too_few_games`, never as a pattern.
 * Valve's text for each ability is quoted so a choice can be explained by
 * what the ability does, not by its popularity.
 */
import { createRequire } from 'node:module';
import { HEROES_BY_KEY } from '../../packages/review-engine/src/staticHeroes.js';
import { itemTimeline, traceClock } from '../../packages/review-engine/src/trace/index.js';
import { ITEM_VS_SOURCE, MATCHUP_SOURCE, heroVs, itemLifts, laneMatchup } from '../coach/matchups.js';
import { BRACKET_LABEL, RANK_SOURCE, heroVsRank, laneVsRank, reviewBracket } from '../coach/matchupsRank.js';
import { heroCounters } from './counterTools.js';
import { abilityAnswers } from '../coach/counters.js';
import { lanePhase, skillOrder } from './lanePhase.js';
import { patchForGame } from './patchData.js';

const require = createRequire(import.meta.url);
const PRO_LANE = require('../coach/data/hero-pro-lane.json');
const HERO_ITEMS = require('../coach/data/hero-items.json');
const ITEM_NAMES = require('../coach/data/names.json').items;
const ALL_ABILITIES = require('../data/constants/abilities.json');
const BY_KEY = HEROES_BY_KEY;
const slugOf = (hero) => String(hero ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_');
const r2 = (n) => Math.round(n * 100) / 100;
export const MIN_PRO_GAMES = 30;
/** A pick taken by fewer than this share of professionals at a level is called uncommon among them. */
const UNCOMMON = 0.2;
const ROLE_NAME = { 1: 'safe_lane', 2: 'mid', 3: 'off_lane', 4: 'jungle' };
export const PRO_LANE_SOURCE = Object.freeze({ source: PRO_LANE.source, since: PRO_LANE.since, current_patch: PRO_LANE.current_patch, fetched: PRO_LANE.fetched });

const LIMITS = [
  'professional teams play coordinated five-stacks with voice; a public game is solo queue: a choice that relies on a team\'s coordination may not carry over',
  'professional games are not the player\'s bracket: the public numbers are STRATZ\'s, by bracket',
  'OpenDota\'s lane role is the lane, not the position: a safe-lane sample mixes the core and the support who laned there',
  `the sample is professional matches since ${PRO_LANE.since}: it can include a release other than this game\'s`,
  'a share is how often professionals chose something, not proof that it wins; the reason for a choice is in what the ability or item does (valve_says)',
];

export function learnFromPros(trace, args = {}, ctx = {}) {
  const lang = ctx.lang === 'zh' ? 'zh' : 'en';
  const slug = slugOf(args.hero ?? ctx.perspective);
  const me = trace.heroes.findIndex((h) => h.key === slug);
  const hero = BY_KEY.get(slug);
  if (me < 0 || !hero) return { error: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
  const pd = patchForGame(trace.match_id, ctx.match);
  const lane = lanePhase(trace, { hero: slug }, ctx);
  const role = lane.facts?.opendota_lane_role ?? null;
  const rows = PRO_LANE.heroes?.[String(hero.id)] ?? {};
  const row = role ? rows[String(role)] : null;
  const enough = row && row.games >= MIN_PRO_GAMES;
  const abilities = pd.heroAbilities(hero.id) ?? [];
  const nameOf = (k) => { const a = abilities.find((x) => x.id === k); return a ? a[lang] ?? a.en : ALL_ABILITIES[k]?.dname ?? k; };
  const itemName = (k) => ITEM_NAMES[k]?.[lang] ?? k;

  // Skills: the player's first ten points, level by level, next to the professionals'.
  const order = skillOrder(trace, me, abilities.map((a) => a.id));
  const byLevel = order.map((p, i) => {
    const pros = row?.by_level?.[i] ?? {};
    const top = Object.entries(pros).slice(0, 3).map(([k, share]) => ({ ability: k, name: nameOf(k), share }));
    return { level_point: i + 1, mine: p.ability, mine_name: nameOf(p.ability), at: traceClock(p.t), share_of_pros_taking_mine_here: pros[p.ability] ?? 0, pros_most_taken: top };
  });
  const uncommon = enough ? byLevel.filter((x) => x.share_of_pros_taking_mine_here < UNCOMMON) : [];
  // What each ability does, in Valve's words (the current release's text), and its flags in the game's release.
  const valve = abilities.map((a) => ({ ability: a.id, name: a[lang] ?? a.en, ...(ALL_ABILITIES[a.id]?.desc ? { valve_says: String(ALL_ABILITIES[a.id].desc).replace(/\s+/g, ' ').trim() } : { valve_says: null }), ...(a.dmg ? { damage_type: { P: 'physical', M: 'magical', U: 'pure' }[a.dmg] } : {}), ...(typeof a.pierces === 'boolean' ? { pierces_debuff_immunity: a.pierces } : {}), ...(a.dispel ? { dispellable: a.dispel } : {}) }));
  const pointsBy = (lvl) => { const out = {}; for (const p of order.slice(0, lvl)) out[p.ability] = (out[p.ability] ?? 0) + 1; return out; };

  // Items before 10:00: the player's purchases next to the professionals' (share of games, median minute).
  const myNpc = trace.names.indexOf(trace.heroes[me].npc);
  const bought = new Map();
  for (const p of trace.purchases) if (p[1] === myNpc && p[0] < 600) { const k = trace.names[p[2]].replace(/^item_/, ''); if (!bought.has(k)) bought.set(k, p[0]); }
  const early = (row?.early_items ?? []).filter((x) => pd.has(x.key)).map((x) => ({ item: x.key, name: itemName(x.key), share_of_pro_games: x.share, pro_median_minute: x.median_minute, mine: bought.has(x.key) ? traceClock(bought.get(x.key)) : null }));
  const mineNotPro = [...bought].filter(([k]) => !k.startsWith('recipe_') && !early.some((x) => x.item === k)).map(([k, t]) => ({ item: k, name: itemName(k), at: traceClock(t) }));

  // Mid-game items: the hero's most-built professional items (all roles) next to when the player first held them.
  const held = new Map((itemTimeline(trace, { hero: slug }).items ?? []).map((i) => [i.item, i.first_held.clock]));
  const mid = HERO_ITEMS.heroes?.[String(hero.id)];
  const midItems = mid ? mid.items.filter((i) => pd.has(i.key)).slice(0, 6).map((i) => ({ item: i.key, name: itemName(i.key), share_of_pro_games_10_00_to_24_59: r2(i.n / mid.games), mine_first_held: held.get(i.key) ?? null })) : [];

  // The lane's draft: the hero against each lane opponent, by numbers and by mechanism.
  const myPlayer = (ctx.match?.players ?? []).find((p) => p && p.hero_id === hero.id);
  const bracket = ctx.match ? reviewBracket(ctx.match.players, myPlayer ?? {}) : null;
  const opponents = lane.facts?.lane_opponents ?? [];
  const draft = opponents.map((o) => {
    const v = BY_KEY.get(o)?.id;
    const c = heroCounters(trace, { hero: slug, against: o }, ctx);
    const pubLane = bracket ? laneVsRank(hero.id, v, bracket.key) : null; const pubGame = bracket ? heroVsRank(hero.id, v, bracket.key) : null;
    const proLane = laneMatchup(hero.id, v); const proGame = heroVs(hero.id, v);
    const lifts = itemLifts(hero.id, v).filter((x) => pd.has(x.key));
    // Their dispels (Valve's "DISPEL TYPE" line) against my abilities' "Dispellable" flags in this release.
    const theirDispels = (pd.heroAbilities(v) ?? []).flatMap((a) => abilityAnswers(a.id).filter((x) => x.mechanism.endsWith('_dispel')).map((x) => ({ ability: a.id, name: a[lang] ?? a.en, kind: x.mechanism, valve_says: x.valve_says })));
    const strongest = theirDispels.some((x) => x.kind === 'strong_dispel') ? 'strong' : theirDispels.length ? 'basic' : null;
    const unremovable = strongest ? abilities.filter((a) => a.dispel === 'no' || (strongest === 'basic' && a.dispel === 'strong')).map((a) => ({ ability: a.id, name: a[lang] ?? a.en, dispellable: a.dispel })) : [];
    return {
      against: o,
      lane_in_public_games: pubLane ? { bracket: pubLane.bracket, lanes: pubLane.n, share_won: r2(pubLane.won), share_lost: r2(pubLane.lost), share_lost_badly: r2(pubLane.stomped), matchup: pubLane.verdict } : null,
      game_in_public_games: pubGame ? { bracket: pubGame.bracket, games: pubGame.n, win_rate: r2(pubGame.wr), hero_usually: r2(pubGame.base), matchup: pubGame.verdict } : null,
      lane_in_pro_games: proLane ? { games: proLane.n, matchup: proLane.verdict } : null,
      game_in_pro_games: proGame ? { games: proGame.n, win_rate: r2(proGame.wr), hero_usually: r2(proGame.base), matchup: proGame.verdict } : null,
      // Mechanisms (counter tools): which of my abilities answer theirs, and theirs mine.
      my_abilities_answer: c.error ? null : c.my_abilities_answer, their_abilities_answer_mine: c.error ? null : c.their_abilities_answer_mine,
      their_dispels: theirDispels,
      ...(strongest ? { dispel_pairing_only_if: 'the_effect_of_my_ability_is_a_debuff_on_them (a buff on myself is never theirs to dispel)', my_abilities_their_dispels_cannot_remove: unremovable, my_abilities_their_dispels_can_remove: abilities.filter((a) => a.dispel === 'basic' || (strongest === 'strong' && a.dispel === 'strong')).map((a) => ({ ability: a.id, name: a[lang] ?? a.en, dispellable: a.dispel })) } : {}),
      items_pros_on_this_hero_build_more_against_them: lifts.map((x) => ({ item: x.key, name: itemName(x.key), share: x.rate, share_usually: x.base, pro_games: x.n })),
    };
  });

  return {
    ref: `learn:${slug}`, hero: slug, lane_role: role ? ROLE_NAME[role] : null, opendota_lane_role: role, data_release: pd.name,
    pro_sample: row ? { games: row.games, games_in_current_patch: row.games_current_patch, current_patch: PRO_LANE.current_patch, since: PRO_LANE.since, fetched: PRO_LANE.fetched, source: PRO_LANE.source, ...(enough ? {} : { too_few_games: true }) } : null,
    other_roles_pros_play_it_in: Object.fromEntries(Object.entries(rows).filter(([r]) => String(r) !== String(role)).map(([r, x]) => [ROLE_NAME[r] ?? r, x.games])),
    skills: {
      by_level: byLevel,
      levels_where_mine_is_uncommon_among_pros: uncommon.map((x) => x.level_point),
      my_points_by_level_6: pointsBy(6), my_points_by_level_10: pointsBy(10),
      pros_top_orders: (row?.top_orders ?? []).map((o) => ({ games: o.games, order: o.order.map(nameOf) })),
      pros_ultimate_first_at_level: row?.ultimate_first_at ?? null,
      what_each_ability_does: valve,
    },
    items_before_10_00: { pros: early, mine_not_common_among_pros: mineNotPro },
    mid_game_items: midItems.length ? { pro_games: mid.games, source: HERO_ITEMS.source, items: midItems } : null,
    lane_draft: { bracket: bracket?.key ?? null, bracket_name: bracket ? BRACKET_LABEL[bracket.key]?.[lang] : null, public_source: `STRATZ, ${RANK_SOURCE.patch}, weeks ${RANK_SOURCE.weeks.from} – ${RANK_SOURCE.weeks.to}`, pro_source: `professional matches since ${MATCHUP_SOURCE.since}; items since ${ITEM_VS_SOURCE.since}`, opponents: draft },
    limits: LIMITS,
    note: 'Explain a choice by what it does (valve_says, the mechanisms) and when it applies (this lane role, these lane opponents, day or night), then by how often professionals made it. Say what it costs: a point in one ability is a point not in another, gold in one item is not in another. Never tell the player to copy an order or a build because it is popular.',
    gaps: [
      ...(row ? [] : [{ topic: 'pro_sample_for_this_hero_and_role', reason: role ? 'no_pro_games_in_this_role' : 'lane_role_unknown' }]),
      ...(row && !enough ? [{ topic: 'pro_sample_for_this_hero_and_role', reason: `only_${row.games}_games` }] : []),
      ...(bracket ? [] : [{ topic: 'public_numbers', reason: ctx.match ? 'bracket_unknown' : 'no_match_data_for_this_game' }]),
      { topic: 'pro_macro_rotations_and_support_roaming', reason: 'not_in_data' },
      { topic: 'talents_and_neutral_items', reason: 'not_in_data' },
      { topic: 'item_charges_and_consumable_use', reason: 'purchases_only: whether a consumable was used is in item uses, not compared with pros' },
    ],
  };
}

const HERO = { type: 'string', description: 'Hero key as in match_overview. Use the player\'s hero.' };
export const LEARN_FROM_PROS_TOOL = {
  name: 'learn_from_pros',
  description: 'What professional players do with the player\'s hero in the same lane role, next to what the player did: the first ten skill points level by level (with Valve\'s text for each ability, so the reason can be told), the items bought before 10:00 and the mid-game items; and the lane\'s draft: how the hero fares against each lane opponent in public games of the bracket and in pro games, which abilities answer which (mechanisms), and the items pros build more against them. Every entry has its source, version window, sample and limits (pro five-stacks vs solo queue). Use it for the hero choice, the skill build, the lane items and what to learn from professionals — explain choices by what they do, not by popularity.',
  input_schema: { type: 'object', properties: { hero: HERO }, required: ['hero'], additionalProperties: false },
  run: learnFromPros,
};
