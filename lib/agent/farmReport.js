/**
 * farm_report: what the other side was doing — who on each team was getting
 * richer, stretch by stretch and inside each window one side was ahead, and
 * whether the enemy stood by the buildings the player's team took.
 *
 * Told from one hero's side (use the player). The money is, in this order:
 * - the match data's per-minute gold of each player (OpenDota `gold_t`,
 *   gold earned), with last hits (`lh_t`) when it has them;
 * - else the replay's per-minute net worth of each hero (`trace.net_worth`);
 * - else none, a stated gap. The answer says which it is, and the two are not
 *   mixed in one answer.
 *
 * Facts only: a hero who gained the most in a window was the richest-growing,
 * not proof the enemy "let them farm"; enemies near a building as it fell
 * were near, not proof they defended it.
 */
import { HEROES_BY_KEY, STATIC_HEROES } from '../../packages/review-engine/src/staticHeroes.js';
import { matchOverview, traceClock } from '../../packages/review-engine/src/trace/index.js';
import { windowReport } from './windowReport.js';

const STRETCH = 10;
const NEAR = 2200;
/** Buildings that are objectives: towers, barracks, the Ancient. */
const OBJECTIVE = /_(tower\d|melee_rax|range_rax|fort)(_(top|mid|bot))?$/;
const BY_ID = new Map(Object.values(STATIC_HEROES).map((h) => [h.id, h]));
const slugOf = (hero) => String(hero ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_');

/** Each hero's money by minute: { source, series: Map<heroKey, number[]>, lastHits: Map|null } or null. */
function moneyOf(trace, match) {
  const players = Array.isArray(match?.players) ? match.players : [];
  const keyOf = (id) => { const h = BY_ID.get(id); return h ? trace.heroes.find((x) => x.key === h.internalSlug || HEROES_BY_KEY.get(x.key)?.id === id)?.key ?? null : null; };
  const gold = new Map(); const lh = new Map();
  for (const p of players) {
    const key = keyOf(p?.hero_id);
    if (!key) continue;
    if (Array.isArray(p.gold_t) && p.gold_t.length) gold.set(key, p.gold_t);
    if (Array.isArray(p.lh_t) && p.lh_t.length) lh.set(key, p.lh_t);
  }
  // All ten or nothing: one hero missing would make the comparison a different one.
  if (gold.size === trace.heroes.length) return { source: 'match_data_gold_earned', series: gold, lastHits: lh.size === trace.heroes.length ? lh : null };
  const nw = Array.isArray(trace.net_worth) ? trace.net_worth : null;
  if (nw && nw.length === trace.heroes.length && nw.every((g) => Array.isArray(g) && g.length)) {
    return { source: 'replay_net_worth', series: new Map(trace.heroes.map((h, i) => [h.key, nw[i]])), lastHits: null };
  }
  return null;
}

export function farmReport(trace, args = {}, ctx = {}) {
  const slug = slugOf(args.hero);
  const seat = trace.heroes.find((h) => h.key === slug);
  if (!seat) return { error: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
  const side = (team) => (team === seat.team ? 'my_team' : 'enemy');
  const overview = matchOverview(trace, {}, { perspective: seat.key, match: ctx.match ?? null });
  const end = overview.duration?.t ?? trace.t0 + trace.n - 1;
  const money = moneyOf(trace, ctx.match);

  // Buildings the player's team took, and which enemy heroes were alive and near as each fell.
  const at = (i, t) => { const s = trace.states[i]; const k = Math.round(t) - trace.t0; return k >= 0 && k < trace.n && s.x[k] != null ? { x: s.x[k], y: s.y[k], alive: s.alive[k] === 1 } : null; };
  const taken = overview.buildings.filter((b) => b.lost_by === 'enemy' && OBJECTIVE.test(b.building)).map((b, n) => {
    // The trace does not say where a building stands: "near" is near any living hero of the player's team.
    const mine = trace.heroes.map((h, i) => ({ h, i })).filter(({ h }) => h.team === seat.team).map(({ i }) => at(i, b.t)).filter((s) => s?.alive);
    const enemies = trace.heroes.map((h, i) => ({ h, i })).filter(({ h }) => h.team !== seat.team).map(({ h, i }) => ({ h, s: at(i, b.t) }));
    const known = enemies.every((e) => e.s) && mine.length > 0;
    const near = enemies.filter((e) => e.s?.alive && mine.some((m) => Math.hypot(m.x - e.s.x, m.y - e.s.y) <= NEAR)).map((e) => e.h.key);
    // Its own ref: a sentence about one building cites it, and the summary above stays the counts.
    return { ref: `farm:${seat.key}:b${n + 1}`, clock: b.clock, t: b.t, building: b.building, enemy_heroes_alive: enemies.filter((e) => e.s?.alive).length, ...(known ? { enemy_heroes_near_your_team: near } : { enemy_heroes_near_your_team: null }) };
  });

  const base = {
    ref: `farm:${seat.key}`, ref_scope: 'summary', hero: seat.key,
    told_from: { hero: seat.key, note: 'my_team is this hero\'s team' },
    buildings_your_team_took_total: taken.length,
    // Of them, those with no enemy hero near any of the team's heroes as it fell (null where a position was not sampled).
    buildings_your_team_took_with_no_enemy_near: taken.filter((b) => Array.isArray(b.enemy_heroes_near_your_team) && b.enemy_heroes_near_your_team.length === 0).map((b) => b.clock),
    buildings_your_team_took: taken.map(({ t, ...b }) => b),
    near_rule: `an enemy hero is near when alive and within ${NEAR} of a living hero of the player's team at the second the building fell; the trace does not say where a building stands`,
  };
  if (!money) return { ...base, money: null, gaps: [{ topic: 'money_by_minute', reason: 'no_per_minute_gold_in_the_match_data_and_no_net_worth_in_the_replay' }] };

  const last = Math.min(Math.floor(end / 60), ...[...money.series.values()].map((s) => s.length - 1));
  const gain = (key, a, b) => { const s = money.series.get(key); const x = s[Math.min(a, last)]; const y = s[Math.min(b, last)]; return Number.isFinite(x) && Number.isFinite(y) ? y - x : null; };
  const lhGain = (key, a, b) => { const s = money.lastHits?.get(key); if (!s) return null; const x = s[Math.min(a, last)]; const y = s[Math.min(b, last)]; return Number.isFinite(x) && Number.isFinite(y) ? y - x : null; };
  const slice = (a, b) => {
    const gained = Object.fromEntries(trace.heroes.map((h) => [h.key, gain(h.key, a, b)]));
    const top = (who) => trace.heroes.filter((h) => side(h.team) === who && gained[h.key] != null).sort((x, y) => gained[y.key] - gained[x.key])[0]?.key ?? null;
    const sum = (who) => trace.heroes.filter((h) => side(h.team) === who).reduce((acc, h) => (acc == null || gained[h.key] == null ? null : acc + gained[h.key]), 0);
    return {
      gained, ...(money.lastHits ? { last_hits: Object.fromEntries(trace.heroes.map((h) => [h.key, lhGain(h.key, a, b)])) } : {}),
      gained_total: { my_team: sum('my_team'), enemy: sum('enemy') },
      gained_most: { my_team: top('my_team'), enemy: top('enemy') },
    };
  };

  const stretches = [];
  for (let a = 0, n = 1; a < last; a += STRETCH, n += 1) {
    const b = Math.min(a + STRETCH, last);
    stretches.push({ ref: `farm:${seat.key}:${n}`, t: a * 60, from: a * 60, to: b * 60, clock: `${traceClock(a * 60)}–${traceClock(b * 60)}`, ...slice(a, b), buildings_your_team_took: taken.filter((x) => x.t >= a * 60 && x.t < b * 60).map(({ t, ...x }) => x) });
  }
  const w = windowReport(trace, { hero: seat.key }, ctx);
  const windows = (w.windows ?? []).map((x, i) => {
    const a = Math.floor(x.from / 60); const b = Math.min(Math.ceil(x.to / 60), last);
    return { ref: `farm:${seat.key}:w${i + 1}`, window: x.ref, t: x.from, from: x.from, to: x.to, clock: x.clock, ahead: x.ahead, ...slice(a, b) };
  });
  const whole = slice(0, last);
  return {
    ...base,
    money: money.source,
    money_note: money.source === 'replay_net_worth' ? 'net worth (items and gold held) from the replay, not gold earned: what a hero gained in net worth over a stretch' : 'gold earned, from the match data',
    // One map per measure, keyed by hero: the tool's own numbers over the whole game.
    gained_over_the_game: whole.gained,
    gained_most_over_the_game: whole.gained_most,
    stretches,
    windows,
    note: 'Who gained the most is who got richer, not proof of what anyone allowed. Windows are window_report\'s (same refs in `window`).',
    gaps: [
      ...(money.lastHits ? [] : [{ topic: 'last_hits_by_minute', reason: 'not_in_the_data_for_this_game' }]),
      ...(w.windows ? [] : [{ topic: 'windows', reason: 'no_gold_lead_by_minute' }]),
      { topic: 'where_buildings_stand', reason: 'not_in_trace' },
    ],
  };
}

export const FARM_TOOL = {
  name: 'farm_report',
  description: "What the other side was doing, told from a hero's side (use the player): each hero's gold earned (or net worth gained, the answer says which) and last hits when known, in each ten-minute stretch and inside each window one side was ahead (window_report's windows), with who on each team gained the most; and for each building the player's team took, how many enemy heroes were alive and which were near the team as it fell. Use it for whether the enemy's cores farmed while the player's team had its chance, and whether the enemy stood by what the team took.",
  input_schema: { type: 'object', properties: { hero: { type: 'string', description: 'Hero key as in match_overview. Use the player\'s hero.' } }, required: ['hero'], additionalProperties: false },
  run: farmReport,
};
