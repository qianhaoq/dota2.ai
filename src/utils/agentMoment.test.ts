import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MOMENT_FOCUS, MOMENT_NEAR, momentFrames } from '../../lib/agent/moment.js';
import { linkHeroNames } from '../../packages/review-engine/src/trace/index.js';

/** Match 9100904020, Beastmaster on Dire: the committed trace. */
const load = () => linkHeroNames(JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString()));
const trace = load();
const index = (m: any, hero: string) => m.heroes.findIndex((h: any) => h.hero === hero);

describe('a moment on the map', () => {
  it('30:25, the Roar on Necrophos: nineteen seconds of ten heroes, told from the player\'s side', () => {
    const m: any = momentFrames(trace, { hero: 'beastmaster', t: 1825 });
    expect(m).toMatchObject({ t: 1825, clock: '30:25', from: 1813, to: 1831, me: 'beastmaster', place: 'river_mid' });
    expect(m.frames.map((f: any) => f.t)).toEqual(Array.from({ length: 19 }, (_, i) => 1813 + i));
    expect(m.heroes.map((h: any) => `${h.hero}:${h.side}`)).toEqual(['axe:enemy', 'phantom_assassin:enemy', 'necrolyte:enemy', 'venomancer:enemy', 'mirana:enemy', 'sven:ally', 'beastmaster:me', 'undying:ally', 'skywrath_mage:ally', 'dark_willow:ally']);
    const now = m.frames.find((f: any) => f.t === 1825).at;
    // The positions are the trace's own samples of that second.
    expect(now[index(m, 'beastmaster')]).toEqual([-333, -108, 1]);
    expect(now[index(m, 'phantom_assassin')]).toEqual([-1730, -2779, 1]);
    expect(now[index(m, 'necrolyte')]).toEqual([-736, -632, 1]);
    // The two deaths the fight began with are in the window.
    expect(m.deaths).toEqual([{ t: 1826.5, hero: 'necrolyte', killer: 'sven' }, { t: 1828.8, hero: 'venomancer', killer: 'dark_willow' }]);
  });

  it('the square shown is fitted to the seconds around the moment: every hero near the player then is inside it; one who is far is simply outside', () => {
    const m: any = momentFrames(trace, { hero: 'beastmaster', t: 1825 });
    expect(m.box).toEqual({ x: -4461, y: -3279, size: 6903 });
    // Nine seconds later the fight has closed in, and so has the square.
    expect((momentFrames(trace, { hero: 'beastmaster', t: 1834 }) as any).box).toEqual({ x: -3924, y: -3482, size: 4833 });
    const inside = (p: number[]) => p[0] >= m.box.x && p[0] <= m.box.x + m.box.size && p[1] >= m.box.y && p[1] <= m.box.y + m.box.size;
    for (const f of m.frames.filter((x: any) => Math.abs(x.t - m.t) <= MOMENT_FOCUS)) {
      const me = f.at[index(m, 'beastmaster')];
      for (const p of f.at) if (p && Math.hypot(p[0] - me[0], p[1] - me[1]) <= MOMENT_NEAR) expect(inside(p)).toBe(true);
    }
    // Axe arrived by teleport: at the first second he is across the map, outside the square, and not an error.
    expect(m.frames[0].at[index(m, 'axe')]).toEqual([-6281, 5126, 1]);
    expect(inside(m.frames[0].at[index(m, 'axe')])).toBe(false);
    // Everyone came near at some second, so nobody is away, and nothing is unknown.
    expect(m.away).toEqual([]);
    expect(m.not_known).toEqual([]);
  });

  it('a death shows as not alive from the second it happened', () => {
    const m: any = momentFrames(trace, { hero: 'beastmaster', t: 2165 });
    expect(m.deaths.at(-1)).toEqual({ t: 2165.5, hero: 'beastmaster', killer: 'necrolyte' });
    const me = index(m, 'beastmaster');
    expect(m.frames.find((f: any) => f.t === 2165).at[me][2]).toBe(1);
    expect(m.frames.find((f: any) => f.t === 2167).at[me][2]).toBe(0);
  });

  it('the window is cut at the ends of the replay', () => {
    const start: any = momentFrames(trace, { hero: 'beastmaster', t: 0 });
    expect([start.from, start.to, start.frames.length]).toEqual([0, 6, 7]);
    const end: any = momentFrames(trace, { hero: 'beastmaster', t: 2696 });
    expect([end.from, end.to, end.frames.length]).toEqual([2684, 2696, 13]);
  });

  it('a hero or a time the replay does not have is refused, not guessed', () => {
    expect(momentFrames(trace, { hero: 'lina', t: 100 })).toEqual({ error: 'unknown_hero' });
    expect(momentFrames(trace, { hero: 'beastmaster', t: 99999 })).toEqual({ error: 'no_such_time' });
    expect(momentFrames(trace, { hero: 'beastmaster', t: -500 })).toEqual({ error: 'no_such_time' });
    expect(momentFrames(trace, { hero: 'beastmaster', t: Number.NaN })).toEqual({ error: 'no_such_time' });
    expect(momentFrames(null, { hero: 'beastmaster', t: 100 })).toEqual({ error: 'unknown_hero' });
  });

  it('a second without a sample is null, never the nearest one', () => {
    const t = load();
    const pa = t.heroes.findIndex((h: any) => h.key === 'phantom_assassin');
    for (const s of [1820, 1821, 1822]) { t.states[pa].x[s - t.t0] = null; t.states[pa].y[s - t.t0] = null; }
    const m: any = momentFrames(t, { hero: 'beastmaster', t: 1825 });
    const at = (s: number) => m.frames.find((f: any) => f.t === s).at[pa];
    expect([at(1819) != null, at(1820), at(1821), at(1822), at(1823) != null]).toEqual([true, null, null, null, true]);
  });

  it('who was away is said only when the replay has every second of them and of the player', () => {
    // 10:00 in the bottom lane: five heroes are elsewhere for the whole window, and the replay shows it.
    const lane: any = momentFrames(trace, { hero: 'beastmaster', t: 600 });
    expect(lane.away).toEqual(['axe', 'necrolyte', 'mirana', 'sven', 'skywrath_mage']);
    expect(lane.not_known).toEqual([]);
    expect(lane.place).toBe('river_bot_lane');
    // One second of one of them missing: that second may be the one they were near in.
    const t = load();
    const axe = t.heroes.findIndex((h: any) => h.key === 'axe');
    t.states[axe].x[600 - t.t0] = null; t.states[axe].y[600 - t.t0] = null;
    const gap: any = momentFrames(t, { hero: 'beastmaster', t: 600 });
    expect(gap.away).toEqual(['necrolyte', 'mirana', 'sven', 'skywrath_mage']);
    expect(gap.not_known).toEqual(['axe']);
    // A hero seen near at some second is neither, whatever else is missing.
    const t2 = load();
    const pa = t2.heroes.findIndex((h: any) => h.key === 'phantom_assassin');
    for (let s = 1813; s <= 1820; s += 1) { t2.states[pa].x[s - t2.t0] = null; t2.states[pa].y[s - t2.t0] = null; }
    const seen: any = momentFrames(t2, { hero: 'beastmaster', t: 1825 });
    expect([seen.away, seen.not_known]).toEqual([[], []]);
    // With every second of her missing, nothing can be said of her.
    for (let s = 1813; s <= 1831; s += 1) { t2.states[pa].x[s - t2.t0] = null; t2.states[pa].y[s - t2.t0] = null; }
    const blank: any = momentFrames(t2, { hero: 'beastmaster', t: 1825 });
    expect([blank.away, blank.not_known]).toEqual([[], ['phantom_assassin']]);
  });

  it('when the player has no sample in the whole window there is nothing to centre on: the whole map, and nobody is called away', () => {
    const t = load();
    const me = t.heroes.findIndex((h: any) => h.key === 'beastmaster');
    for (let s = 1813; s <= 1831; s += 1) { t.states[me].x[s - t.t0] = null; t.states[me].y[s - t.t0] = null; }
    const m: any = momentFrames(t, { hero: 'beastmaster', t: 1825 });
    expect(m.box).toEqual({ x: -8600, y: -8600, size: 17200 });
    expect(m.away).toEqual([]);
    expect(m.not_known).toHaveLength(9);
    expect(m.not_known).not.toContain('beastmaster');
    expect(m.place).toBeNull();
    expect(m.frames.every((f: any) => f.at[me] === null)).toBe(true);
    // The others' positions are still there.
    expect(m.frames[12].at[t.heroes.findIndex((h: any) => h.key === 'necrolyte')]).toEqual([-736, -632, 1]);
  });
});
