/**
 * window_report: when each side was ahead, and what happened around the end
 * of it — the "game plan against their game plan" a review can be read on.
 *
 * Three things on one time line, told from one hero's side:
 * - the team's gold lead minute by minute (the match data's per-minute
 *   radiant_gold_adv; the replay trace has no gold);
 * - the big items each side finished during a window and just before its
 *   end (the replay; a big item as power_spikes reads it, in this game's
 *   patch). power_spikes has every hero's big items over the whole game: this
 *   tool adds the gold over time those lack, and what fell inside each window;
 * - the buildings each side took and the fights each side lost fewer heroes
 *   in (match_overview).
 *
 * A window is a run of minutes in which one side stayed ahead (lead above
 * zero at every minute of it) and led by at least WINDOW_PEAK at some
 * minute. It ends at the first minute that side is no longer ahead.
 *
 * Facts only. What happened in the last minutes of a window is listed next
 * to it ("finished in the 180 s before it ended"); that it closed the window
 * is a judgment the tools do not make. Without the per-minute gold there are
 * no windows: a stated gap, never an estimate.
 */
import { createRequire } from 'node:module';
import { HEROES_BY_KEY, STATIC_HEROES } from '../../packages/review-engine/src/staticHeroes.js';
import { itemTimeline, matchOverview, traceClock } from '../../packages/review-engine/src/trace/index.js';
import { ALWAYS_KEY_ITEMS, KEY_ITEM_MIN_COST } from '../coach/knowledge.js';
import { isBigItemIn, patchForGame } from './patchData.js';

const ITEM_NAMES = createRequire(import.meta.url)('../coach/data/names.json').items;
const BY_ID = new Map(Object.values(STATIC_HEROES).map((h) => [h.id, h]));
// A hero's key in the replay is not always its internal slug ("queen_of_pain"): the scoreboard is matched by id through both.
const keyOfId = (id, trace) => { const h = BY_ID.get(id); if (!h) return null; const hit = trace.heroes.find((x) => x.key === h.internalSlug || HEROES_BY_KEY.get(x.key)?.id === id); return hit ? hit.key : null; };

/** A window's lead must reach this at some minute. */
export const WINDOW_PEAK = 2000;
/** Key items finished this close to a window's end are listed beside its end. */
export const WINDOW_END_SECONDS = 180;
const MARKS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
/** Buildings that are objectives (as tempo_report counts them): towers, barracks, the Ancient — not the filler buildings around a base. */
const OBJECTIVE = /_(tower\d|melee_rax|range_rax|fort)(_(top|mid|bot))?$/;

