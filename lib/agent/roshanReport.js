/**
 * roshan_report: every Roshan the replay shows, from the player's side — who took it, who was there, what
 * became of the Aegis, and what each side did in the five minutes the Aegis lasts.
 *
 * The trace has no Roshan event (`gaps`). What it does have is every item a hero held: the Aegis of the
 * Immortal appears in the inventory of the hero who picked it up, the second Roshan died, and leaves it when the
 * holder dies (it brings them back: used) or after 300 s (expired). So a take here is an Aegis pickup. A Roshan
 * whose Aegis nobody picked up (denied, or left) is not seen; an Aegis carried in the backpack is not held.
 *
 * Why: over 52 Aegis takes in 32 parsed games (scripts/calibrate.mjs), the team with it took 139 buildings in
 * the next 300 s and lost 18, and only 7 takes were followed by no building. A take that bought nothing is
 * worth naming.
 */
import { matchFights, sieges, traceClock, traceHeroIndex } from '../../packages/review-engine/src/trace/index.js';
import { heroOfName, region, stateAt, dist } from '../../packages/review-engine/src/trace/query.js';
import { GAPS } from './fightReport.js';

/** The Aegis lasts this long once picked up. */
export const AEGIS_SECONDS = 300;
/** Other things a later Roshan drops; held within this many seconds of the Aegis pickup they came with it. */
const DROPS = ['item_cheese', 'item_refresher_shard', 'item_roshans_banner'];
const DROP_SECONDS = 15;
const OBJECTIVE = /_(tower\d|melee_rax|range_rax|fort)(_(top|mid|bot))?$/;
const teamOfBuilding = (name) => (/goodguys/.test(name) ? 2 : /badguys/.test(name) ? 3 : null);
const fail = (error, extra = {}) => ({ error, ...extra });

/** Every Aegis pickup in the trace: { holder, from, to, ended, ended_at }, in order. */
export function aegisTakes(trace) {
  const end = trace.t0 + trace.n - 1;
  const out = [];
  (trace.items ?? []).forEach((items, i) => {
    for (const [from, to] of items?.item_aegis?.held ?? []) {
      const died = trace.deaths.some((d) => heroOfName(trace, d[1]) === i && Math.abs(d[0] - to) <= 2);
      const ended = died ? 'used' : to - from >= AEGIS_SECONDS - 5 ? 'expired' : to >= end - 2 ? 'game_ended' : 'unknown';
      out.push({ holder: i, from, to, ended });
    }
  });
  return out.sort((a, b) => a.from - b.from);
}

