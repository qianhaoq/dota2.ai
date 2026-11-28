import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MAP_BOUNDS, MAP_WORLD_MIN, MAP_WORLD_SIZE } from '../../lib/agent/mapBounds.js';
import {
  TRACK_GRID_SIZE,
  TRACK_MAX_STEP_DIST,
  TRACK_MAX_TIME_GAP,
  heroTrackData,
} from '../../lib/agent/track.js';

const loadRaw = () => JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());

/** Build a compact synthetic trace for testing exact segment breaks, heat cells, deaths, and gaps. */
function makeTrace({
  t0 = 0,
  n = 20,
  heroKey = 'queen_of_pain',
  npc = 'npc_dota_hero_queenofpain',
  x = Array(n).fill(0),
  y = Array(n).fill(0),
  alive = Array(n).fill(1),
  deaths = [] as any[],
} = {}) {
  const names = [npc, 'npc_dota_hero_axe'];
  return {
    schema: 'dota2.ai/match-trace@1',
    match_id: 42,
    t0,
    n,
    heroes: [
      // Deliberately give an unlinked npc (`npc_dota_hero_queen_of_pain`) to verify `linkHeroNames` runs automatically.
      { key: heroKey, npc: `npc_dota_hero_${heroKey}`, team: 2, player_index: 0 },
      { key: 'axe', npc: 'npc_dota_hero_axe', team: 3, player_index: 5 },
    ],
    states: [
      { x, y, alive, hp: Array(n).fill(1000), max_hp: Array(n).fill(1000), mana: Array(n).fill(500), level: Array(n).fill(10) },
      { x: Array(n).fill(2000), y: Array(n).fill(2000), alive: Array(n).fill(1), hp: Array(n).fill(1000), max_hp: Array(n).fill(1000), mana: Array(n).fill(500), level: Array(n).fill(10) },
    ],
    names,
    deaths,
    casts: [],
    item_uses: [],
    purchases: [],
    buildings: [],
    modifiers: [],
    damage: [],
  };
}

