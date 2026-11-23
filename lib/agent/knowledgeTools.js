/**
 * Knowledge tools for the review agent: what the repository's data snapshots
 * say about heroes and items, so the model never has to recall game facts.
 *
 * - hero_abilities: Valve's own ability flags (damage type, whether it goes
 *   through spell immunity, how it is dispelled), lib/coach/data/abilities.json.
 * - pro_item_choices: the finished items professional players build on a hero
 *   in the mid game and the ones they build clearly more often against each
 *   enemy of this match (hero-items.json, item-vs.json), next to when the
 *   player first held each.
 *
 * - lane_report: the player's lane at 10:00 — last hits, denies, gold and XP
 *   of everyone in it, the lane's result, the player's deaths before 10:00 —
 *   next to how the same core matchup goes in professional games and in
 *   public games of the player's bracket. The economy comes from the match
 *   data (OpenDota's parse), the deaths from the replay; without the former
 *   the tool says so instead of guessing.
 *
 * Pro data is association, not proof, and is not the player's rank bracket:
 * every answer says so and carries its sample size.
 */
import { createRequire } from 'node:module';
import { STATIC_HEROES } from '../../packages/review-engine/src/staticHeroes.js';
import { itemTimeline, traceClock } from '../../packages/review-engine/src/trace/index.js';
import { buildCoachReport } from '../coach/analyze.js';
import { ITEM_VS_SOURCE, itemLifts } from '../coach/matchups.js';

const require = createRequire(import.meta.url);
const ABILITIES = require('../coach/data/abilities.json');
const HERO_ITEMS = require('../coach/data/hero-items.json');
const ITEM_NAMES = require('../coach/data/names.json').items;

