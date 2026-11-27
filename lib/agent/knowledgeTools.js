/**
 * Knowledge tools for the review agent: what the repository's data snapshots
 * say about heroes and items, so the model never has to recall game facts.
 *
 * - hero_abilities: Valve's own ability flags (damage type, whether it goes
 *   through spell immunity, how it is dispelled), lib/coach/data/abilities.json.
 * - pro_item_choices: the finished items professional players build on a hero
 *   in the mid game and the ones they build clearly more often against each
 *   enemy of this match, next to when the player first held each. The
 *   mid-game items are from pro games of the game's own release
 *   (pro-items-by-release.json, see proItems.js); the counter items
 *   (item-vs.json) need whole patches of games and say so.
 *
 * - lane_report: the player's lane at 10:00 — last hits, denies, gold and XP
 *   of everyone in it, the lane's result, the player's deaths before 10:00 —
 *   next to how the same core matchup goes in professional games and in
 *   public games of the player's bracket. The economy comes from the match
 *   data (OpenDota's parse), the deaths from the replay; without the former
 *   the tool says so instead of guessing.
 *
 * - lineup_timing: for the ten heroes of this match, each hero's public win
 *   rate by how long the game lasted (under 35 minutes, 35 to 45, 45 or
 *   more) in the player's bracket, which heroes win more in shorter or in
 *   longer games, and the two sides next to each other. Each hero alone: it
 *   is not a line-up's win rate, and the answer says so.
 *
 * Pro data is association, not proof, and is not the player's rank bracket:
 * every answer says so and carries its sample size.
 */
import { createRequire } from 'node:module';
import { STATIC_HEROES, HEROES_BY_KEY } from '../../packages/review-engine/src/staticHeroes.js';
import { itemTimeline, realDeaths, traceClock } from '../../packages/review-engine/src/trace/index.js';
import { buildCoachReport } from '../coach/analyze.js';
import { ITEM_VS_SOURCE, itemLifts } from '../coach/matchups.js';
import { BRACKET_LABEL, reviewBracket } from '../coach/matchupsRank.js';
import { ROLE_GROUP_LABEL, bracketItemsFor } from '../coach/bracketItems.js';
import { TIMING_GROUPS, TIMING_SOURCE, heroTiming, timingGroupOf } from '../coach/heroTiming.js';
import { matchOverview } from '../../packages/review-engine/src/trace/index.js';
import { WINDOW_TOOL } from './windowReport.js';
import { REFERENCE_TOOLS } from './referenceTools.js';
import { REPLAY_QUERY_TOOLS } from './replayQuery.js';
import { BUILD_FOR_PLAN_TOOL } from './buildForPlan.js';
import { FARM_TOOL } from './farmReport.js';
import { SITUATION_TOOLS } from './situationTools.js';
import { FIGHT_TOOLS } from './fightReport.js';
import { SIEGE_TOOL } from './siegeReport.js';
import { ROSHAN_TOOL } from './roshanReport.js';
import { KEY_MOMENTS_TOOL } from './keyMoments.js';
import { DRAFT_TOOL } from './draftReport.js';
import { WARD_TOOL } from './wardReport.js';
import { SAVE_TOOL } from './saveReport.js';
import { DECISION_TOOL } from './decisionPoints.js';
import { CURRENT_RELEASE, patchForGame } from './patchData.js';
import { PRO_ITEMS_SOURCE, RELEASES_WITH_PRO_DATA, coversPatch, proItemsFor, releaseIsPlaced } from './proItems.js';
import { LANE_FROM_REPLAY_RULE, laneFromReplay } from './laneFromReplay.js';
import { LANE_PROCESS_REFERENCE, LANE_PROCESS_RULE, laneProcess } from './laneProcess.js';

const require = createRequire(import.meta.url);
const ABILITIES = require('../coach/data/abilities.json');
const ITEM_NAMES = require('../coach/data/names.json').items;

