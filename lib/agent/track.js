/**
 * Hero movement path and 2D activity heatmap over a game-time window — pure, no IO.
 *
 * Reads a `dota2.ai/match-trace@1` through `linkHeroNames` in the exact same world
 * coordinate space as `lib/agent/moment.js` (`MAP_BOUNDS`: -8600..+8600).
 *
 * Honesty invariants:
 * - Only real 1 Hz sampled alive positions enter `segments` and `heat`.
 * - Missing samples (`x == null || y == null || alive == null`) and dead seconds (`alive === 0`)
 *   always break the active path segment and are counted separately in `stats` — unknown is never
 *   treated as dead, stationary, or interpolated.
 * - Large position jumps (`> TRACK_MAX_STEP_DIST` units between consecutive alive seconds, e.g. TP
 *   scroll, Twin Gate, or Relocate) also break the segment so no fake walking line is drawn across
 *   the map.
 * - Real deaths in `[from, to]` use `realDeaths` (excluding Aegis / Reincarnation revivals) and
 *   keep `x: null, y: null` when no real position sample exists near the death second.
 */
import { linkHeroNames, realDeaths } from '../../packages/review-engine/src/trace/index.js';
import { clock as traceClock, heroIndex, region } from '../../packages/review-engine/src/trace/query.js';
import { MAP_BOUNDS, MAP_WORLD_MIN, MAP_WORLD_SIZE } from './mapBounds.js';

/** Grid resolution (N × N cells) over `MAP_BOUNDS` for the activity heatmap. */
export const TRACK_GRID_SIZE = 24;
/** Maximum allowed gap in seconds between consecutive points inside one contiguous segment. */
export const TRACK_MAX_TIME_GAP = 2;
/** Maximum distance (world units) between consecutive alive 1 Hz samples before breaking as a jump/TP. */
export const TRACK_MAX_STEP_DIST = 2500;

const fail = (error) => ({ error });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Compute contiguous movement path segments, 2D occupancy heatmap, real deaths, and coverage stats
 * for one hero over `[from, to]` (game seconds).
 *
 * @param {any} trace a `dota2.ai/match-trace@1`
 * @param {{ hero: string, viewer?: string | null, from?: number | null, to?: number | null, gridSize?: number }} [opts]
 */
