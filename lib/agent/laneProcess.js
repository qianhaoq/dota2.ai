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
 * - visits: a hero not in this lane (another lane's, a roamer, a jungler), alive in this lane's third of the map,
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

/** Seconds of damage exchange this far apart or closer are one visit. */
export const VISIT_GAP = 30;
/** What happened in a visit: while it lasted and this many seconds after. */
export const VISIT_AFTER = 10;
const LANE_NAME = { 1: 'bot', 2: 'mid', 3: 'top' };
/** The log's gold reasons (build.js), grouped as the tool states them. */
const SOURCE = { 13: 'lane_creeps', 14: 'neutrals', 12: 'hero_kills_and_assists', 17: 'bounty_runes' };
const SOLD = 6; const DYING = 1;
const SOURCES = ['lane_creeps', 'neutrals', 'hero_kills_and_assists', 'bounty_runes', 'other'];

const third = (x, y) => { const d = y - x; return Math.abs(d) < 2200 ? 2 : d > 0 ? 3 : 1; };
const inBase = (x, y) => (x > 4200 && y > 3800) || (x < -4600 && y < -4200);

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

  // Gold by source, per side of the lane, running every two minutes.
  let gold = null; let byTwo = null;
  if (Array.isArray(trace.gold) && !notKnown.length) {
    const side = (mine) => inLane.filter((i) => (trace.heroes[i].team === team) === mine).map(nameIx);
    const sum = (heroes, toMinute) => {
      const s = Object.fromEntries([...SOURCES, 'lost_on_dying'].map((k) => [k, 0]));
      for (const g of trace.gold) {
        // Selling moves money; reason 0 before the horn (minute < 0) is the starting purse, the same for every hero.
        if (g[0] >= toMinute || !heroes.includes(g[1]) || g[2] === SOLD || (g[2] === 0 && g[0] < 0)) continue;
        if (g[2] === DYING) { s.lost_on_dying += g[3]; continue; }
        if (g[3] > 0) s[SOURCE[g[2]] ?? 'other'] += g[3];
      }
      s.earned = SOURCES.reduce((a, k) => a + s[k], 0);
      return s;
    };
    const mine = side(true); const theirs = side(false);
    const at10 = { my_team: sum(mine, LANE_END / 60), enemy: sum(theirs, LANE_END / 60) };
    gold = {
      ...at10,
      my_team_minus_enemy: Object.fromEntries([...SOURCES, 'lost_on_dying', 'earned'].map((k) => [k, at10.my_team[k] - at10.enemy[k]])),
    };
    byTwo = [2, 4, 6, 8, 10].map((m) => {
      const a = sum(mine, m).earned; const b = sum(theirs, m).earned;
      return { at: traceClock(m * 60), my_team_earned: a, enemy_earned: b, my_team_minus_enemy: a - b };
    });
  } else gaps.push({ topic: 'gold_gap_by_source', reason: notKnown.length ? 'a_hero_s_lane_stage_positions_not_in_trace' : 'no_gold_rows_in_trace' });

  // Visits from outside the lane: damage exchanged with the lane's other side, inside the lane's third.
  let visits = null;
  if (!notKnown.length && Array.isArray(trace.damage)) {
    const laneSet = new Set(inLane);
    const seconds = new Map(); // visitor → Set of seconds
    for (const [t, a, b] of trace.damage) {
      if (t >= LANE_END) continue;
      const ia = heroOfName.get(a); const ib = heroOfName.get(b);
      if (ia == null || ib == null || trace.heroes[ia].team === trace.heroes[ib].team) continue;
      for (const [v, o] of [[ia, ib], [ib, ia]]) {
        if (laneSet.has(v) || !laneSet.has(o) || placeAt(trace, v, t) !== lane) continue;
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

  const count = (side) => (visits ? (() => {
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
    visits, enemy_visits: count('enemy'), my_team_visits: count('my_team'),
    my_lane_seconds: { from: traceClock(LANE_FROM), to: traceClock(LANE_END), ...where },
    ...(notKnown.length ? { heroes_whose_lane_is_not_known: notKnown.map(key) } : {}),
    gaps,
  };
}

export const LANE_PROCESS_RULE = `gold_gap_by_source: gold the log says each side of the lane received before 10:00, by source, and lost on dying (the income every hero gets over time is in neither side); visits: a hero from outside the lane exchanging damage with the lane's other side inside the lane's third of the map, seconds ${VISIT_GAP} s or less apart are one visit, died = heroes of the lane or the visitor who died during it or ${VISIT_AFTER} s after; a hero who came without exchanging damage is not counted`;

/** Measured by scripts/calibrate-lane-process.mjs on 209 parsed games with gold rows (1226 lane sides), 2026-11-27. */
export const LANE_PROCESS_REFERENCE = 'On 209 parsed games: in the 474 lane sides that lost their lane, the gold behind from hero kills, assists and dying added up to about as much as the gold behind from lane creeps (308k against 324k), and was the larger part in 45% of them (215). A lane side whose deaths in enemy visits outnumbered the enemy deaths in them by one or more lost its lane in 49% (154 of 315), the others in 35% (320 of 911). A reference for how much each part usually weighs, not what happened here.';
