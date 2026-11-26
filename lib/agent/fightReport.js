/**
 * fight_report and game_state: the state of the game around its fights, and at any second.
 *
 * Why: the other tools list what happened (deaths, casts, buildings). Whether
 * a fight could be won is decided before it starts — how many heroes each
 * side brought, what the others were doing, which ultimates and Black King
 * Bars were ready. Over 321 fights of 32 parsed games, the side with more
 * heroes taking part lost fewer heroes in 74% of the fights where the counts
 * differed (132 of 178), more ultimates ready 59% (a side that came to have two more ready barely did better in the next fight: 73 to 62), the gold lead 63% — and a
 * side behind in gold that brought more heroes still won 31 of 40
 * (scripts/calibrate.mjs; docs/GAME_UNDERSTANDING.md).
 *
 * Told from one hero's side (the player): my_team / enemy. Facts only:
 * - a hero "took part" when they dealt or took damage from an enemy hero in
 *   the fight (or died in it); one who did neither was not in it — whether
 *   they should have been is the reader's judgment;
 * - what a hero not in it was doing is what the replay shows: dead (and for
 *   how long yet), in base, trading damage elsewhere, hitting a building, or
 *   only where they were (no creeps: never "farming");
 * - ready means learned/held, off cooldown and, for an ability, affordable.
 */
import { fightParticipation, goldAdvantage, heroStateAt, matchFights, observersNear, traceClock, traceHeroIndex, traceSeconds } from '../../packages/review-engine/src/trace/index.js';
import { hasNoCooldown, ultimateOf } from './ultimates.js';

const fail = (error, extra = {}) => ({ error, ...extra });
/**
 * What this trace cannot show. A trace read with wards knows where they stood (not what each side saw); one read with
 * buybacks knows them. An older trace knows neither.
 */
export function gapsOf(trace) {
  return GAPS.flatMap((g) => {
    if (g.topic === 'buyback' && Array.isArray(trace?.buybacks)) return [];
    if (g.topic === 'vision' && Array.isArray(trace?.wards)) return [{ topic: 'vision', reason: 'ward placements are in the trace, not what each side saw: an observer near a spot is near it, it is not proof the spot was seen' }];
    return [g];
  });
}
export const GAPS = [
  { topic: 'vision', reason: 'no fog of war in the replay trace: who could see whom is unknown' },
  { topic: 'creeps', reason: 'no creeps in the replay trace: a hero not in a fight may have been farming, pushing or defending a wave — not shown' },
  { topic: 'buyback', reason: 'buyback is not in the trace: a dead hero\'s respawn_in is the respawn, not whether they could buy back' },
];

function sideOf(trace, heroArg) {
  const h = traceHeroIndex(trace, heroArg);
  if (h < 0) return { err: fail('unknown_hero', { heroes: trace.heroes.map((x) => x.key) }) };
  return { h, team: trace.heroes[h].team };
}

/** Hero i at second t as the reports show it, with their ultimate (Valve's data) and the distance to `from`. */
export const stateOf = (trace, i, t, from) => heroStateAt(trace, i, t, { ultimate: ultimateOf(trace.heroes[i].key), passiveUltimate: hasNoCooldown(trace.heroes[i].key), from });

/** Seconds after an ultimate edge within which a fight counts as following it. */
export const EDGE_FOLLOW_SECONDS = 90;
/**
 * Every 5 s from 10:00, the moments a side came to have two or more ultimates ready than the other (living heroes,
 * four or more of its own alive), at most once a minute; with the first fight that began within 90 s after — begun at
 * its first damage exchange (engaged_at), not its first death, so an edge made by the other side spending ultimates
 * in the opening exchange is not one that came before it (review of #310) — and how it went for that side:
 * [{ t, team, fight: n|null, engaged_at|null, result: 'fewer'|'more'|'even'|null }]. For the calibration.
 */
export function ultimateEdges(trace) {
  const fights = matchFights(trace).map((f, fi) => ({ f, fi, engaged: fightParticipation(trace, f).engaged_at }));
  const readyOf = (sec, team) => { let r = 0; let alive = 0; trace.heroes.forEach((h, i) => { if (h.team !== team) return; const st = stateOf(trace, i, sec); if (st?.alive === false) return; alive += 1; if (st?.ultimate?.ready === true) r += 1; }); return { r, alive }; };
  const prev = { 2: false, 3: false }; const last = { 2: -Infinity, 3: -Infinity };
  const out = [];
  for (let sec = 600; sec < trace.t0 + trace.n - EDGE_FOLLOW_SECONDS; sec += 5) {
    const by = { 2: readyOf(sec, 2), 3: readyOf(sec, 3) };
    for (const team of [2, 3]) {
      const o = team === 2 ? 3 : 2; const on = by[team].r - by[o].r >= 2 && by[team].alive >= 4;
      if (on && !prev[team] && sec - last[team] > 60) {
        const fg = fights.find((x) => x.engaged > sec && x.engaged <= sec + EDGE_FOLLOW_SECONDS);
        let result = null;
        if (fg) { const lost = { 2: 0, 3: 0 }; for (const v of fightParticipation(trace, fg.f).victims) lost[trace.heroes[v].team] += 1; result = lost[team] < lost[o] ? 'fewer' : lost[team] > lost[o] ? 'more' : 'even'; }
        out.push({ t: sec, team, fight: fg ? fg.fi + 1 : null, engaged_at: fg ? fg.engaged : null, result });
      }
      if (on) last[team] = sec;
      prev[team] = on;
    }
  }
  return out;
}