const BY_SLUG = new Map(Object.values(STATIC_HEROES).map((h) => [h.internalSlug, h]));
const slugOf = (hero) => String(hero ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_');
const DMG = { P: 'physical', M: 'magical', U: 'pure' };
const share = (n, d) => Math.round((n / d) * 100) / 100;
const itemName = (key, lang) => ITEM_NAMES[key]?.[lang] ?? key;

export function heroAbilities(_trace, args = {}, ctx = {}) {
  const hero = BY_SLUG.get(slugOf(args.hero));
  const list = hero ? ABILITIES.heroes?.[String(hero.id)] : null;
  if (!Array.isArray(list)) return { error: 'unknown_hero' };
  const lang = ctx.lang === 'zh' ? 'zh' : 'en';
  const ult = ABILITIES.ultimates?.[String(hero.id)];
  return {
    ref: `abilities:${hero.internalSlug}`, hero: hero.internalSlug, patch: ABILITIES.patch, source: ABILITIES.source,
    abilities: list.map((a) => ({
      ability: a.id, name: a[lang] ?? a.en, ...(a.ult ? { ultimate: true } : {}),
      ...(a.dmg ? { damage_type: DMG[a.dmg] } : {}),
      // Absent means Valve's data does not say; it is not "no".
      ...(typeof a.pierces === 'boolean' ? { goes_through_spell_immunity: a.pierces } : {}),
      ...(a.dispel ? { dispelled_by: a.dispel } : {}),
      ...(a.ult && ult?.key === a.id && Array.isArray(ult.cd) ? { cooldown_by_level: ult.cd } : {}),
    })),
    note: 'Flags describe the ability as Valve lists it. What happened in this game comes from the replay tools.',
  };
}

export function proItemChoices(trace, args = {}, ctx = {}) {
  const slug = slugOf(args.hero);
  const seat = trace.heroes.find((h) => h.key === slug);
  const hero = BY_SLUG.get(slug);
  if (!seat || !hero) return { error: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
  const lang = ctx.lang === 'zh' ? 'zh' : 'en';
  const held = new Map(itemTimeline(trace, { hero: slug }).items.map((i) => [i.item, i.first_held.clock]));
  const bought = (key) => ({ item: key, name: itemName(key, lang), player_first_held: held.get(key) ?? null });
  const row = HERO_ITEMS.heroes?.[String(hero.id)];
  const against = [];
  for (const e of trace.heroes.filter((h) => h.team !== seat.team)) {
    const enemy = BY_SLUG.get(e.key);
    for (const x of enemy ? itemLifts(hero.id, enemy.id) : []) against.push({ enemy: e.key, ...bought(x.key), share_of_pro_games_against_this_enemy: x.rate, share_usually: x.base, pro_games: x.n });
  }
  return {
    ref: `pro_items:${slug}`, hero: slug,
    mid_game_items: row ? { pro_games: row.games, window: 'finished between 10:00 and 24:59', source: HERO_ITEMS.source, items: row.items.map((i) => ({ ...bought(i.key), share_of_pro_games: share(i.n, row.games) })) } : null,
    built_more_against_these_enemies: against,
    ...(against.length ? { against_source: `professional matches since ${ITEM_VS_SOURCE.since}` } : {}),
    note: 'Professional games, not this player\'s rank. A share is how often pros built the item, not proof it wins. No first-held time means the player never held it.',
    gaps: [...(row ? [] : [{ topic: 'pro_mid_game_items', reason: 'no_pro_sample_for_hero' }]), { topic: 'rank_bracket_items', reason: 'only_professional_games_measured' }],
  };
}

const BY_ID = new Map(Object.values(STATIC_HEROES).map((h) => [h.id, h]));
const LANE_END = 600;
const LANE_RULE = 'lane gold at 10:00, both sides summed: within 8% is even, 8% or more is won or lost, 25% or more is won big or lost badly';
const LANE_RESULT = { stomp: 'won big', won: 'won', draw: 'even', lost: 'lost', stomped: 'lost badly' };

/**
 * The laning stage of `hero`, told from their side. Economy at 5:00 and 10:00
 * is in the match data only when OpenDota parsed the match; the replay trace
 * has positions and deaths but no gold or last hits. So: deaths before 10:00
 * always (from the replay), the rest when the match data has it, and a gap
 * that says which when it does not.
 */
export function laneReport(trace, args = {}, ctx = {}) {
  const slug = slugOf(args.hero);
  const seatIndex = trace.heroes.findIndex((h) => h.key === slug);
  const hero = BY_SLUG.get(slug);
  if (seatIndex < 0 || !hero) return { error: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
  const npc = trace.names.indexOf(trace.heroes[seatIndex].npc);
  const early = trace.deaths.filter((d) => d[1] === npc && d[0] < LANE_END).sort((a, b) => a[0] - b[0]);
  const killer = (id) => { const k = trace.heroes.find((h) => h.npc === trace.names[id]); return k ? k.key : null; };
  const base = {
    ref: `lane:${slug}`, hero: slug,
    my_deaths_before_10_00_total: early.length,
    my_deaths_before_10_00: early.map((d) => ({ clock: traceClock(d[0]), killer: killer(d[2]) })),
  };
  const none = (reason) => ({ ...base, lane: null, gaps: [{ topic: 'lane_economy', reason }, { topic: 'creeps', reason: 'no_creep_entities_in_trace' }] });
  if (!ctx.match) return none('no_match_data_for_this_game');
  let report;
  try { report = buildCoachReport(ctx.match); } catch { return none('match_data_incomplete'); }
  const me = report.players.find((p) => p.hero?.id === hero.id);
  const lane = me ? report.reviews?.[me.slot]?.chapters?.laning : null;
  // No chapter: the match was not parsed by OpenDota (no per-minute gold), or the player roamed.
  const perMinute = Array.isArray(ctx.match.players?.find((p) => p?.hero_id === hero.id)?.gold_t);
  if (!lane) return none(perMinute ? 'player_had_no_lane_or_roamed' : 'match_not_parsed_for_per_minute_gold');
  const key = (id) => BY_ID.get(id)?.internalSlug ?? null;
  const clockOf = (sec) => (Number.isFinite(sec) ? traceClock(sec) : null);
  const b = lane.baseline; const r = lane.rank_lane;
  return {
    ...base,
    lane: lane.lane,
    heroes_in_lane_at_10_00: lane.rows.map((x) => ({
      hero: key(x.hero), side: x.slot === me.slot ? 'me' : x.ally ? 'ally' : 'enemy',
      last_hits_at_5_00: x.lh5, last_hits_at_10_00: x.lh10, denies_at_10_00: x.dn10, gold_at_10_00: x.gold10, xp_at_10_00: x.xp10,
    })),
    lane_gold_at_10_00: { my_team: lane.gold[0], enemy: lane.gold[1] },
    lane_result: LANE_RESULT[lane.outcome] ?? null, lane_result_rule: LANE_RULE,
    // The player's role in this game, as the report reads it: a lane goal for the next game is only judged in the same kind of role.
    my_role: report.reviews[me.slot].role?.kind ?? null,
    first_tower_fell: { my_team: clockOf(lane.towers?.ours), enemy: clockOf(lane.towers?.theirs) },
    // The two lane cores in professional games: how this pairing usually stands at 10:00, and where this game fell.
    ...(b ? { same_cores_in_pro_games: {
      my_side_core: key(b.hero), enemy_core: key(b.vs), pro_games: b.n,
      core_gold_difference_at_10_00: { mean: b.mean, quarter_of_games_below: b.p25, quarter_of_games_above: b.p75, this_game: b.actual },
      share_of_pro_games_my_side_core_was_ahead: share(Math.round(b.ahead * 100), 100),
      matchup: b.verdict, this_game_against_that_range: b.standing,
    } } : {}),
    // The player against the enemy lane core in public games of the player's rank bracket.
    ...(r ? { same_lane_in_public_games_of_this_bracket: {
      bracket: r.bracket, hero: key(r.hero), against: key(r.vs), lanes: r.n,
      share_won: share(Math.round(r.won * 100), 100), share_even: share(Math.round(r.even * 100), 100), share_lost: share(Math.round(r.lost * 100), 100), share_lost_badly: share(Math.round(r.stomped * 100), 100),
      matchup: r.verdict, source: 'STRATZ',
    } } : {}),
    note: 'Gold, XP, last hits and denies are the match data\'s per-minute values. Pro and public numbers are how the matchup usually goes, not what should have happened here.',
    gaps: [{ topic: 'creeps', reason: 'no_creep_entities_in_trace' }, { topic: 'lane_positions_of_creep_waves', reason: 'not_in_data' }, ...(b ? [] : [{ topic: 'pro_lane_baseline', reason: 'too_few_pro_games_of_this_matchup' }]), ...(r ? [] : [{ topic: 'bracket_lane_baseline', reason: 'rank_unknown_or_too_few_lanes' }])],
  };
}

const HERO = { type: 'string', description: 'Hero key as in match_overview, e.g. "beastmaster".' };
export const KNOWLEDGE_TOOLS = [
  {
    name: 'hero_abilities',
    description: "Valve's data on a hero's abilities for the current patch: which is the ultimate, damage type, whether it goes through spell immunity (Black King Bar), how it is dispelled. Look here before saying what an ability can or cannot do — yours or an enemy's.",
    input_schema: { type: 'object', properties: { hero: HERO }, required: ['hero'], additionalProperties: false },
    run: heroAbilities,
  },
  {
    name: 'pro_item_choices',
    description: 'What professional players build on this hero: the finished mid-game items with how often, and the items they build clearly more often against each enemy hero of this match — each next to when this player first held it (null = never). Use it to judge the build; say it is pro data when you quote it.',
    input_schema: { type: 'object', properties: { hero: HERO }, required: ['hero'], additionalProperties: false },
    run: proItemChoices,
  },
  {
    name: 'lane_report',
    description: 'The laning stage of a hero (use it for the player): who was in the lane, each one\'s last hits at 5:00 and 10:00, denies, gold and XP at 10:00, the lane\'s result and the rule it is called by, when each side\'s first tower fell, the player\'s deaths before 10:00 — next to how the same core matchup usually stands at 10:00 in professional games and how the lane goes in public games of the player\'s bracket. Look here before saying anything about the lane. When the match data has no per-minute gold it says so under gaps.',
    input_schema: { type: 'object', properties: { hero: HERO }, required: ['hero'], additionalProperties: false },
    run: laneReport,
  },
];
