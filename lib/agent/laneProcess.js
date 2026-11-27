/**
 * How the laning stage went, read from the replay: not the 10:00 result (lane_report has that) but how it came
 * about — when the lane's gold gap opened, what it was made of, and which heroes from outside the lane came into it.
 *
 * - The lane and who was in it: laneOf (laneFromReplay.js), the same reading lane_report uses for a game without a
 *   match record.
 * - gold_gap_by_source: the gold the log says each side of the lane received or lost before 10:00, by the log's
 *   reason — lane creeps, neutrals, hero kills and assists, bounty runes, the rest (not the starting purse) — and
 *   what each side lost on dying. The income every hero gets over time has no rows: it is in neither side. Selling moves money without
 *   earning it: left out.
 * - by_two_minutes: the same sums, running, at 2:00, 4:00 … 10:00 — when the gap opened.
 * - visits: a hero not in this lane (another lane's, a roamer, a jungler — not one in no single lane who spent
 *   PART_TIME_SHARE of the lane stage here: part_time_in_this_lane), alive in this lane's third of the map,
 *   exchanging damage with a hero of the lane's other side. Seconds of that, 30 s or less apart, are one visit. Each
 *   visit says what followed while it lasted and for 10 s after: which lane heroes and which visitors died.
 *   Damage, not sight: a hero who came and was never in a damage exchange is not a visit here.
 * - my_lane_seconds: of the player's lane-stage seconds, how many they were dead, in their base, elsewhere, in lane.
 *
 * Unknown stays unknown: a trace without gold rows has no gold sums (null); without positions for a hero, that hero's
 * lane is not known and neither are the visits (null, and `gaps` says why).
 */
import { realDeaths, traceClock } from '../../packages/review-engine/src/trace/index.js';
import { LANE_END, LANE_FROM, laneOf } from './laneFromReplay.js';
import { goldBySource, goldDifference } from './goldSources.js';

/** Seconds of damage exchange this far apart or closer are one visit. */
export const VISIT_GAP = 30;
/** What happened in a visit: while it lasted and this many seconds after. */
export const VISIT_AFTER = 10;
/**
 * A hero in no single lane who spent this share of their living lane-stage seconds (outside base) in this lane shared
 * it — a support splitting two lanes — and is not a visitor to it. On 209 parsed games, 87 of the 88 heroes in no single
 * lane spent 40% or more in their most-used lane; 9099972085's Witch Doctor split 44% bottom (Luna's lane), 56% top.
 */
export const PART_TIME_SHARE = 0.3;
const LANE_NAME = { 1: 'bot', 2: 'mid', 3: 'top' };

const third = (x, y) => { const d = y - x; return Math.abs(d) < 2200 ? 2 : d > 0 ? 3 : 1; };
const inBase = (x, y) => (x > 4200 && y > 3800) || (x < -4600 && y < -4200);

/**
 * Hero i's lane-stage seconds outside base in each lane third, and the seconds the trace does not place them (alive
 * or not not known, or alive without a position) — those could have been in any lane. Null without a state row.
 */
function laneSeconds(trace, i) {
  const st = trace.states?.[i]; if (!st) return null;
  const c = { 1: 0, 2: 0, 3: 0 }; let n = 0; let missing = 0;
  for (let s = LANE_FROM; s < LANE_END; s += 1) {
    const k = s - trace.t0;
    if (st.alive?.[k] === 0) continue;
    if (st.alive?.[k] !== 1 || st.x?.[k] == null || st.y?.[k] == null) { missing += 1; continue; }
    if (inBase(st.x[k], st.y[k])) continue;
    c[third(st.x[k], st.y[k])] += 1; n += 1;
  }
  return { c, n, missing };
}

/**
 * Whether hero i shared this lane part-time: true, false, or null when the seconds the trace does not place them
 * could tip it either way (the share is between its bounds with them all out of the lane and all in it).
 */