export function heroTrackData(trace, opts = {}) {
  const { hero, viewer = null, from = null, to = null, gridSize = TRACK_GRID_SIZE } = opts ?? {};
  if (!trace || !Array.isArray(trace.heroes)) return fail('unknown_hero');
  linkHeroNames(trace);

  const idx = heroIndex(trace, hero);
  if (idx < 0) return fail('unknown_hero');

  const viewerIdx = viewer != null && viewer !== '' ? heroIndex(trace, viewer) : idx;
  if (viewerIdx < 0) return fail('unknown_hero');

  if (!Number.isInteger(trace.t0) || !Number.isInteger(trace.n) || trace.n <= 0) return fail('no_such_time');
  const first = trace.t0;
  const last = trace.t0 + trace.n - 1;

  if ((from != null && !isNum(from)) || (to != null && !isNum(to))) return fail('invalid_window');
  if (from != null && to != null && from > to) return fail('invalid_window');
  const rawFrom = from == null ? Math.min(last, Math.max(first, 0)) : from;
  const rawTo = to == null ? last : to;
  if (rawFrom > last || rawTo < first) return fail('no_such_time');
  if (rawFrom > rawTo) return fail('invalid_window');

  const winFrom = Math.max(first, Math.floor(rawFrom));
  const winTo = Math.min(last, Math.floor(rawTo));
  if (winFrom > winTo) return fail('no_such_time');

  const gs = Number.isInteger(gridSize) && gridSize >= 8 && gridSize <= 64 ? gridSize : TRACK_GRID_SIZE;
  const viewerTeam = trace.heroes[viewerIdx].team;
  const sideOf = (i) => (i === viewerIdx ? 'me' : trace.heroes[i].team === viewerTeam ? 'ally' : 'enemy');
  const heroes = trace.heroes.map((h, i) => ({ hero: h.key, side: sideOf(i) }));
  const targetHero = trace.heroes[idx];
  const st = trace.states?.[idx] ?? null;

  /** @type {{ from: number, to: number, points: [number, number, number][] }[]} */
  const segments = [];
  /** @type {{ from_t: number, to_t: number, from_x: number, from_y: number, to_x: number, to_y: number, reason: 'teleport' | 'dead' | 'missing' }[]} */
  const breaks = [];
  /** @type {Map<string, { gx: number, gy: number, seconds: number }>} */
  const cellCounts = new Map();

  let currentSeg = null;
  let lastPoint = null;
  let gapSawDead = false;
  let gapSawMissing = false;
  let aliveSampledSeconds = 0;
  let deadSeconds = 0;
  let missingSeconds = 0;

  for (let s = winFrom; s <= winTo; s += 1) {
    const k = s - trace.t0;
    const x = st?.x?.[k];
    const y = st?.y?.[k];
    const alive = st?.alive?.[k];
    const hasPos = isNum(x) && isNum(y);

    if (alive === 0) {
      deadSeconds += 1;
      currentSeg = null;
      if (lastPoint) gapSawDead = true;
      continue;
    }

    if (alive === 1 && hasPos) {
      aliveSampledSeconds += 1;

      const gx = Math.min(gs - 1, Math.max(0, Math.floor(((x - MAP_WORLD_MIN) / MAP_WORLD_SIZE) * gs)));
      const gy = Math.min(gs - 1, Math.max(0, Math.floor(((y - MAP_WORLD_MIN) / MAP_WORLD_SIZE) * gs)));
      const cellKey = `${gx}:${gy}`;
      const existing = cellCounts.get(cellKey);
      if (existing) existing.seconds += 1;
      else cellCounts.set(cellKey, { gx, gy, seconds: 1 });

      if (currentSeg) {
        const prev = currentSeg.points[currentSeg.points.length - 1];
        const dt = s - prev[0];
        const stepDist = Math.hypot(x - prev[1], y - prev[2]);
        if (dt > TRACK_MAX_TIME_GAP || stepDist > TRACK_MAX_STEP_DIST) {
          breaks.push({
            from_t: prev[0],
            to_t: s,
            from_x: prev[1],
            from_y: prev[2],
            to_x: x,
            to_y: y,
            reason: dt > TRACK_MAX_TIME_GAP ? 'missing' : 'teleport',
          });
          currentSeg = { from: s, to: s, points: [[s, x, y]] };
          segments.push(currentSeg);
        } else {
          currentSeg.to = s;
          currentSeg.points.push([s, x, y]);
        }
      } else {
        if (lastPoint) {
          breaks.push({
            from_t: lastPoint[0],
            to_t: s,
            from_x: lastPoint[1],
            from_y: lastPoint[2],
            to_x: x,
            to_y: y,
            reason: gapSawMissing ? 'missing' : gapSawDead ? 'dead' : 'teleport',
          });
        }
        gapSawDead = false;
        gapSawMissing = false;
        currentSeg = { from: s, to: s, points: [[s, x, y]] };
        segments.push(currentSeg);
      }

      lastPoint = [s, x, y];
      continue;
    }

    // Missing position or unknown alive flag: never treat as dead or interpolate across it.
    missingSeconds += 1;
    currentSeg = null;
    if (lastPoint) gapSawMissing = true;
  }

  const cells = [...cellCounts.values()].sort((a, b) => a.gy - b.gy || a.gx - b.gx);
  const maxSeconds = cells.reduce((acc, c) => Math.max(acc, c.seconds), 0);

  const npcToKey = new Map(trace.heroes.map((h) => [h.npc, h.key]));
  const keyOfName = (i) => (i >= 0 ? npcToKey.get(trace.names?.[i]) ?? null : null);
  const sampleAt = (sec, requireAlive) => {
    const k = sec - trace.t0;
    if (!st || k < 0 || k >= trace.n) return null;
    const x = st.x?.[k];
    const y = st.y?.[k];
    if (!isNum(x) || !isNum(y)) return null;
    if (requireAlive && st.alive?.[k] !== 1) return null;
    return [x, y];
  };
  const deathPos = (tDeath) => {
    const sec = Math.floor(tDeath);
    return sampleAt(sec, true) ?? sampleAt(sec - 1, true) ?? sampleAt(sec, false);
  };

  const upperDeath = winTo === last || winTo === winFrom ? winTo + 1 : winTo;
  const deaths = realDeaths(trace)
    .filter((d) => {
      if (trace.names?.[d[1]] !== targetHero.npc) return false;
      if (d[0] < winFrom) return false;
      return upperDeath === winTo ? d[0] <= winTo : d[0] < upperDeath;
    })
    .map((d) => {
      const pos = deathPos(d[0]);
      return {
        t: Math.round(d[0] * 10) / 10,
        clock: traceClock(d[0]),
        x: pos ? pos[0] : null,
        y: pos ? pos[1] : null,
        killer: keyOfName(d[2]),
        place: pos ? region(pos[0], pos[1]) : null,
      };
    })
    .sort((a, b) => a.t - b.t);

  const totalSeconds = winTo - winFrom + 1;
  const gaps = [];
  if (missingSeconds > 0) {
    gaps.push({ topic: 'samples', reason: 'missing_position_samples', missing_seconds: missingSeconds });
  }

  return {
    hero: targetHero.key,
    side: sideOf(idx),
    from: winFrom,
    to: winTo,
    trace_start: first,
    duration: last,
    heroes,
    segments,
    breaks,
    heat: {
      grid_size: gs,
      bounds: MAP_BOUNDS,
      max_seconds: maxSeconds,
      cells,
    },
    deaths,
    stats: {
      total_seconds: totalSeconds,
      alive_sampled_seconds: aliveSampledSeconds,
      dead_seconds: deadSeconds,
      missing_seconds: missingSeconds,
    },
    gaps,
  };
}
