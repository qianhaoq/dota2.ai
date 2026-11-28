/**
 * Shared Dota 2 minimap world bounds used by MomentReplay, MiniMap, and HeroTrackMap.
 *
 * World coordinates run from Radiant's corner (bottom-left: -8600, -8600) to Dire's
 * corner (top-right: +8600, +8600), with the river along x + y = 0.
 */
export const MAP_WORLD_HALF = 8600;
export const MAP_WORLD_MIN = -MAP_WORLD_HALF;
export const MAP_WORLD_MAX = MAP_WORLD_HALF;
export const MAP_WORLD_SIZE = MAP_WORLD_HALF * 2;

export const MAP_BOUNDS = Object.freeze({
  min_x: MAP_WORLD_MIN,
  max_x: MAP_WORLD_MAX,
  min_y: MAP_WORLD_MIN,
  max_y: MAP_WORLD_MAX,
  size: MAP_WORLD_SIZE,
});
