/**
 * Map geometry for parsed matches, on OpenDota's 128-unit cell grid (the
 * playable map spans roughly cells 64–192 on both axes). Radiant's base is
 * bottom-left, Dire's top-right, and the river runs corner to corner along
 * x + y ≈ 256 — checked against 9091400302, whose top-lane fight deaths sit
 * near (91, 167) and bottom-lane ones near (157, 107).
 *
 * Only team-fight deaths carry a position (teamfights[].players[].deaths_pos);
 * deaths outside fights do not, so nothing here says where you were caught.
 */

const RIVER_SUM = 256;
/** Half-width of the river band, in cells. */
const RIVER_HALF = 10;
/** About one observer ward's vision radius (1600 units), in cells. */
export const WARD_RADIUS = 13;
/** Observer lifetime when the replay has no removal for it. */
const OBS_LIFETIME = 360;

/** Weighted centre of a fight's death positions, or null without any. */
export function fightCenter(rawFight) {
  let sx = 0; let sy = 0; let n = 0;
  for (const p of rawFight?.players ?? []) {
    for (const [x, ys] of Object.entries(p?.deaths_pos ?? {})) {
      for (const [y, c] of Object.entries(ys ?? {})) {
        const k = Number(c) || 0;
        if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y)) || k <= 0) continue;
        sx += Number(x) * k; sy += Number(y) * k; n += k;
      }
    }
  }
  return n ? { x: sx / n, y: sy / n } : null;
}

/** 'own' | 'river' | 'enemy' half of the map, from one team's point of view. */
export function sideOf(pt, radiant) {
  const s = pt.x + pt.y - RIVER_SUM;
  if (Math.abs(s) <= RIVER_HALF) return 'river';
  return (s < 0) === radiant ? 'own' : 'enemy';
}

/**
 * Observer wards per team with their lifetime, or null when the parse has no
 * ward log at all (unknown, never "no wards").
 */
export function observerWards(players) {
  if (!players.some((p) => Array.isArray(p.raw.obs_log))) return null;
  const out = [];
  for (const p of players) {
    const left = new Map((p.raw.obs_left_log ?? []).filter((o) => o?.ehandle != null).map((o) => [o.ehandle, o.time]));
    for (const o of p.raw.obs_log ?? []) {
      if (!Number.isFinite(o?.x) || !Number.isFinite(o?.y) || !Number.isFinite(o?.time)) continue;
      out.push({ radiant: p.radiant, from: o.time, to: left.get(o.ehandle) ?? o.time + OBS_LIFETIME, x: o.x, y: o.y });
    }
  }
  return out;
}

/** Observers of one team alive at `time` within WARD_RADIUS of `pt`. */
export function wardsNear(wards, radiant, time, pt) {
  return wards.filter((w) => w.radiant === radiant && w.from <= time && time < w.to
    && Math.hypot(w.x - pt.x, w.y - pt.y) <= WARD_RADIUS).length;
}
