/**
 * siege_report: every push on a building, from the player's side — who hit it, who of its owners was near,
 * where everyone else was, and whether it fell.
 *
 * Why: a building is what a game is won with, and whether a push takes one is decided by numbers at the
 * building. Over 716 pushes in 32 parsed games (scripts/calibrate.mjs), a push with two or more heroes hitting
 * than its owners had near took the building in 93% of cases (247 of 265), one or fewer in 65%.
 *
 * Facts only:
 * - a push is enemy heroes damaging one building, hits at most 30 s apart, three hero-seconds or more; heroes
 *   who stood by and did not hit it are not "hitting" (they are listed with the rest of their team);
 * - "near" is the owners' heroes alive within 1800 of a hitter at a second that hitter hit: being near is not
 *   defending it; distances to the others are from the middle of where the hitters stood;
 * - creeps are not in the trace: a building that creeps took with fewer hero hits is not a push here.
 */
import { sieges, traceClock, traceHeroIndex } from '../../packages/review-engine/src/trace/index.js';
import { GAPS, stateOf } from './fightReport.js';

const fail = (error, extra = {}) => ({ error, ...extra });
const unitName = (name) => name.replace(/^npc_dota_/, '');
/** A hero not hitting (their team pushed) or not near (their building): what the replay shows at the push's start. */
function elsewhere(trace, i, t, spot) {
  const s = stateOf(trace, i, t, spot);
  if (!s.known) return { hero: s.hero, known: false };
  if (!s.alive) return { hero: s.hero, doing: 'dead', respawn_in: s.respawn_in };
  // Kept short (a long game has 30+ pushes): no `doing` when the replay shows only the place, no TP when none is held.
  return { hero: s.hero, ...(s.doing !== 'none_of_these' ? { doing: s.doing } : {}), place: s.place, distance: s.distance, ...(s.tp_ready != null ? { tp_ready: s.tp_ready } : {}) };
}

export function siegeReport(trace, args = {}) {
  const h = traceHeroIndex(trace, args.hero);
  if (h < 0) return fail('unknown_hero', { heroes: trace.heroes.map((x) => x.key) });
  const key = trace.heroes[h].key; const team = trace.heroes[h].team;
  const pushes = sieges(trace).map((p, i) => {
    const mine = p.owner !== team;
    const hitters = p.hitters.map((x) => trace.heroes[x].key); const near = p.near.map((x) => trace.heroes[x].key);
    const attackers = trace.heroes.map((x, j) => j).filter((j) => trace.heroes[j].team !== p.owner);
    const owners = trace.heroes.map((x, j) => j).filter((j) => trace.heroes[j].team === p.owner);
    return {
      ref: `sieges:${key}:${i + 1}`,
      building: unitName(p.name),
      ...(p.same_name ? { same_name_as_the_other_tower_by_the_ancient: true } : {}),
      clock: traceClock(p.from),
      until: traceClock(p.to),
      pushed_by: mine ? 'my_team' : 'enemy',
      took_it: p.fell_at != null,
      ...(p.fell_at != null ? { fell_at: traceClock(p.fell_at) } : {}),
      hitting: hitters,
      hitting_count: hitters.length,
      owners_near: near,
      owners_near_count: near.length,
      hitting_minus_owners_near: hitters.length - near.length,
      // Dead when it began, also those who respawned and came near before it ended.
      owners_dead_when_it_began: p.dead_owners_at_start,
      me: p.hitters.includes(h) ? 'hitting' : p.near.includes(h) ? 'near' : 'neither',
      pushing_side_not_hitting: attackers.filter((j) => !p.hitters.includes(j)).map((j) => elsewhere(trace, j, p.from, p.spot)),
      owners_not_near: owners.filter((j) => !p.near.includes(j)).map((j) => elsewhere(trace, j, p.from, p.spot)),
    };
  });
  const side = (who) => pushes.filter((p) => p.pushed_by === who);
  const outnumbered = pushes.filter((p) => p.hitting_minus_owners_near >= 2);
  const even = pushes.filter((p) => p.hitting_minus_owners_near <= 1);
  return {
    ref: `sieges:${key}`, ref_scope: 'summary',
    hero: key,
    my_team_pushes: side('my_team').length,
    my_team_pushes_that_took_it: side('my_team').filter((p) => p.took_it).length,
    enemy_pushes: side('enemy').length,
    enemy_pushes_that_took_it: side('enemy').filter((p) => p.took_it).length,
    // Both sides' pushes in this game, by how many more heroes hit than the owners had near.
    pushes_with_two_or_more_hitting_than_near: { pushes: outnumbered.length, took_it: outnumbered.filter((p) => p.took_it).length },
    pushes_with_at_most_one_more_hitting_than_near: { pushes: even.length, took_it: even.filter((p) => p.took_it).length },
    my_team_pushes_i_hit: side('my_team').filter((p) => p.me === 'hitting').length,
    my_buildings_taken_with_me_not_near: side('enemy').filter((p) => p.took_it && p.me === 'neither').length,
    pushes,
    rule: 'a push = enemy heroes damaging one building, hits at most 30 s apart, three hero-seconds or more; owners_near = its owners alive within 1800 of a hitter at a second that hitter hit; took_it = the building fell during it or within 15 s after; distance = from the middle of where the hitters stood',
    gaps: [...GAPS, { topic: 'building_positions', reason: 'where a building stands is not in the trace: "near" is measured from where the heroes hitting it stood' }],
  };
}

export const SIEGE_TOOL = {
  name: 'siege_report',
  description: "Every push on a building in the game, from the player's side: which building, when, who pushed (my_team / enemy), which heroes hit it, which of its owners were near (within 1800 of the hitters), whether it fell, where the player was (hitting, near, neither), and for every other hero what the replay shows them doing then (dead and for how long, where, how far, TP ready). Totals: pushes each side made and how many took the building; pushes by how many more heroes hit than were near. Use it for objectives: why a push took the tower or did not, and where the team was when its own buildings fell.",
  input_schema: { type: 'object', properties: { hero: { type: 'string', description: 'Hero key as in match_overview, e.g. "beastmaster". The report is told from this hero\'s side: use the player.' } }, required: ['hero'], additionalProperties: false },
  run: siegeReport,
};
