import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  resolveLanes,
  getLaningOpponentIds,
  computeLaneCentroid,
  LANE_CLUSTER_SOURCE,
} from '../../lib/matchReview/laneResolver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/match8985182860.json'), 'utf8')
);

const HERO = {
  LS: 54,
  RUBICK: 86,
  AXE: 2,
  SB: 71,
  WK: 42,
  HOODWINK: 123,
  SVEN: 18,
  MIRANA: 9,
  KOTL: 90,
  NYX: 88,
};

describe('computeLaneCentroid', () => {
  it('returns weighted centroid from lane_pos grid', () => {
    const player = fixture.players.find((p: { hero_id: number }) => p.hero_id === HERO.LS);
    const c = computeLaneCentroid(player.lane_pos);
    expect(c).not.toBeNull();
    expect(c!.samples).toBeGreaterThan(0);
    expect(c!.x).toBeGreaterThan(150);
    expect(c!.y).toBeLessThan(110);
  });
});

describe('resolveLanes — gold sample 8985182860', () => {
  const resolved = resolveLanes(fixture.players);

  it('marks source as lane_pos_cluster', () => {
    expect(resolved.source).toBe(LANE_CLUSTER_SOURCE);
    expect(resolved.players.every((p) => p.source === LANE_CLUSTER_SOURCE)).toBe(true);
  });

  it('clusters tri lane: Radiant LS+Rubick vs Dire Axe; SB nearby', () => {
    const ls = resolved.players.find((p) => p.heroId === HERO.LS)!;
    const rubick = resolved.players.find((p) => p.heroId === HERO.RUBICK)!;
    const axe = resolved.players.find((p) => p.heroId === HERO.AXE)!;
    const sb = resolved.players.find((p) => p.heroId === HERO.SB)!;

    expect(ls.clusterId).toBe(rubick.clusterId);
    expect(axe.clusterId).toBe(ls.clusterId);
    expect(sb.clusterId).toBe(ls.clusterId);

    expect(getLaningOpponentIds(resolved, HERO.LS)).toEqual([HERO.AXE]);
    expect(ls.nearby.map((n) => n.heroId)).toContain(HERO.SB);
    expect(getLaningOpponentIds(resolved, HERO.LS)).not.toContain(HERO.SVEN);
  });

  it('clusters safe lane: WK+Hoodwink vs Sven+Mirana', () => {
    const wk = resolved.players.find((p) => p.heroId === HERO.WK)!;
    const hoodwink = resolved.players.find((p) => p.heroId === HERO.HOODWINK)!;
    const sven = resolved.players.find((p) => p.heroId === HERO.SVEN)!;
    const mirana = resolved.players.find((p) => p.heroId === HERO.MIRANA)!;

    expect(wk.clusterId).toBe(hoodwink.clusterId);
    expect(sven.clusterId).toBe(wk.clusterId);
    expect(mirana.clusterId).toBe(wk.clusterId);

    const wkOpponents = getLaningOpponentIds(resolved, HERO.WK);
    expect(wkOpponents).toContain(HERO.SVEN);
    expect(wkOpponents).toContain(HERO.MIRANA);
  });

  it('clusters mid: KotL vs Nyx', () => {
    const kotl = resolved.players.find((p) => p.heroId === HERO.KOTL)!;
    const nyx = resolved.players.find((p) => p.heroId === HERO.NYX)!;

    expect(kotl.clusterId).toBe(nyx.clusterId);
    expect(getLaningOpponentIds(resolved, HERO.KOTL)).toEqual([HERO.NYX]);
  });

  it('produces three lane groups', () => {
    expect(resolved.lanes).toHaveLength(3);
    const allHeroes = resolved.lanes.flatMap((l) => [...l.radiantHeroIds, ...l.direHeroIds]);
    expect(allHeroes).toHaveLength(10);
  });
});