function sharedLane(trace, i, lane) {
  const x = laneSeconds(trace, i); if (!x) return null;
  const all = x.n + x.missing; if (!all) return null;
  const low = x.c[lane] / all; const high = (x.c[lane] + x.missing) / all;
  return low >= PART_TIME_SHARE ? true : high < PART_TIME_SHARE ? false : null;
}

/** The share of hero i's placed lane-stage seconds outside base in this lane (what part_time_in_this_lane states). */
function laneShare(trace, i, lane) {
  const x = laneSeconds(trace, i); return x && x.n ? x.c[lane] / x.n : null;
}

/** Where hero i stood at second s: 'dead', 'base', a lane third (1–3), or null when the trace does not say. */
function placeAt(trace, i, s) {
  const st = trace.states?.[i];
  const k = s - trace.t0;
  if (!st || k < 0) return null;
  if (st.alive?.[k] === 0) return 'dead';
  if (st.alive?.[k] !== 1 || st.x?.[k] == null || st.y?.[k] == null) return null;
  return inBase(st.x[k], st.y[k]) ? 'base' : third(st.x[k], st.y[k]);
}

/**
 * @param {any} trace  hero names linked
 * @param {number} h  the player's seat
 */
export function laneProcess(trace, h) {
  const lanes = trace.heroes.map((_, i) => laneOf(trace, i));
  const lane = lanes[h];
  if (lane === undefined) return { unknown: 'positions_not_known' };
  if (lane === null) return { unknown: 'no_single_lane' };
  const team = trace.heroes[h].team;
  const all = trace.heroes.map((_, i) => i);
  const inLane = all.filter((i) => lanes[i] === lane);
  if (!inLane.some((i) => trace.heroes[i].team !== team)) return { unknown: 'no_enemy_in_the_lane' };
  const notKnown = all.filter((i) => lanes[i] === undefined);
  const key = (i) => trace.heroes[i].key;
  const who = (i) => (i === h ? 'me' : trace.heroes[i].team === team ? 'ally' : 'enemy');
  const nameIx = (i) => trace.names.indexOf(trace.heroes[i].npc);
  const heroOfName = new Map(all.map((i) => [nameIx(i), i]));
  const gaps = [];
  // Heroes in no single lane who shared this one: their fights here are their lane's, not visits.
  const shared = new Map(all.filter((i) => lanes[i] === null).map((i) => [i, sharedLane(trace, i, lane)]));
  const partTime = all.filter((i) => shared.get(i) === true);
  const partSet = new Set(partTime);
  // In no single lane, and the missing positions could make them a sharer or a visitor: their fights here are neither.
  const unsettled = new Set(all.filter((i) => shared.has(i) && shared.get(i) === null));

  // Gold by source, per side of the lane, running every two minutes.
  let gold = null; let byTwo = null;
  if (Array.isArray(trace.gold) && !notKnown.length) {
    const side = (mine) => inLane.filter((i) => (trace.heroes[i].team === team) === mine).map(nameIx);
    // From the horn's purse on (goldBySource leaves the purse out); minutes before 0 are pre-horn.
    const sum = (heroes, toMinute) => goldBySource(trace, heroes, -Infinity, toMinute);
    const mine = side(true); const theirs = side(false);
    const at10 = { my_team: sum(mine, LANE_END / 60), enemy: sum(theirs, LANE_END / 60) };
    gold = {
      ...at10,
      my_team_minus_enemy: goldDifference(at10.my_team, at10.enemy),
    };
    byTwo = [2, 4, 6, 8, 10].map((m) => {
      const a = sum(mine, m).earned; const b = sum(theirs, m).earned;
      return { at: traceClock(m * 60), my_team_earned: a, enemy_earned: b, my_team_minus_enemy: a - b };
    });
    if (gold.my_team.lost_on_dying == null) gaps.push({ topic: 'lost_on_dying', reason: 'no_dying_rows_in_the_replay_s_gold_log' });
  } else gaps.push({ topic: 'gold_gap_by_source', reason: notKnown.length ? 'a_hero_s_lane_stage_positions_not_in_trace' : 'no_gold_rows_in_trace' });

  // Visits from outside the lane: damage exchanged with the lane's other side, inside the lane's third.
  let visits = null;
  const unplaced = new Set(); const unplacedHeroes = new Set();
  if (!notKnown.length && Array.isArray(trace.damage)) {
    const laneSet = new Set(inLane);
    const seconds = new Map(); // visitor → Set of seconds
    for (const [t, a, b] of trace.damage) {
      // Before the horn (rune fights) is not the lane stage; the trace's positions start at the horn.
      if (t < 0 || t >= LANE_END) continue;
      const ia = heroOfName.get(a); const ib = heroOfName.get(b);
      if (ia == null || ib == null || trace.heroes[ia].team === trace.heroes[ib].team) continue;
      for (const [v, o] of [[ia, ib], [ib, ia]]) {
        if (laneSet.has(v) || partSet.has(v) || !laneSet.has(o)) continue;
        const p = placeAt(trace, v, t);
        if (unsettled.has(v) && p === lane) { unplaced.add(trace.heroes[v].team === team ? 'my_team' : 'enemy'); unplacedHeroes.add(key(v)); continue; }
        // An exchange with the lane whose visitor has no position that second may have been a visit: that side's
        // visits are then not known in full (laneOf lets a tenth of a hero's lane-stage seconds go unsampled).
        if (p == null) { unplaced.add(trace.heroes[v].team === team ? 'my_team' : 'enemy'); unplacedHeroes.add(key(v)); continue; }
        if (p !== lane) continue;
        if (!seconds.has(v)) seconds.set(v, new Set());
        seconds.get(v).add(t);
      }
    }
    const deaths = realDeaths(trace).filter((d) => d[0] < LANE_END + VISIT_AFTER);
    visits = [];
    for (const [v, set] of seconds) {
      const ts = [...set].sort((x, y) => x - y);
      let from = ts[0]; let to = ts[0];
      const close = () => {
        const died = deaths.filter((d) => d[0] >= from && d[0] <= to + VISIT_AFTER && heroOfName.has(d[1]) && (laneSet.has(heroOfName.get(d[1])) || heroOfName.get(d[1]) === v));
        visits.push({
          hero: key(v), side: trace.heroes[v].team === team ? 'my_team' : 'enemy', their_lane: lanes[v] == null ? 'no_single_lane' : LANE_NAME[lanes[v]], from: traceClock(from), to: traceClock(to),
          died: died.map((d) => ({ clock: traceClock(d[0]), hero: key(heroOfName.get(d[1])), who: who(heroOfName.get(d[1])) })),
          _t: from,
        });
      };
      for (const t of ts.slice(1)) { if (t - to > VISIT_GAP) { close(); from = t; } to = t; }
      close();
    }
    visits.sort((x, y) => x._t - y._t);
    for (const x of visits) delete x._t;
  } else gaps.push({ topic: 'visits', reason: notKnown.length ? 'a_hero_s_lane_stage_positions_not_in_trace' : 'no_damage_rows_in_trace' });

  if (unplaced.size) gaps.push({ topic: 'visits', reason: 'an_exchange_with_the_lane_without_the_visitor_s_position_or_lane', sides: [...unplaced].sort(), heroes: [...unplacedHeroes].sort() });
  // A side with an exchange that could not be placed: its visits listed are the ones seen, its counts not known.
  const count = (side) => (visits && !unplaced.has(side) ? (() => {
    const own = visits.filter((x) => x.side === side);
    // A death inside two overlapping visits is one death.
    const lost = (w) => new Set(own.flatMap((x) => x.died.filter((d) => d.who === w || (w === 'ally' && d.who === 'me')).map((d) => `${d.clock}|${d.hero}`))).size;
    return { visits: own.length, heroes: [...new Set(own.map((x) => x.hero))], my_team_deaths_in_them: lost('ally'), enemy_deaths_in_them: lost('enemy') };
  })() : null);

  // The player's own lane-stage seconds.
  const where = { in_lane: 0, elsewhere: 0, in_base: 0, dead: 0, not_known: 0 };
  for (let s = LANE_FROM; s < LANE_END; s += 1) {
    const p = placeAt(trace, h, s);
    where[p == null ? 'not_known' : p === 'dead' ? 'dead' : p === 'base' ? 'in_base' : p === lane ? 'in_lane' : 'elsewhere'] += 1;
  }

  return {
    lane: LANE_NAME[lane],
    heroes_in_lane: Object.fromEntries(inLane.map((i) => [key(i), who(i)])),
    gold_gap_by_source: gold, by_two_minutes: byTwo,
    // Shared the lane without being in one lane only: not visitors, and not in the gold sums above (the lane's result
    // is read over the heroes in this lane only, as lane_report's is).
    part_time_in_this_lane: partTime.map((i) => ({
      hero: key(i), side: trace.heroes[i].team === team ? 'my_team' : 'enemy', share_of_lane_stage_here: Math.round(laneShare(trace, i, lane) * 100) / 100,
      // All they earned before 10:00, by source, in whichever lane: what the sums above leave out of this side.
      gold_before_10_00_anywhere: Array.isArray(trace.gold) ? goldBySource(trace, [nameIx(i)], -Infinity, LANE_END / 60) : null,
    })),
    // The sums and the lane's result are over the heroes in this lane only. With a part-time sharer on one side, the
    // two sides may be compared one hero against two: say so beside them.
    ...(partTime.length ? { roster_note: {
      heroes_in_lane: { my_team: inLane.filter((i) => trace.heroes[i].team === team).length, enemy: inLane.filter((i) => trace.heroes[i].team !== team).length },
      part_time: { my_team: partTime.filter((i) => trace.heroes[i].team === team).map(key), enemy: partTime.filter((i) => trace.heroes[i].team !== team).map(key) },
      note: 'gold_gap_by_source, by_two_minutes and lane_report\'s lane_result compare only the heroes in this lane; a part-time sharer\'s gold is not in them (their own, earned in any lane, is under part_time_in_this_lane). With a different number of heroes in the lane on the two sides, part of the gap is that difference.',
    } } : {}),
    visits, enemy_visits: count('enemy'), my_team_visits: count('my_team'),
    my_lane_seconds: { from: traceClock(LANE_FROM), to: traceClock(LANE_END), ...where },
    ...(notKnown.length ? { heroes_whose_lane_is_not_known: notKnown.map(key) } : {}),
    gaps,
  };
}