// By the key a replay uses for the hero, which is not always the internal slug ("queen_of_pain" for queenofpain).
const BY_SLUG = HEROES_BY_KEY;
const slugOf = (hero) => String(hero ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_');
const DMG = { P: 'physical', M: 'magical', U: 'pure' };
const share = (n, d) => Math.round((n / d) * 100) / 100;
const itemName = (key, lang) => ITEM_NAMES[key]?.[lang] ?? key;

export function heroAbilities(trace, args = {}, ctx = {}) {
  const hero = BY_SLUG.get(slugOf(args.hero));
  // The abilities as they were in this game's patch: an ability changed or removed since is told as it was then.
  const pd = patchForGame(trace.match_id, ctx.match);
  const list = hero ? pd.heroAbilities(hero.id) : null;
  if (!Array.isArray(list)) return { error: 'unknown_hero' };
  const lang = ctx.lang === 'zh' ? 'zh' : 'en';
  const ult = pd.ultimate(hero.id);
  return {
    // Under the key that was asked for (a replay's "queen_of_pain"), so the ref is the one the caller can resolve.
    ref: `abilities:${slugOf(args.hero)}`, hero: slugOf(args.hero), patch: pd.name, ...(pd.hotfix ? { hotfix: pd.hotfix.slice(0, 10) } : {}), source: pd.name === CURRENT_RELEASE ? ABILITIES.source : 'Valve\'s game files of that release (dotabuff/d2vpkr), built with OpenDota\'s builder',
    abilities: list.map((a) => ({
      ability: a.id, name: a[lang] ?? a.en, ...(a.ult ? { ultimate: true } : {}),
      ...(a.dmg ? { damage_type: DMG[a.dmg] } : {}),
      // Absent means Valve's data does not say; it is not "no".
      ...(typeof a.pierces === 'boolean' ? { goes_through_spell_immunity: a.pierces } : {}),
      ...(a.dispel ? { dispelled_by: a.dispel } : {}),
      ...(a.ult && ult?.key === a.id && Array.isArray(ult.cd) ? { cooldown_by_level: ult.cd } : {}),
    })),
    note: 'Flags describe the ability as Valve lists it for the patch named here. What happened in this game comes from the replay tools.',
    ...(pd.how ? { patch_known_from: pd.how } : {}),
    ...(pd.exact ? {} : { gaps: [{ topic: 'ability_data_of_this_game_patch', reason: `${pd.reason}; ${pd.name} data used` }] }),
  };
}

function heroRoleAndBracket(match, heroId) {
  if (!match) return { bracket: null, pos: null, kind: null, hasMatch: false };
  try {
    const report = buildCoachReport(match);
    const me = report.players.find((p) => p.hero?.id === heroId);
    const role = me ? report.reviews?.[me.slot]?.role ?? null : null;
    return {
      bracket: me ? reviewBracket(report.players, me)?.key ?? null : null,
      pos: Number.isInteger(role?.pos) ? role.pos : null,
      kind: role?.kind ?? null,
      hasMatch: true,
    };
  } catch {
    return { bracket: null, pos: null, kind: null, hasMatch: true };
  }
}

export function proItemChoices(trace, args = {}, ctx = {}) {
  const slug = slugOf(args.hero);
  const seat = trace.heroes.find((h) => h.key === slug);
  const hero = BY_SLUG.get(slug);
  if (!seat || !hero) return { error: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
  const lang = ctx.lang === 'zh' ? 'zh' : 'en';
  // Only items that existed in this game's patch: a newer item is no advice for an older game.
  const pd = patchForGame(trace.match_id, ctx.match);
  const held = new Map(itemTimeline(trace, { hero: slug }).items.map((i) => [i.item, i.first_held.clock]));
  const bought = (key) => ({ item: key, name: itemName(key, lang), player_first_held: held.get(key) ?? null });
  // The pro games of this game's own release (and the releases just before it in the same patch when it has few).
  const sample = proItemsFor(hero.id, pd);
  const listOf = (s, top) => s.items.filter(([k]) => pd.has(k)).slice(0, top).map(([k, n]) => ({ ...bought(k), share_of_pro_games: share(n, s.games) }));
  const midGame = (s) => ({ pro_games: s.games, played_on_releases: s.releases, window: 'finished between 10:00 and 24:59', items: listOf(s, 5) });
  // Public games of this player's rank bracket and role/position (STRATZ), when the match record and snapshot have them.
  const scope = heroRoleAndBracket(ctx.match, hero.id);
  const pub = bracketItemsFor(hero.id, scope, pd, ctx.bracketData);
  const publicMidGame = pub.result ? {
    bracket: pub.result.bracket,
    bracket_name: BRACKET_LABEL[pub.result.bracket]?.[lang] ?? pub.result.bracket,
    role: pub.result.role_group,
    role_name: ROLE_GROUP_LABEL[pub.result.role_group]?.[lang] ?? pub.result.role_group,
    ...(pub.result.position != null ? { position: pub.result.position } : {}),
    public_games: pub.result.public_games,
    hero_win_rate: pub.result.win_rate,
    patch: pub.result.patch,
    weeks: pub.result.weeks,
    ...(pub.result.from_another_patch ? { from_another_patch: true } : {}),
    window: pub.result.window,
    source: 'STRATZ',
    items: pub.result.items.slice(0, 5).map((x) => ({
      ...bought(x.item),
      share_of_public_games: x.share_of_public_games,
      win_rate: x.win_rate,
      ...(x.median_minute != null ? { median_minute: x.median_minute } : {}),
    })),
  } : null;
  const against = [];
  for (const e of trace.heroes.filter((h) => h.team !== seat.team)) {
    const enemy = BY_SLUG.get(e.key);
    for (const x of enemy ? itemLifts(hero.id, enemy.id).filter((l) => pd.has(l.key)) : []) against.push({ enemy: e.key, ...bought(x.key), share_of_pro_games_against_this_enemy: x.rate, share_usually: x.base, pro_games: x.n });
  }
  return {
    ref: `pro_items:${slug}`, hero: slug, data_patch: pd.name,
    mid_game_items: sample && sample.games ? { ...midGame(sample), source: PRO_ITEMS_SOURCE.source } : null,
    // Only when this game's patch has too few pro games of the hero yet: the patch before, told apart.
    ...(sample?.before_this_patch ? { mid_game_items_in_the_patch_before: midGame(sample.before_this_patch) } : {}),
    public_items_in_this_bracket: publicMidGame,
    built_more_against_these_enemies: against,
    // The counter items need many games of each pairing: they are measured over whole patches, not one release.
    ...(against.length ? { against_source: `professional matches since ${ITEM_VS_SOURCE.since}, all its releases together` } : {}),
    note: 'mid_game_items and built_more_against_these_enemies are professional games, not this player\'s rank; public_items_in_this_bracket (when present) is public games of this bracket and role (STRATZ). A share is how often an item was built, not proof it wins. No first-held time means the player never held it. mid_game_items are pro games of the release(s) named in played_on_releases, never of a later one.',
    gaps: [
      ...(sample ? [] : [{ topic: 'pro_mid_game_items', reason: !releaseIsPlaced(pd) ? `release_of_this_game_not_known_${pd.reason ?? 'unknown'}` : RELEASES_WITH_PRO_DATA.has(pd.name) ? 'no_pro_sample_for_hero' : `no_pro_item_data_for_${pd.name}` }]),
      ...(sample?.few_games ? [{ topic: 'pro_mid_game_items', reason: `only_${sample.games}_pro_games_of_this_hero_in_${pd.major}_up_to_${pd.name}` }] : []),
      ...(against.length && !coversPatch(ITEM_VS_SOURCE.since, pd) ? [{ topic: 'pro_counter_items', reason: `measured_since_${ITEM_VS_SOURCE.since}_after_this_game` }] : []),
      ...pub.gaps,
    ],
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
  const early = realDeaths(trace).filter((d) => d[1] === npc && d[0] < LANE_END).sort((a, b) => a[0] - b[0]);
  const killer = (id) => { const k = trace.heroes.find((h) => h.npc === trace.names[id]); return k ? k.key : null; };
  // How the lane went, from the replay whatever the record says (laneProcess.js): where the gap came from, who came in.
  const proc = laneProcess(trace, seatIndex);
  const base = {
    ref: `lane:${slug}`, hero: slug,
    my_deaths_before_10_00_total: early.length,
    my_deaths_before_10_00: early.map((d) => ({ clock: traceClock(d[0]), killer: killer(d[2]) })),
    // Its own lane and roster, read from the replay's positions: the match record's lane above may group the heroes
    // differently (a hero it marks as roaming), and these sums are over this roster, not that one.
    how_the_lane_went: proc.unknown ? null : (({ lane, heroes_in_lane, ...rest }) => ({ lane_read_from_replay: lane, heroes_in_lane_read_from_replay: heroes_in_lane, ...rest, rule: LANE_PROCESS_RULE, reference: LANE_PROCESS_REFERENCE }))(proc),
    ...(proc.unknown ? { how_the_lane_went_not_known: proc.unknown } : {}),
    // The visit counts again, one level down: the tool's own counts a sentence may quote (null: not known).
    ...(proc.unknown ? {} : { lane_visit_counts: {
      enemy_visits: proc.enemy_visits?.visits ?? null, my_team_deaths_in_enemy_visits: proc.enemy_visits?.my_team_deaths_in_them ?? null, enemy_deaths_in_enemy_visits: proc.enemy_visits?.enemy_deaths_in_them ?? null,
      my_team_visits: proc.my_team_visits?.visits ?? null, my_team_deaths_in_my_team_visits: proc.my_team_visits?.my_team_deaths_in_them ?? null, enemy_deaths_in_my_team_visits: proc.my_team_visits?.enemy_deaths_in_them ?? null,
    } }),
  };
  const none = (reason) => ({ ...base, lane: null, gaps: [{ topic: 'lane_economy', reason }, { topic: 'creeps', reason: 'no_creep_entities_in_trace' }] });
  // No record to read the lane from: the replay's own rows, when the trace has them (laneFromReplay.js).
  const fromReplay = (reason) => {
    const r = laneFromReplay(trace, seatIndex);
    if (r.unknown) return { ...base, lane: null, gaps: [{ topic: 'lane_economy', reason }, { topic: 'lane_from_replay', reason: r.unknown }] };
    const { gaps: own = [], ...rest } = r;
    return {
      ...base, read_from: 'replay', ...rest, lane_result_rule: LANE_FROM_REPLAY_RULE,
      note: 'Read from the replay: the match record has no per-minute numbers for this game. Last hits are at least these (a summon\'s kill shows only at the hero\'s next own last hit); lane gold is what the log says was earned, without the income every hero gets over time.',
      gaps: [{ topic: 'lane_economy', reason }, { topic: 'xp_at_10_00', reason: 'not_in_replay_data' }, { topic: 'pro_lane_baseline', reason: 'needs_the_match_record' }, { topic: 'lane_positions_of_creep_waves', reason: 'not_in_data' }, ...own],
    };
  };
  if (!ctx.match) return fromReplay('no_match_data_for_this_game');
  let report;
  try { report = buildCoachReport(ctx.match); } catch { return fromReplay('match_data_incomplete'); }
  const me = report.players.find((p) => p.hero?.id === hero.id);
  const lane = me ? report.reviews?.[me.slot]?.chapters?.laning : null;
  // No chapter: the match was not parsed by OpenDota (no per-minute gold), or the player roamed.
  const perMinute = Array.isArray(ctx.match.players?.find((p) => p?.hero_id === hero.id)?.gold_t);
  // The record says the player had no lane (roamed): that stands. The record has no per-minute numbers: the replay.
  if (!lane) return perMinute ? none('player_had_no_lane_or_roamed') : fromReplay('match_not_parsed_for_per_minute_gold');
  // A hero id of the match data as the key this replay uses for that hero.
  const key = (id) => trace.heroes.find((h) => BY_SLUG.get(h.key)?.id === id)?.key ?? BY_ID.get(id)?.internalSlug ?? null;
  const clockOf = (sec) => (Number.isFinite(sec) ? traceClock(sec) : null);
  const b = lane.baseline; const r = lane.rank_lane;
  const by = (f) => Object.fromEntries(lane.rows.filter((x) => key(x.hero)).map((x) => [key(x.hero), f(x)]));
  return {
    ...base,
    lane: lane.lane,
    // The two moments the numbers below are read at, as game times a sentence may state.
    measured_at: ['5:00', '10:00'],
    // One map per measure, keyed by hero (like killed_by): these are the tool's own counts, which a sentence may quote.
    heroes_in_lane: by((x) => (x.slot === me.slot ? 'me' : x.ally ? 'ally' : 'enemy')),
    last_hits_at_5_00: by((x) => x.lh5), last_hits_at_10_00: by((x) => x.lh10), denies_at_10_00: by((x) => x.dn10),
    gold_at_10_00: by((x) => x.gold10), xp_at_10_00: by((x) => x.xp10),
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

/** The two sides' mean change from short to long games must differ by this much to say longer games favour one of them. */
const TIMING_SIDE_GAP = 0.03;
const points = (share) => Math.round(share * 1000) / 10;

/**
 * Which heroes of this match win more in shorter or in longer public games,
 * and the two sides next to each other. From the player's bracket when the
 * match data says what it is, else from all brackets together (stated).
 * What the data cannot say stays null: a hero with too few games in a group
 * has no win rate there, and a side with such a hero has no mean.
 */
export function lineupTiming(trace, _args = {}, ctx = {}) {
  const view = ctx.perspective == null ? null : trace.heroes.find((h) => h.key === slugOf(ctx.perspective)) ?? null;
  const me = view ? (ctx.match?.players ?? []).find((p) => p && p.hero_id === BY_SLUG.get(view.key)?.id) : null;
  const bracket = ctx.match ? reviewBracket(ctx.match.players, me ?? {}) : null;
  const side = (team) => {
    const heroes = trace.heroes.filter((h) => h.team === team).map((h) => {
      const id = BY_SLUG.get(h.key)?.id;
      const t = id == null ? null : heroTiming(id, bracket?.key ?? null);
      if (!t) return { hero: h.key, games: null, wins_more_in: null };
      return {
        hero: h.key, games: t.games, win_rate: t.win_rate,
        ...Object.fromEntries(TIMING_GROUPS.map((g) => [`win_rate_${g}`, t.by_length[g].win_rate])),
        change_from_short_to_long_games_in_points: t.short_to_long == null ? null : points(t.short_to_long),
        wins_more_in: t.wins_more_in,
      };
    });
    const where = (lean) => heroes.filter((x) => x.wins_more_in === lean).map((x) => x.hero);
    // A mean over fewer than the side's heroes would be a different thing: none then.
    const mean = (f) => (heroes.length && heroes.every((x) => Number.isFinite(f(x))) ? heroes.reduce((a, x) => a + f(x), 0) / heroes.length : null);
    const change = mean((x) => x.change_from_short_to_long_games_in_points);
    return {
      heroes,
      // "No clear lean" is no claim either way (under the gap, or within the noise) — not "wins as often in both".
      heroes_that_win_more_in_shorter_games: where('shorter_games'), heroes_that_win_more_in_longer_games: where('longer_games'), heroes_with_no_clear_lean: where('neither'), heroes_not_known: where(null),
      mean_win_rate_of_its_heroes: Object.fromEntries(TIMING_GROUPS.map((g) => { const m = mean((x) => x[`win_rate_${g}`]); return [g, m == null ? null : Math.round(m * 1000) / 1000]; })),
      mean_change: change == null ? null : Math.round(change * 10) / 10,
    };
  };
  const a = side(view ? view.team : 2); const b = side(view ? (view.team === 2 ? 3 : 2) : 3);
  const [ka, kb] = view ? ['my_team', 'enemy'] : ['radiant', 'dire'];
  const { mean_change: ca, ...sideA } = a; const { mean_change: cb, ...sideB } = b;
  const length = matchOverview(trace).duration;
  const gap = ca == null || cb == null ? null : ca - cb;
  return {
    ref: 'lineup_timing',
    source: TIMING_SOURCE.source, patch: TIMING_SOURCE.patch, weeks: TIMING_SOURCE.weeks,
    bracket: bracket ? bracket.key : 'all', bracket_name: bracket ? BRACKET_LABEL[bracket.key][ctx.lang === 'zh' ? 'zh' : 'en'] : (ctx.lang === 'zh' ? '全部分段' : 'all brackets'),
    // Whose medal it is read from: the player's own, the middle of the match's public medals, or none known (all brackets together).
    bracket_from: bracket ? (bracket.basis === 'player' ? 'the_players_medal' : 'the_medals_public_in_this_match') : 'no_medal_known',
    game_length_groups: { under_35_min: 'ended before 35:00', from_35_to_45_min: 'ended from 35:00 to 45:00', over_45_min: 'lasted 45:00 or more' },
    // Null when the replay does not show the game's end.
    this_game: length ? { length: length.clock, group: timingGroupOf(length.t) } : null,
    [ka]: sideA, [kb]: sideB,
    // One map per measure, keyed by side: the tool's own numbers, which a sentence may quote.
    mean_change_from_short_to_long_games_in_points: { [ka]: ca, [kb]: cb },
    longer_games_favour: gap == null ? null : Math.abs(gap) >= TIMING_SIDE_GAP * 100 ? (gap > 0 ? ka : kb) : 'neither',
    longer_games_favour_rule: `the side whose heroes' win rates rise more (or fall less) from games under 35 minutes to games of 45 or more, when the two sides' mean changes are at least ${TIMING_SIDE_GAP * 100} points apart; else neither`,
    note: 'Public games, each hero on its own: how five heroes work together and against the other five is not in these numbers, and a mean of five win rates is not a line-up\'s win rate. A hero that wins more in shorter games is a reason to look at what its team did early, not proof of a plan.',
    gaps: [
      ...(bracket ? [] : [{ topic: 'rank_bracket', reason: ctx.match ? 'too_few_public_medals_in_this_match' : 'no_match_data_for_this_game' }]),
      ...(sideA.heroes_not_known.length || sideB.heroes_not_known.length ? [{ topic: 'hero_timing', reason: 'too_few_public_games_for_some_heroes' }] : []),
      { topic: 'line_up_synergy', reason: 'each_hero_measured_alone' },
      { topic: 'patch', reason: `measured_in_${TIMING_SOURCE.patch}` },
    ],
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
    description: 'What professional players and public players of this rank bracket and role build on this hero: the finished mid-game items with how often (and win rate in public games of this bracket and role, when known), and the items pros build clearly more often against each enemy hero of this match — each next to when this player first held it (null = never). Use it as a reference alongside build_check; say whether a share is from professional games or public games of the bracket when you quote it.',
    input_schema: { type: 'object', properties: { hero: HERO }, required: ['hero'], additionalProperties: false },
    run: proItemChoices,
  },
  {
    name: 'lane_report',
    description: 'The laning stage of a hero (use it for the player): who was in the lane, and per hero the last hits at 5:00 and 10:00, denies, gold and XP at 10:00, the lane\'s result and the rule it is called by, when each side\'s first tower fell, the player\'s deaths before 10:00, and how the lane went (how_the_lane_went, from the replay, with the lane and the heroes it was read over — the record may group them differently): the lane\'s gold gap before 10:00 split by source — last hits, kills and assists, gold lost on dying — and running every two minutes, the visits of heroes from outside the lane who exchanged damage in it and who died then, where the player spent the lane stage, and the player\'s early rotation trips away from their main lane (`my_rotations_before_10_00`: trips of 20 s+ with destination, power runes activated, wards placed, enemy deaths damaged, and lane partner deaths while away) — next to how the same core matchup usually stands at 10:00 in professional games and how the lane goes in public games of the player\'s bracket. Look here before saying anything about the lane. When the match data has no per-minute numbers it reads the lane, last hits, denies and the lane\'s result from the replay instead (read_from: replay; no XP, no pro or public baseline), and says what it could not read under gaps.',
    input_schema: { type: 'object', properties: { hero: HERO }, required: ['hero'], additionalProperties: false },
    run: laneReport,
  },
  // Who went to which lane and how each lane pairing usually goes (draftReport.js).
  DRAFT_TOOL,
  {
    name: 'lineup_timing',
    description: 'For the ten heroes of this match: each hero\'s win rate in public games of the player\'s bracket by how long the game lasted (under 35 minutes, 35 to 45, 45 or more), which heroes win more in shorter or in longer games, the two sides next to each other, and which group this game fell in. Use it for whether time was on the player\'s side or the enemy\'s. It measures each hero alone, not the line-up: say "public games" and name the heroes when you quote it.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: lineupTiming,
  },
  // When each side was ahead in gold, and what it took in that time (windowReport.js).
  WINDOW_TOOL,
  // What the player's big items served, plan by plan (buildForPlan.js).
  BUILD_FOR_PLAN_TOOL,
  // What the other side was doing: who got richer when, and who stood by what the team took (farmReport.js).
  FARM_TOOL,
  // What the player was up against and what their build answered; when each side became strong (situationTools.js).
  ...SITUATION_TOOLS,
  // The state of the game around each fight and at any second: who was in it, what was ready, where the others were (fightReport.js).
  ...FIGHT_TOOLS,
  // Every push on a building: who hit it, who of its owners was near, where the rest were (siegeReport.js).
  SIEGE_TOOL,
  // Every Roshan (an Aegis pickup): who took it, who was there, what the Aegis bought (roshanReport.js).
  ROSHAN_TOOL,
  // The fights that moved the team's chance to win the most, and where the player was (keyMoments.js).
  KEY_MOMENTS_TOOL,
  // The wards a hero placed and the other side's they killed (wardReport.js).
  WARD_TOOL,
  // What a hero gave their own side: abilities and items used on allies (saveReport.js).
  SAVE_TOOL,
  // The moments a side had a choice: what it did with each fight it won (decisionPoints.js).
  DECISION_TOOL,
  // The replay's own rows and one hero over a window, to check a fact (replayQuery.js).
  ...REPLAY_QUERY_TOOLS,
  // Dota knowledge to look up instead of recall: items, heroes, matchups, patch notes (referenceTools.js).
  ...REFERENCE_TOOLS,
];