export function roshanReport(trace, args = {}) {
  const h = traceHeroIndex(trace, args.hero);
  if (h < 0) return fail('unknown_hero', { heroes: trace.heroes.map((x) => x.key) });
  const key = trace.heroes[h].key; const team = trace.heroes[h].team;
  const fights = matchFights(trace); const pushes = sieges(trace);
  const takes = aegisTakes(trace).map((a, i) => {
    const side = trace.heroes[a.holder].team; const mine = side === team; const other = side === 2 ? 3 : 2;
    const from = a.from; const until = from + AEGIS_SECONDS;
    const at = stateAt(trace, a.holder, from);
    const near = (tm) => (at ? trace.heroes.map((x, j) => j).filter((j) => j !== a.holder && trace.heroes[j].team === tm).filter((j) => { const s = stateAt(trace, j, from); return s?.alive && dist(s, at) <= 2200; }).map((j) => trace.heroes[j].key) : null);
    const buildings = (trace.buildings ?? []).filter((b) => b[0] >= from && b[0] <= until && OBJECTIVE.test(trace.names[b[1]] ?? '')).map((b) => ({ clock: traceClock(b[0]), building: trace.names[b[1]].replace(/^npc_dota_/, ''), owner: teamOfBuilding(trace.names[b[1]]) }));
    const took = (tm) => buildings.filter((b) => b.owner && b.owner !== tm);
    const inWindow = fights.map((f, fi) => ({ f, fi })).filter(({ f }) => f.from >= from && f.from <= until).map(({ f, fi }) => {
      const lost = { 2: 0, 3: 0 };
      for (const d of f.deaths) { const v = heroOfName(trace, d[1]); if (v >= 0) lost[trace.heroes[v].team] += 1; }
      return { fight: `fight:${fi + 1}`, clock: traceClock(f.from), aegis_side_deaths: lost[side], other_side_deaths: lost[other] };
    });
    const theirPushes = pushes.filter((p) => p.from >= from && p.from <= until && p.owner !== side);
    const drops = [];
    (trace.items ?? []).forEach((items, j) => { for (const k of DROPS) for (const [f0] of items?.[k]?.held ?? []) if (Math.abs(f0 - from) <= DROP_SECONDS) drops.push({ item: k.replace(/^item_/, ''), hero: trace.heroes[j].key }); });
    const holderNear = near(side); const otherNear = near(other);
    return {
      ref: `roshan:${key}:${i + 1}`,
      clock: traceClock(from),
      taken_by: mine ? 'my_team' : 'enemy',
      aegis_holder: trace.heroes[a.holder].key,
      ...(at ? { place: region(at.x, at.y) } : {}),
      // Who stood within 2200 of the holder as they picked it up: who was at the Roshan. Null: the holder's position was not sampled.
      taking_side_near: holderNear,
      other_side_near: otherNear,
      me: a.holder === h ? 'holder' : holderNear?.includes(key) || otherNear?.includes(key) ? 'there' : at ? 'not_there' : null,
      ...(drops.length ? { also_dropped: drops } : {}),
      aegis: a.ended,
      ...(a.ended === 'used' ? { aegis_used_at: traceClock(a.to) } : a.ended === 'expired' ? { aegis_expired_at: traceClock(a.to) } : {}),
      // In the 300 s the Aegis lasts from the pickup, whatever became of it.
      buildings_taking_side_took_in_the_next_300s: took(side).map((b) => ({ clock: b.clock, building: b.building })),
      buildings_other_side_took_in_the_next_300s: took(other).map((b) => ({ clock: b.clock, building: b.building })),
      buildings_taking_side_took_count: took(side).length,
      fights_in_the_next_300s: inWindow,
      taking_side_pushes_in_the_next_300s: { pushes: theirPushes.length, took_it: theirPushes.filter((p) => p.fell_at != null).length },
    };
  });
  const by = (who) => takes.filter((x) => x.taken_by === who);
  return {
    ref: `roshan:${key}`, ref_scope: 'summary',
    hero: key,
    roshans_my_team_took: by('my_team').length,
    roshans_enemy_took: by('enemy').length,
    my_team_aegis_used: by('my_team').filter((x) => x.aegis === 'used').length,
    my_team_aegis_expired: by('my_team').filter((x) => x.aegis === 'expired').length,
    buildings_my_team_took_with_aegis: by('my_team').reduce((n, x) => n + x.buildings_taking_side_took_count, 0),
    buildings_enemy_took_with_aegis: by('enemy').reduce((n, x) => n + x.buildings_taking_side_took_count, 0),
    my_team_roshans_with_no_building_after: by('my_team').filter((x) => x.buildings_taking_side_took_count === 0).length,
    roshans_i_was_at: takes.filter((x) => x.me === 'holder' || x.me === 'there').length,
    takes,
    rule: 'a Roshan here is an Aegis pickup (the trace has no Roshan event): taken at the second a hero first held the Aegis; used = the holder died while holding it; expired = held 300 s; near = within 2200 of the holder at the pickup; what followed = the 300 s from the pickup',
    gaps: [...GAPS, { topic: 'roshan', reason: 'no Roshan kill in the trace: a take is an Aegis pickup; a Roshan whose Aegis was denied or left is not seen, nor an Aegis carried in the backpack' }],
  };
}

export const ROSHAN_TOOL = {
  name: 'roshan_report',
  description: "Every Roshan the replay shows (an Aegis pickup), from the player's side: when, which side took it, who held the Aegis, who of each side stood near it, where the player was (holder / there / not_there), what else dropped (Cheese, Refresher Shard, Roshan's Banner) and who got it, whether the Aegis was used (its holder died and came back) or expired, and in the 300 s after the pickup: the buildings each side took, the fights and who lost fewer, and the taking side's pushes. Totals per side, and the player's team's Roshans with no building after. Use it for \"what did we do with Roshan / why did their Roshan win them the game\".",
  input_schema: { type: 'object', properties: { hero: { type: 'string', description: 'Hero key as in match_overview, e.g. "beastmaster". The report is told from this hero\'s side: use the player.' } }, required: ['hero'], additionalProperties: false },
  run: roshanReport,
};