export const LANE_PROCESS_RULE = `gold_gap_by_source: gold the log says each side of the lane received before 10:00, by source, and lost on dying (the income every hero gets over time is in neither side); visits: a hero from outside the lane exchanging damage with the lane's other side inside the lane's third of the map, seconds ${VISIT_GAP} s or less apart are one visit, died = heroes of the lane or the visitor who died during it or ${VISIT_AFTER} s after; a hero who came without exchanging damage is not counted; a hero in no single lane who spent ${PART_TIME_SHARE * 100}% or more of the lane stage in this lane shared it (part_time_in_this_lane): not a visitor, and not in the gold sums — roster_note says when that leaves the sides uneven; a side's visit counts are null (not known) when one of its heroes exchanged damage with the lane at a second the replay has no position for them`;

/** Measured by scripts/calibrate-lane-process.mjs on 209 parsed games with gold rows (1226 lane sides), 2026-11-27. */
export const LANE_PROCESS_REFERENCE = 'On 209 parsed games: in the 444 lane sides that lost their lane in the 194 games whose gold log has dying rows, the gold behind from hero kills, assists and dying (netted together) added up to about as much as the gold behind from lane creeps (255k against 286k), and was the larger part in 44% of them (197). How many times enemies visited a lane did not go with losing it (lost 39% with no visit, 37% with three or more); visits that cost the lane side more deaths than the enemy did (one or more net) did: lost 49% (147 of 301), against 35% (327 of 925) otherwise. 168 of the 1226 lane sides had a hero sharing the lane part-time (their sums leave that hero out); without them the same holds (45% of 392; 47% against 35%). A reference for how much each part usually weighs, not what happened here.';