describe('heroTrackData (lib/agent/track.js)', () => {
  it('reads a real trace (including linking hero names), breaks segments on deaths and TP jumps, and matches shared map bounds', () => {
    const raw = loadRaw();
    const out: any = heroTrackData(raw, { hero: 'beastmaster' });
    expect(out.error).toBeUndefined();
    expect(out).toMatchObject({
      hero: 'beastmaster',
      side: 'me',
      from: 0,
      to: 2696,
      trace_start: 0,
      duration: 2696,
    });
    expect(out.heroes).toHaveLength(10);
    expect(out.heat.grid_size).toBe(TRACK_GRID_SIZE);
    expect(out.heat.bounds).toEqual(MAP_BOUNDS);
    expect(out.stats.total_seconds).toBe(2697);
    expect(out.stats.alive_sampled_seconds + out.stats.dead_seconds + out.stats.missing_seconds).toBe(out.stats.total_seconds);
    expect(out.stats.alive_sampled_seconds).toBe(2187);
    expect(out.stats.dead_seconds).toBe(510);
    expect(out.stats.missing_seconds).toBe(0);

    // Every heatmap cell sum equals exact alive_sampled_seconds.
    const heatSum = out.heat.cells.reduce((sum: number, c: any) => sum + c.seconds, 0);
    expect(heatSum).toBe(out.stats.alive_sampled_seconds);
    expect(out.heat.max_seconds).toBe(Math.max(...out.heat.cells.map((c: any) => c.seconds)));

    // Every contiguous segment has only consecutive alive points without exceeding TP distance or time gap.
    let totalSegPoints = 0;
    for (const seg of out.segments) {
      expect(seg.points.length).toBeGreaterThanOrEqual(1);
      expect(seg.from).toBe(seg.points[0][0]);
      expect(seg.to).toBe(seg.points.at(-1)[0]);
      totalSegPoints += seg.points.length;
      for (let i = 1; i < seg.points.length; i += 1) {
        const [t0, x0, y0] = seg.points[i - 1];
        const [t1, x1, y1] = seg.points[i];
        expect(t1 - t0).toBeLessThanOrEqual(TRACK_MAX_TIME_GAP);
        expect(Math.hypot(x1 - x0, y1 - y0)).toBeLessThanOrEqual(TRACK_MAX_STEP_DIST);
      }
    }
    expect(totalSegPoints).toBe(out.stats.alive_sampled_seconds);

    // Real TP jumps in 9100904020 (e.g. t=44, 201, 793) are recorded as teleport breaks, never drawn as walking lines.
    expect(out.breaks.some((b: any) => b.reason === 'teleport' && b.to_t === 201)).toBe(true);
    expect(out.breaks.some((b: any) => b.reason === 'dead')).toBe(true);

    // All 11 real deaths of Beastmaster are returned with real coordinates inside MAP_BOUNDS.
    expect(out.deaths).toHaveLength(11);
    for (const d of out.deaths) {
      expect(typeof d.x).toBe('number');
      expect(typeof d.y).toBe('number');
      expect(d.x).toBeGreaterThanOrEqual(MAP_BOUNDS.min_x);
      expect(d.x).toBeLessThanOrEqual(MAP_BOUNDS.max_x);
      expect(d.y).toBeGreaterThanOrEqual(MAP_BOUNDS.min_y);
      expect(d.y).toBeLessThanOrEqual(MAP_BOUNDS.max_y);
    }
  });

  it('respects viewer perspective (me / ally / enemy) and window bounds [from, to]', () => {
    const raw = loadRaw();
    const early: any = heroTrackData(raw, { hero: 'phantom_assassin', viewer: 'beastmaster', from: 0, to: 600 });
    expect(early.side).toBe('enemy');
    expect(early.from).toBe(0);
    expect(early.to).toBe(600);
    expect(early.stats.total_seconds).toBe(601);
    expect(early.heroes.find((h: any) => h.hero === 'beastmaster').side).toBe('me');
    expect(early.heroes.find((h: any) => h.hero === 'sven').side).toBe('ally');
    expect(early.heroes.find((h: any) => h.hero === 'phantom_assassin').side).toBe('enemy');
    expect(early.deaths.every((d: any) => d.t >= 0 && d.t <= 600)).toBe(true);
  });

  it('breaks segments cleanly on dead seconds, null position samples, unknown alive flags, and >2500 unit teleport jumps', () => {
    // 0..2: walking near origin
    // 3..4: dead (alive = 0)
    // 5..6: alive after respawn at Radiant base (-7000, -7000)
    // 7: TP jump > 2500 units to (0, 0) while alive
    // 8: alive walking to (200, 0)
    // 9..10: missing samples (null x/y at 9, null alive at 10)
    // 11..12: alive again at (400, 100) -> (500, 100)
    const x = [0, 200, 400, 400, 400, -7000, -6900, 0, 200, null, 300, 400, 500];
    const y = [0, 0, 0, 0, 0, -7000, -6900, 0, 0, null, 100, 100, 100];
    const alive = [1, 1, 1, 0, 0, 1, 1, 1, 1, 1, null, 1, 1];
    // Include one real death at t=2.6 (victim index 0 = npc_dota_hero_queenofpain, killer index 1 = axe).
    // Note: hero.npc starts unlinked (`npc_dota_hero_queen_of_pain`) — linkHeroNames must link it!
    const trace = makeTrace({ n: 13, x, y, alive, deaths: [[2.6, 0, 1, 0]] });

    const out: any = heroTrackData(trace, { hero: 'queen_of_pain', from: 0, to: 12 });
    expect(out.stats).toEqual({
      total_seconds: 13,
      alive_sampled_seconds: 9,
      dead_seconds: 2,
      missing_seconds: 2,
    });
    expect(out.gaps).toEqual([{ topic: 'samples', reason: 'missing_position_samples', missing_seconds: 2 }]);

    // Expect 4 contiguous segments: [0..2], [5..6], [7..8], [11..12]
    expect(out.segments.map((s: any) => [s.from, s.to, s.points.length])).toEqual([
      [0, 2, 3],
      [5, 6, 2],
      [7, 8, 2],
      [11, 12, 2],
    ]);
    // Expect 3 breaks with exact reasons: dead (2->5), teleport (6->7), missing (8->11)
    expect(out.breaks.map((b: any) => [b.from_t, b.to_t, b.reason])).toEqual([
      [2, 5, 'dead'],
      [6, 7, 'teleport'],
      [8, 11, 'missing'],
    ]);

    // Real death was matched via linkHeroNames and got the real alive position at t=2 (400, 0).
    expect(out.deaths).toEqual([
      { t: 2.6, clock: '0:02', x: 400, y: 0, killer: 'axe', place: 'river_mid' },
    ]);

    // Heatmap counts ONLY the 9 alive sampled seconds and puts (-7000,-7000) in Radiant corner cell.
    expect(out.heat.cells.reduce((s: number, c: any) => s + c.seconds, 0)).toBe(9);
    const expectedRadGx = Math.floor(((-7000 - MAP_WORLD_MIN) / MAP_WORLD_SIZE) * TRACK_GRID_SIZE);
    const expectedRadGy = Math.floor(((-7000 - MAP_WORLD_MIN) / MAP_WORLD_SIZE) * TRACK_GRID_SIZE);
    expect(out.heat.cells).toContainEqual({ gx: expectedRadGx, gy: expectedRadGy, seconds: 2 });
  });

  it('keeps unknown positions as missing_seconds and death x/y as null on a blanked trace (unknown is not false)', () => {
    const n = 15;
    const trace = makeTrace({
      n,
      x: Array(n).fill(null),
      y: Array(n).fill(null),
      alive: Array(n).fill(null),
      deaths: [[5.4, 0, 1, 0]],
    });
    const out: any = heroTrackData(trace, { hero: 'queen_of_pain', from: 0, to: 14 });
    expect(out.segments).toEqual([]);
    expect(out.breaks).toEqual([]);
    expect(out.heat.cells).toEqual([]);
    expect(out.heat.max_seconds).toBe(0);
    expect(out.stats).toEqual({
      total_seconds: 15,
      alive_sampled_seconds: 0,
      dead_seconds: 0,
      missing_seconds: 15,
    });
    expect(out.gaps).toEqual([{ topic: 'samples', reason: 'missing_position_samples', missing_seconds: 15 }]);
    // Death is still reported, with null coordinates rather than fabricated (0, 0).
    expect(out.deaths).toEqual([{ t: 5.4, clock: '0:05', x: null, y: null, killer: 'axe', place: null }]);
  });

  it('refuses unknown heroes, invalid windows (from > to / NaN), and out-of-range times', () => {
    const raw = loadRaw();
    expect(heroTrackData(raw, { hero: 'pudge' })).toEqual({ error: 'unknown_hero' });
    expect(heroTrackData(raw, { hero: 'beastmaster', viewer: 'pudge' })).toEqual({ error: 'unknown_hero' });
    expect(heroTrackData(null, { hero: 'beastmaster' })).toEqual({ error: 'unknown_hero' });
    expect(heroTrackData(raw, { hero: 'beastmaster', from: 1200, to: 600 })).toEqual({ error: 'invalid_window' });
    expect(heroTrackData(raw, { hero: 'beastmaster', from: Number.NaN, to: 600 })).toEqual({ error: 'invalid_window' });
    expect(heroTrackData(raw, { hero: 'beastmaster', from: 5000, to: 6000 })).toEqual({ error: 'no_such_time' });
    expect(heroTrackData(raw, { hero: 'beastmaster', from: 5000 })).toEqual({ error: 'no_such_time' });
    expect(heroTrackData(raw, { hero: 'beastmaster', to: -100 })).toEqual({ error: 'no_such_time' });
    expect(heroTrackData(raw, { hero: 'beastmaster', from: -500, to: -100 })).toEqual({ error: 'no_such_time' });
  });
});
