/**
 * A moment on the map: where the ten heroes were in the seconds around a game time, for the page to replay.
 *
 * The review cites moments by their game time; a line of numbers ("Phantom Assassin at 3014") is hard to
 * picture, and ten dots moving for eighteen seconds are not. This gives the page those dots.
 *
 * What it holds, and what it does not:
 * - positions once a second, as the trace sampled them, told from the player's side (me / ally / enemy).
 *   A second a hero has no sample for is null: the page leaves the dot out, it never draws a guess;
 * - whether each hero was alive at that second, and the deaths inside the window;
 * - a square of the map to show, fitted to the seconds around the moment itself (FOCUS): every hero within
 *   NEAR of the player at one of those seconds is inside it at that second;
 * - who was never within NEAR of the player in the whole window (`away`) — said only of a hero the replay has
 *   a sample of, and of the player, at every second of it. With a sample missing, a hero not seen near is
 *   `not_known`: the missing second may be the one they were near in;
 * - where on the map the player stood at the moment (`place`, a region key), or null without a sample;
 * - the abilities cast in the window by the player and by the heroes who were near them (`casts`), and the
 *   wards standing inside the square during it (`wards`): where a ward stood, by whose it was — a ward is a
 *   place, not what it showed anyone. Either is null on a trace that does not hold that list: not known, not none;
 * - nothing about who could see whom: a dot on this map is where a hero stood, not what anyone saw.
 */
import { clock as traceClock, region } from '../../packages/review-engine/src/trace/query.js';
import { classifyDeath, fightParticipation, matchFights, realDeaths } from '../../packages/review-engine/src/trace/index.js';
import { MAP_WORLD_HALF as WORLD } from './mapBounds.js';

/** Seconds shown before and after the moment. */
export const MOMENT_BEFORE = 12;
export const MOMENT_AFTER = 6;
/** A hero this close to the player (or to a replayed fight) at a second is part of the picture at that second. */
export const MOMENT_NEAR = 3200;
/** The square shown is fitted to this many seconds either side of the moment: the approach before it may come from across the map. */
export const MOMENT_FOCUS = 6;
/** The map's half-width in world units, and the least and the padding of the square shown. */
/** At most this many casts are sent for a single moment (or MOMENT_FIGHT_CASTS when replaying a full fight span). */
export const MOMENT_CASTS = 40;
export const MOMENT_FIGHT_CASTS = 120;
export const MOMENT_MAX_SPAN = 180;
const MIN_HALF = 1400;
const PAD = 500;

const fail = (error) => ({ error });

/**
 * @param {any} trace  a `dota2.ai/match-trace@1`, hero names linked
 * @param {{ hero: string, t: number, to?: number | null, before?: number, after?: number }} o  the player's hero key, the game time (seconds), and optional fight end time `to`
 * @returns {{ error: string } | { t: number, clock: string, from: number, to: number, me: string, place: string | null, heroes: { hero: string, side: 'me' | 'ally' | 'enemy' }[], frames: { t: number, at: ([number, number, 0 | 1] | null)[] }[], deaths: { t: number, hero: string, killer: string | null }[], box: { x: number, y: number, size: number }, away: string[], not_known: string[], casts: { t: number, hero: string, ability: string, target: string | null }[] | null, wards: { x: number, y: number, side: 'mine' | 'enemy', kind: 'observer' | 'sentry', from: number | null, to: number | null }[] | null }}
 */