function readiness(states) {
  const ready = []; const notReady = [];
  for (const s of states) {
    if (!s.ultimate) continue;
    const u = s.ultimate;
    if (u.ready === true) ready.push({ hero: s.hero, ability: u.ability });
    else if (u.ready === false) notReady.push({ hero: s.hero, ability: u.ability, why: u.why, ...(u.seconds_left != null ? { seconds_left: u.seconds_left } : {}) });
  }
  return { ready, notReady };
}

/** One fight from a side: who took part, what the others were doing, and what was ready at its first damage. */
function sideRecord(trace, team, fight, part) {
  const t = part.engaged_at;
  const members = trace.heroes.map((x, i) => i).filter((i) => trace.heroes[i].team === team);
  const inIt = members.filter((i) => part.took_part.has(i));
  const out = members.filter((i) => !part.took_part.has(i));
  const states = inIt.map((i) => stateOf(trace, i, t));
  const { ready, notReady } = readiness(states);
  const deaths = part.victims.filter((v) => trace.heroes[v].team === team).length;
  return {
    deaths,
    took_part_count: inIt.length,
    took_part: inIt.map((i) => trace.heroes[i].key),
    levels_of_those_in_it: states.reduce((n, s) => n + (s.level ?? 0), 0),
    ultimates_ready: ready,
    ultimates_not_ready: notReady,
    black_king_bars_ready: states.filter((s) => s.black_king_bar_ready === true).map((s) => s.hero),
    // Observer wards of this side standing within 1600 of where the fight's heroes died, when it began. Null: no ward list.
    observers_within_1600_of_the_fight: (() => { const n = observersNear(trace, part.at, t); return n ? n[team] : null; })(),
    not_in_it: out.map((i) => {
      const s = stateOf(trace, i, t, part.at ?? undefined);
      if (!s.known) return { hero: s.hero, known: false };
      return s.alive ? { hero: s.hero, doing: s.doing, place: s.place, ...(s.distance != null ? { distance: s.distance } : {}), tp_ready: s.tp_ready } : { hero: s.hero, doing: 'dead', respawn_in: s.respawn_in };
    }),
  };
}

export function fightReport(trace, args = {}, ctx = {}) {
  const { h, team, err } = sideOf(trace, args.hero);
  if (err) return err;
  const key = trace.heroes[h].key; const other = team === 2 ? 3 : 2;
  const adv = goldAdvantage(trace, { match: ctx.match });
  const fights = matchFights(trace).map((f, fi) => {
    const part = fightParticipation(trace, f);
    const mine = sideRecord(trace, team, f, part); const theirs = sideRecord(trace, other, f, part);
    const lead = adv?.[Math.floor(part.engaged_at / 60)];
    return {
      ref: `fights:${key}:${fi + 1}`,
      fight: `fight:${fi + 1}`,
      clock: traceClock(f.from),
      engaged_at: traceClock(part.engaged_at),
      lost_fewer_heroes: mine.deaths === theirs.deaths ? 'even' : mine.deaths < theirs.deaths ? 'my_team' : 'enemy',
      more_heroes_took_part: mine.took_part_count === theirs.took_part_count ? 'even' : mine.took_part_count > theirs.took_part_count ? 'my_team' : 'enemy',
      me: part.took_part.has(h) ? 'took_part' : 'not_in_it',
      ...(Number.isFinite(lead) ? { my_team_gold_lead: team === 2 ? lead : -lead } : {}),
      my_team: mine,
      enemy: theirs,
    };
  });
  const count = (pred) => fights.filter(pred).length;
  const moreFights = fights.filter((f) => f.more_heroes_took_part !== 'even');
  return {
    ref: `fights:${key}`, ref_scope: 'summary',
    hero: key,
    fights_total: fights.length,
    fights_my_team_lost_fewer: count((f) => f.lost_fewer_heroes === 'my_team'),
    fights_enemy_lost_fewer: count((f) => f.lost_fewer_heroes === 'enemy'),
    fights_with_more_of_my_team: count((f) => f.more_heroes_took_part === 'my_team'),
    fights_with_more_of_the_enemy: count((f) => f.more_heroes_took_part === 'enemy'),
    // Of the fights one side brought more heroes to, how many that side lost fewer in.
    fights_the_side_with_more_heroes_lost_fewer: { fights_with_unequal_numbers: moreFights.length, the_side_with_more_lost_fewer: moreFights.filter((f) => f.more_heroes_took_part === f.lost_fewer_heroes).length },
    fights_i_took_part_in: count((f) => f.me === 'took_part'),
    fights_i_was_not_in: fights.filter((f) => f.me === 'not_in_it').map((f) => f.fight),
    // My team's heroes who were alive, not in a fight the team lost more heroes in, with a TP ready: [fight, hero].
    lost_fights_with_an_ally_alive_tp_ready_not_in_it: fights.filter((f) => f.lost_fewer_heroes === 'enemy')
      .flatMap((f) => f.my_team.not_in_it.filter((x) => x.tp_ready === true).map((x) => ({ fight: f.fight, clock: f.clock, hero: x.hero, place: x.place, distance: x.distance }))),
    fights,
    rule: 'took part = died in the fight, or traded damage with an enemy hero who took part, from 15 s before its first death to its last, both within 3000 of where one of its heroes died; readiness is at engaged_at, the first such exchange',
    gaps: gapsOf(trace),
  };
}

