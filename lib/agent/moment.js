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
 * - a square of the map to show: every hero that was within NEAR of the player at some second of the
 *   window is inside it at that second. A hero who was never that near is listed under `away`;
 * - nothing about who could see whom: a dot on this map is where a hero stood, not what anyone saw.
 */
import { clock as traceClock } from '../../packages/review-engine/src/trace/query.js';

/** Seconds shown before and after the moment. */
export const MOMENT_BEFORE = 12;
export const MOMENT_AFTER = 6;
/** A hero this close to the player at a second is part of the picture at that second. */
export const MOMENT_NEAR = 3200;
/** The map's half-width in world units, and the least and the padding of the square shown. */
const WORLD = 8600;
const MIN_HALF = 1400;
const PAD = 500;

const fail = (error) => ({ error });

/**
 * @param {any} trace  a `dota2.ai/match-trace@1`, hero names linked
 * @param {{ hero: string, t: number, before?: number, after?: number }} o  the player's hero key and the game time (seconds)
 * @returns {{ error: string } | { t: number, clock: string, from: number, to: number, me: string, heroes: { hero: string, side: 'me' | 'ally' | 'enemy' }[], frames: { t: number, at: ([number, number, 0 | 1] | null)[] }[], deaths: { t: number, hero: string, killer: string | null }[], box: { x: number, y: number, size: number }, away: string[] }}
 */
export function momentFrames(trace, { hero, t, before = MOMENT_BEFORE, after = MOMENT_AFTER } = {}) {
  const me = Array.isArray(trace?.heroes) ? trace.heroes.findIndex((h) => h.key === hero) : -1;
  if (me < 0) return fail('unknown_hero');
  const first = trace.t0; const last = trace.t0 + trace.n - 1;
  if (!Number.isFinite(t) || Math.round(t) < first || Math.round(t) > last) return fail('no_such_time');
  const at = Math.round(t);
  const from = Math.max(first, at - Math.max(0, Math.round(before)));
  const to = Math.min(last, at + Math.max(0, Math.round(after)));
  const myTeam = trace.heroes[me].team;
  const heroes = trace.heroes.map((h, i) => ({ hero: h.key, side: i === me ? 'me' : h.team === myTeam ? 'ally' : 'enemy' }));
  const sample = (i, s) => {
    const st = trace.states[i]; const k = s - trace.t0;
    // Only the sample of that very second: the nearest one would put a hero where they were not.
    return st && st.x[k] != null && st.y[k] != null ? [st.x[k], st.y[k], st.alive[k] === 1 ? 1 : 0] : null;
  };
  const frames = [];
  for (let s = from; s <= to; s += 1) frames.push({ t: s, at: trace.heroes.map((_, i) => sample(i, s)) });

  // The square to show: the player, and whoever was near them, at the seconds they were.
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
  const seen = new Set();
  for (const f of frames) {
    const p = f.at[me];
    if (!p) continue;
    f.at.forEach((q, i) => {
      if (!q || Math.hypot(q[0] - p[0], q[1] - p[1]) > MOMENT_NEAR) return;
      seen.add(i);
      x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
    });
  }
  // The player has no sample in the whole window: there is nothing to centre on, so the whole map is shown.
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
    .map((d) => ({ t: Math.round(d[0] * 10) / 10, hero: keyOfName(d[1]), killer: keyOfName(d[2]) }));

  return {
    t: at, clock: traceClock(at), from, to, me: hero, heroes, frames, deaths, box,
    away: heroes.filter((_, i) => !seen.has(i)).map((h) => h.hero),
  };
}