export function momentFrames(trace, { hero, t, to: endT = null, before = MOMENT_BEFORE, after = MOMENT_AFTER } = {}) {
  const me = Array.isArray(trace?.heroes) ? trace.heroes.findIndex((h) => h.key === hero) : -1;
  if (me < 0) return fail('unknown_hero');
  const first = trace.t0; const last = trace.t0 + trace.n - 1;
  if (!Number.isFinite(t) || Math.round(t) < first || Math.round(t) > last) return fail('no_such_time');
  const isSpan = endT != null;
  if (isSpan && (!Number.isFinite(endT) || endT < t || Math.floor(endT) > last)) return fail('no_such_time');
  const at = Math.round(t);
  const endAt = isSpan ? Math.min(last, Math.max(at, Math.ceil(endT)), at + MOMENT_MAX_SPAN) : at;
  const from = Math.max(first, at - Math.max(0, Math.round(before)));
  const to = isSpan
    ? Math.min(last, Math.min(endAt + Math.max(0, Math.round(after)), at + MOMENT_MAX_SPAN))
    : Math.min(last, at + Math.max(0, Math.round(after)));
  const myTeam = trace.heroes[me].team;
  const heroes = trace.heroes.map((h, i) => ({ hero: h.key, side: i === me ? 'me' : h.team === myTeam ? 'ally' : 'enemy' }));
  const sample = (i, s) => {
    const st = trace.states[i]; const k = s - trace.t0;
    // Only the sample of that very second: the nearest one would put a hero where they were not.
    return st && st.x[k] != null && st.y[k] != null ? [st.x[k], st.y[k], st.alive[k] === 1 ? 1 : 0] : null;
  };
  const frames = [];
  for (let s = from; s <= to; s += 1) frames.push({ t: s, at: trace.heroes.map((_, i) => sample(i, s)) });

  const heroOfNpc = new Map(trace.heroes.map((h, i) => [h.npc, i]));
  // When replaying a fight span (`to` given), fit the camera and casts around the fight's death spots / combatants
  // rather than the player, who may be farming elsewhere or dead in the fountain during that fight (#363).
  const spanFight = isSpan
    ? ((Array.isArray(trace.deaths) ? matchFights(trace).find((f) => Math.abs(f.from - t) <= 1 && Math.abs(f.to - endT) <= 1) : null)
      ?? { from: t, to: endT, deaths: realDeaths(trace).filter((d) => d[0] >= Math.min(t, at) - 1 && d[0] <= Math.max(endT, endAt) + 1) })
    : null;
  const fightPart = spanFight && spanFight.deaths.length ? fightParticipation(trace, spanFight) : null;
  const fightSpots = spanFight
    ? spanFight.deaths
      .map((d) => {
        const v = heroOfNpc.get(trace.names?.[d[1]]);
        if (v == null) return null;
        return sample(v, Math.round(d[0] - 1)) ?? sample(v, Math.round(d[0]));
      })
      .filter((sp) => sp && sp[2] === 1)
    : [];

  // Who was near the player (or near the fight when `fightSpots` exist), second by second.
  const near = trace.heroes.map(() => false);
  const whole = trace.heroes.map(() => true);
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
  if (fightSpots.length > 0) {
    for (const sp of fightSpots) {
      x0 = Math.min(x0, sp[0]); x1 = Math.max(x1, sp[0]); y0 = Math.min(y0, sp[1]); y1 = Math.max(y1, sp[1]);
    }
    for (const f of frames) {
      f.at.forEach((q, i) => {
        if (!q) { whole[i] = false; return; }
        if (!fightSpots.some((sp) => Math.hypot(q[0] - sp[0], q[1] - sp[1]) <= MOMENT_NEAR)) return;
        near[i] = true;
        if (f.t < at - MOMENT_FOCUS || f.t > endAt) return;
        x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
      });
    }
  } else {
    const focusTo = isSpan ? endAt : at + MOMENT_FOCUS;
    for (const f of frames) {
      const p = f.at[me];
      f.at.forEach((q, i) => {
        if (!p || !q) { whole[i] = false; return; }
        if (Math.hypot(q[0] - p[0], q[1] - p[1]) > MOMENT_NEAR) return;
        near[i] = true;
        if (f.t < at - MOMENT_FOCUS || f.t > focusTo) return;
        x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
      });
    }
  }
  // When there is nothing to centre on, the whole map is shown.
  const box = Number.isFinite(x0)
    ? (() => {
      const half = Math.min(WORLD, Math.max(MIN_HALF, Math.max(x1 - x0, y1 - y0) / 2 + PAD));
      const cx = Math.min(WORLD - half, Math.max(-WORLD + half, (x0 + x1) / 2));
      const cy = Math.min(WORLD - half, Math.max(-WORLD + half, (y0 + y1) / 2));
      return { x: Math.round(cx - half), y: Math.round(cy - half), size: Math.round(half * 2) };
    })()
    : { x: -WORLD, y: -WORLD, size: WORLD * 2 };

  const npc = new Map(trace.heroes.map((h) => [h.npc, h.key]));
  const keyOfName = (i) => (i >= 0 ? npc.get(trace.names[i]) ?? null : null);
  const deaths = (trace.deaths ?? [])
    .filter((d) => d[0] >= from && d[0] <= to + 1 && keyOfName(d[1]))
    .map((d) => {
      const c = classifyDeath(trace, d);
      return { t: Math.round(d[0] * 10) / 10, hero: keyOfName(d[1]), killer: keyOfName(d[2]), ...(c.real ? {} : { resurrected_by: c.by }) };
    });

  // Abilities cast in the window by a hero who is part of the picture: in a fight span with death spots, anyone near
  // the fight; in a player moment, the player or anyone near them at some second.
  const castCap = isSpan ? MOMENT_FIGHT_CASTS : MOMENT_CASTS;
  const casts = Array.isArray(trace.casts)
    ? trace.casts
      .filter((c) => c[0] >= from && c[0] <= to + 1)
      .map((c) => ({ i: heroOfNpc.get(trace.names[c[1]]), t: Math.round(c[0] * 10) / 10, ability: trace.names[c[2]], target: c[3] >= 0 ? keyOfName(c[3]) : null }))
      .filter((c) => c.i != null && (fightSpots.length > 0 ? near[c.i] : (c.i === me || near[c.i])) && typeof c.ability === 'string')
      .slice(0, castCap)
      .map(({ i, ...c }) => ({ ...c, hero: trace.heroes[i].key }))
    : null;
  // Wards standing inside the square at some second of the window. Standing as observersNear reads it: not placed
  // after the window, not gone before it; a ward whose placing the replay did not record counts until it is gone.
  const wards = Array.isArray(trace.wards)
    ? trace.wards
      .filter(([f, gone, , , x, y]) => (f == null || f <= to) && (gone == null || gone > from) && x >= box.x && x <= box.x + box.size && y >= box.y && y <= box.y + box.size)
      .map(([f, gone, team, kind, x, y]) => ({ x, y, side: team === myTeam ? 'mine' : 'enemy', kind: kind === 'o' ? 'observer' : 'sentry', from: f ?? null, to: gone ?? null }))
    : null;

  const here = sample(me, at);
  const place = fightSpots.length > 0
    ? (fightPart?.at ? region(fightPart.at.x, fightPart.at.y) : region(fightSpots[0][0], fightSpots[0][1]))
    : (here ? region(here[0], here[1]) : null);
  const others = heroes.map((h, i) => ({ hero: h.hero, i })).filter(({ i }) => (fightSpots.length > 0 ? !near[i] : (i !== me && !near[i])));
  return {
    t: at, clock: traceClock(at), from, to, me: hero, place, heroes, frames, deaths, box,
    // Never near, and the replay shows it for every second; or not seen near, with a second it cannot speak for.
    away: others.filter(({ i }) => whole[i]).map((o) => o.hero),
    not_known: others.filter(({ i }) => !whole[i]).map((o) => o.hero),
    casts, wards,
  };
}