const slugOf = (hero) => String(hero ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_');
const clockOfMinute = (m) => `${m}:00`;

/**
 * @param {any} trace  a dota2.ai/match-trace@1
 * @param {{ hero?: string }} args  the hero whose side the answer is told from
 * @param {{ match?: any, lang?: string }} ctx
 */
export function windowReport(trace, args = {}, ctx = {}) {
  const slug = slugOf(args.hero);
  const seat = trace.heroes.find((h) => h.key === slug);
  if (!seat) return { error: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
  const lang = ctx.lang === 'zh' ? 'zh' : 'en';
  const view = { perspective: seat.key, match: ctx.match ?? null };
  const overview = matchOverview(trace, {}, view);
  const end = overview.duration?.t ?? trace.t0 + trace.n - 1;
  const side = (team) => (team === seat.team ? 'my_team' : 'enemy');

  // Every hero's big items in this game's patch — resolved as power_spikes resolves it (from the match id or its
  // start time when the match data has no patch), so the two tools always call the same items big.
  const pd = patchForGame(trace.match_id, ctx.match);
  const keyItems = trace.heroes.flatMap((h) => itemTimeline(trace, { hero: h.key }).items
    .filter((i) => isBigItemIn(pd, i.item, { minCost: KEY_ITEM_MIN_COST, always: ALWAYS_KEY_ITEMS }) && i.first_held.t <= end)
    // Each with item_timeline's own ref: a sentence about it cites that record.
    .map((i) => ({ ref: i.ref, t: i.first_held.t, clock: i.first_held.clock, hero: h.key, side: side(h.team), item: i.item, name: ITEM_NAMES[i.item]?.[lang] ?? ITEM_NAMES[i.item]?.en ?? i.item })))
    .sort((a, b) => a.t - b.t);
  const itemsIn = (from, to, who) => keyItems.filter((x) => x.t >= from && x.t < to && x.side === who).map(({ t, side: _, ...x }) => x);

  // Net worth at the end, from the scoreboard: which heroes each side's gold went to.
  const players = Array.isArray(ctx.match?.players) ? ctx.match.players : [];
  const worth = {};
  for (const p of players) {
    const key = keyOfId(p?.hero_id, trace);
    if (key && Number.isFinite(p.net_worth)) worth[key] = p.net_worth;
  }
  const byWorth = (who) => trace.heroes.filter((h) => side(h.team) === who && worth[h.key] != null).sort((a, b) => worth[b.key] - worth[a.key]).map((h) => h.key);

  const base = {
    // The hero is in the ref: the same game read from the other side is another record.
    ref: `window:${seat.key}`, ref_scope: 'summary', hero: seat.key,
    told_from: { hero: seat.key, note: 'my_team is this hero\'s team; a negative lead means my_team was behind' },
    duration: overview.duration,
    data_patch: pd.name,
    big_items_rule: 'as power_spikes reads them: a finished item of 2000 gold or more in this game\'s patch, or one of a fixed list (Blink Dagger, Black King Bar, Force Staff, …); the time is when the hero first held it. power_spikes lists every hero\'s over the whole game',
    ...(Object.keys(worth).length === trace.heroes.length ? { net_worth_at_end: worth, heroes_by_net_worth: { my_team: byWorth('my_team'), enemy: byWorth('enemy') } } : {}),
  };

  const adv = Array.isArray(ctx.match?.radiant_gold_adv) ? ctx.match.radiant_gold_adv : null;
  const last = Math.floor(end / 60);
  const lead = (m) => { const v = adv?.[m]; return Number.isFinite(v) ? (seat.team === 2 ? v : -v) : null; };
  // Every minute up to the end must be there: a window drawn over a missing minute could be two windows.
  if (!adv || Array.from({ length: last + 1 }, (_, m) => lead(m)).some((v) => v == null)) {
    return { ...base, windows: null, gaps: [{ topic: 'gold_lead_by_minute', reason: adv ? 'match_data_has_missing_minutes' : 'no_per_minute_gold_in_the_match_data' }, ...overview.gaps.filter((g) => g.topic !== 'gold_advantage')] };
  }

  const series = Array.from({ length: last + 1 }, (_, m) => lead(m));
  let peak = { m: 0, v: series[0] }; let low = { m: 0, v: series[0] };
  series.forEach((v, m) => { if (v > peak.v) peak = { m, v }; if (v < low.v) low = { m, v }; });

  // Runs of minutes with one side ahead; a run is a window when its lead reached WINDOW_PEAK.
  const runs = [];
  let cur = null;
  series.forEach((v, m) => {
    const who = v > 0 ? 'my_team' : v < 0 ? 'enemy' : null;
    if (cur && who === cur.who) { cur.last = m; if (Math.abs(v) > Math.abs(cur.peak.v)) cur.peak = { m, v }; return; }
    if (cur) runs.push(cur);
    cur = who ? { who, first: m, last: m, peak: { m, v } } : null;
  });
  if (cur) runs.push(cur);
  const windows = runs.filter((r) => Math.abs(r.peak.v) >= WINDOW_PEAK).map((r, i) => {
    const from = r.first * 60;
    const closed = r.last + 1 <= last;
    const to = closed ? (r.last + 1) * 60 : end;
    const other = r.who === 'my_team' ? 'enemy' : 'my_team';
    // A window that closed ends where the next begins: a building at that moment is the next one's. The last
    // window keeps the end of the game (the Ancient falls at it).
    const buildings = overview.buildings.filter((b) => b.t >= from && (closed ? b.t < to : b.t <= to) && OBJECTIVE.test(b.building));
    const fights = overview.fights.filter((f) => f.from >= from && f.from < to);
    return {
      ref: `window:${seat.key}:${i + 1}`, t: from, from, to, clock: `${traceClock(from)}–${traceClock(to)}`,
      ahead: r.who,
      // The lead of the side that was ahead, at its highest.
      peak_lead: { clock: clockOfMinute(r.peak.m), value: Math.abs(r.peak.v) },
      lead_at_start: Math.abs(series[r.first]),
      ended: closed ? { clock: clockOfMinute(r.last + 1), my_team_gold_lead: series[r.last + 1] } : { clock: traceClock(end), by: 'end_of_the_game' },
      buildings_taken: { my_team: buildings.filter((b) => b.lost_by === 'enemy').length, enemy: buildings.filter((b) => b.lost_by === 'my_team').length },
      buildings: buildings.map((b) => ({ clock: b.clock, building: b.building, taken_by: b.lost_by === 'enemy' ? 'my_team' : 'enemy' })),
      fights_total: fights.length,
      fights_lost_fewer_heroes: { my_team: fights.filter((f) => f.lost_fewer_heroes === 'my_team').length, enemy: fights.filter((f) => f.lost_fewer_heroes === 'enemy').length },
      fights: fights.map((f) => ({ fight: f.ref, clock: f.clock, my_team_deaths: f.my_team_deaths, enemy_deaths: f.enemy_deaths })),
      big_items_finished: { my_team: itemsIn(from, to, 'my_team'), enemy: itemsIn(from, to, 'enemy') },
      // Only for a window that ended before the game did: what the side that was behind finished just before.
      ...(closed ? { [`${other}_big_items_in_the_last_${WINDOW_END_SECONDS}s`]: itemsIn(Math.max(from, to - WINDOW_END_SECONDS), to, other) } : {}),
    };
  });

  return {
    ...base,
    // The moments the lead is read at, as game times a sentence may state (keys of the map below are not read as times).
    measured_at: MARKS.filter((m) => m <= last).map(clockOfMinute),
    my_team_gold_lead_at: Object.fromEntries(MARKS.filter((m) => m <= last).map((m) => [clockOfMinute(m), series[m]])),
    highest_lead: { clock: clockOfMinute(peak.m), value: peak.v },
    deepest_deficit: { clock: clockOfMinute(low.m), value: low.v },
    windows_total: { my_team: windows.filter((w) => w.ahead === 'my_team').length, enemy: windows.filter((w) => w.ahead === 'enemy').length },
    windows,
    windows_rule: `a window is a run of minutes in which one side's gold lead stayed above zero and reached ${WINDOW_PEAK} or more; it ends at the first minute that side is no longer ahead`,
    note: 'Gold lead is the match data\'s per-minute value. Big items finished near the end of a window are listed beside it: that they ended it is a judgment, not something these numbers show.',
    gaps: [...overview.gaps.filter((g) => g.topic !== 'gold_advantage'), ...(pd.exact ? [] : [{ topic: 'item_and_ability_data_of_this_game_patch', reason: `${pd.reason}; ${pd.name} data used` }])],
  };
}

export const WINDOW_TOOL = {
  name: 'window_report',
  description: "When each side was ahead in gold and what happened inside it, told from a hero's side (use the player): the team's gold lead every 5 minutes, its highest and lowest, and each window (a run of minutes one side stayed ahead, reaching 2000 or more) with its peak, the buildings each side took and the fights each side came out ahead in during it, the big items each side finished during it, and the big items the side that was behind finished in the 180 seconds before it ended; and each hero's net worth at the end. Use it for when the player's team had its chance, what it did with it, and what the enemy did meanwhile. power_spikes has every hero's big items over the whole game.",
  input_schema: { type: 'object', properties: { hero: { type: 'string', description: 'Hero key as in match_overview, e.g. "beastmaster".' } }, required: ['hero'], additionalProperties: false },
  run: windowReport,
};