export function gameState(trace, args = {}, ctx = {}) {
  const { h, team, err } = sideOf(trace, args.hero);
  if (err) return err;
  const t = traceSeconds(args.at);
  if (!Number.isFinite(t)) return fail('bad_time');
  const sec = Math.round(t);
  if (sec < trace.t0 || sec >= trace.t0 + trace.n) return fail('time_outside_the_replay', { from: traceClock(trace.t0), to: traceClock(trace.t0 + trace.n - 1) });
  const key = trace.heroes[h].key;
  const side = (tm) => {
    const heroes = trace.heroes.map((x, i) => i).filter((i) => trace.heroes[i].team === tm).map((i) => stateOf(trace, i, sec));
    return {
      alive: heroes.filter((s) => s.alive).length,
      trading_damage_with_enemy_heroes: heroes.filter((s) => s.doing === 'trading_damage_with_enemy_heroes').length,
      ultimates_ready: heroes.filter((s) => s.ultimate?.ready === true).length,
      heroes: heroes.map(({ known, ...s }) => (known ? s : { ...s, known })),
    };
  };
  const adv = goldAdvantage(trace, { match: ctx.match });
  const lead = adv?.[Math.floor(sec / 60)];
  return {
    ref: `state:${key}:${sec}`,
    clock: traceClock(sec),
    ...(Number.isFinite(lead) ? { my_team_gold_lead: team === 2 ? lead : -lead } : {}),
    my_team: side(team),
    enemy: side(team === 2 ? 3 : 2),
    doing_rule: 'doing is what the replay shows: dead; trading damage with an enemy hero or hitting an enemy building (within 3 s); farming (killed a lane creep or a neutral within 10 s — on replays that keep creep kills); in their own base; or none_of_these (then only the place is known)',
    gaps: gapsOf(trace),
  };
}

const HERO = { type: 'string', description: 'Hero key as in match_overview, e.g. "beastmaster". The report is told from this hero\'s side: use the player.' };
export const FIGHT_TOOLS = [
  {
    name: 'fight_report',
    description: "Every fight of the game (match_overview's, same numbers) from the player's side, read from the state before it: how many heroes each side brought (dealt or took damage from an enemy hero), which ultimates and Black King Bars were ready when it began, the levels of those in it, and for every hero not in it what the replay shows them doing (dead and for how long yet, in base, fighting elsewhere, at a building, or only where they were) with how far away and whether their TP was ready. Totals: fights each side brought more heroes to, and how often that side lost fewer; the fights the player was not in. Use it before judging any fight: a fight lost with fewer heroes in it is about where the team was before it is about how it was fought.",
    input_schema: { type: 'object', properties: { hero: HERO }, required: ['hero'], additionalProperties: false },
    run: fightReport,
  },
  {
    name: 'game_state',
    description: 'All ten heroes at one second, from the player\'s side: alive or dead (and respawn in), where, what the replay shows them doing, level, health %, mana, whether their ultimate, Black King Bar and TP were ready, and the gold lead that minute. Use it for "where was everyone when…": a building falling, a smoke, the moment before a fight.',
    input_schema: { type: 'object', properties: { hero: HERO, at: { type: ['number', 'string'], description: 'Game time: seconds, or "mm:ss".' } }, required: ['hero', 'at'], additionalProperties: false },
    run: gameState,
  },
];
