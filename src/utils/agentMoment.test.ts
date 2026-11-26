import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MOMENT_CASTS, MOMENT_FOCUS, MOMENT_NEAR, momentFrames } from '../../lib/agent/moment.js';
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
  it('the abilities cast in the window, by the player and the heroes near them, in order — with the hero they were cast on', () => {
    const m: any = momentFrames(trace, { hero: 'beastmaster', t: 1825 });
    expect(m.casts).toHaveLength(24);
    expect(m.casts.map((c: any) => c.t)).toEqual([...m.casts.map((c: any) => c.t)].sort((a, b) => a - b));
    expect(m.casts.every((c: any) => c.t >= m.from && c.t <= m.to + 1)).toBe(true);
    // The Roar on Necrophos, a tenth of a second kept; an ability with no hero target says none.
    expect(m.casts).toContainEqual({ t: 1825.6, hero: 'beastmaster', ability: 'beastmaster_primal_roar', target: 'necrolyte' });
    expect(m.casts).toContainEqual({ t: 1819.7, hero: 'sven', ability: 'sven_gods_strength', target: null });
    // Only heroes: nothing cast by a summoned unit, and nobody who is not in this game.
    const keys = new Set(m.heroes.map((h: any) => h.hero));
    expect(m.casts.every((c: any) => keys.has(c.hero) && (c.target === null || keys.has(c.target)))).toBe(true);
  });

  it('a hero who was never near the player in the window is not in the list of casts; a long fight is cut at the cap', () => {
    // Put Sven far away for the whole window: his God's Strength at 30:19 is his own business.
    const far = load(); const sven = far.heroes.findIndex((h: any) => h.key === 'sven');
    for (let s = 1813; s <= 1831; s += 1) { far.states[sven].x[s - far.t0] = 7000; far.states[sven].y[s - far.t0] = 7000; }
    const m: any = momentFrames(far, { hero: 'beastmaster', t: 1825 });
    expect(m.casts.some((c: any) => c.hero === 'sven')).toBe(false);
    expect(m.casts.length).toBeLessThan(24);
    expect(m.away).toContain('sven');
    // Many casts: no more than the cap, the earliest kept.
    const busy = load(); const roar = busy.casts.find((c: any) => busy.names[c[2]] === 'beastmaster_primal_roar' && Math.abs(c[0] - 1825.6) < 0.1);
    busy.casts = [...busy.casts, ...Array.from({ length: 60 }, (_, k) => [1814 + k * 0.01, roar[1], roar[2], roar[3], 0])].sort((a: any, b: any) => a[0] - b[0]);
    const many: any = momentFrames(busy, { hero: 'beastmaster', t: 1825 });
    expect(many.casts).toHaveLength(MOMENT_CASTS);
    expect(many.casts.at(-1).t).toBeLessThan(1816);
  });

  it('wards standing inside the square during the window, by whose they were; one gone before or placed after is not there', () => {
    // The committed trace was built before wards were kept: not known, which is not "no wards".
    expect((momentFrames(trace, { hero: 'beastmaster', t: 1825 }) as any).wards).toBeNull();
    const t = load();
    t.wards = [
      [1700, 1900, 3, 'o', -500, -500],     // Dire's (the player's) observer, standing all window
      [1600, 1820, 2, 's', -1000, -1000],   // Radiant's sentry, gone at 30:20: standing at the start of the window
      [1600, 1813, 2, 'o', -600, -600],     // gone the second the window starts
      [1832, 2100, 2, 'o', -700, -700],     // placed after the window
      [null, 1900, 2, 'o', -800, -800],     // placing not recorded: counted until it is gone
      [1700, null, 3, 's', -900, -900],     // never seen to go
      [1700, 1900, 3, 'o', 7000, 7000],     // standing, but outside the square shown
    ];
    const m: any = momentFrames(t, { hero: 'beastmaster', t: 1825 });
    expect(m.wards).toEqual([
      { x: -500, y: -500, side: 'mine', kind: 'observer', from: 1700, to: 1900 },
      { x: -1000, y: -1000, side: 'enemy', kind: 'sentry', from: 1600, to: 1820 },
      { x: -800, y: -800, side: 'enemy', kind: 'observer', from: null, to: 1900 },
      { x: -900, y: -900, side: 'mine', kind: 'sentry', from: 1700, to: null },
    ]);
    // An empty list is known: no wards.
    expect((momentFrames({ ...t, wards: [] }, { hero: 'beastmaster', t: 1825 }) as any).wards).toEqual([]);
    // No list of casts either: not known.
    expect((momentFrames({ ...t, casts: undefined }, { hero: 'beastmaster', t: 1825 }) as any).casts).toBeNull();
  });

  it('replaying a fight span (to) covers the full fight through to + 6s and focuses on the fight even when the player was farming or dead across the map', () => {
    // Turning fight in 9100904020 runs from 1826.5 to 1857.2: passing `to` keeps frames through ceil(to) + 6.
    const full: any = momentFrames(trace, { hero: 'beastmaster', t: 1826.5, to: 1857.2 });
    expect(full.from).toBe(1815);
    expect(full.to).toBe(1864);
    expect(full.frames.at(-1).t).toBe(1864);
    expect(full.deaths.length).toBeGreaterThan(2);

    // Put Beastmaster in Dire fountain (dead) for the whole window, with a fountain cast: the camera and casts
    // still follow the combatants in river_mid rather than the absent player.
    const absent = load();
    const me = absent.heroes.findIndex((h: any) => h.key === 'beastmaster');
    absent.deaths = absent.deaths.filter((d: any) => absent.names[d[1]] !== 'npc_dota_hero_beastmaster');
    for (let s = 1810; s <= 1870; s += 1) {
      absent.states[me].x[s - absent.t0] = 6800;
      absent.states[me].y[s - absent.t0] = 6200;
      absent.states[me].alive[s - absent.t0] = 0;
    }
    const offFight: any = momentFrames(absent, { hero: 'beastmaster', t: 1826.5, to: 1857.2 });
    const inside = (p: number[]) => p[0] >= offFight.box.x && p[0] <= offFight.box.x + offFight.box.size && p[1] >= offFight.box.y && p[1] <= offFight.box.y + offFight.box.size;
    // Combatants in river_mid are inside the box; Beastmaster in Dire base is outside and marked away.
    const atStart = offFight.frames.find((f: any) => f.t === 1826).at;
    expect(inside(atStart[index(offFight, 'necrolyte')])).toBe(true);
    expect(inside(atStart[index(offFight, 'sven')])).toBe(true);
    expect(inside(atStart[index(offFight, 'beastmaster')])).toBe(false);
    expect(offFight.away).toContain('beastmaster');
    expect(offFight.place).toBe('river_mid');
    expect(offFight.casts.some((c: any) => c.hero === 'sven' && c.ability === 'sven_gods_strength')).toBe(true);
    expect(offFight.casts.some((c: any) => c.hero === 'beastmaster')).toBe(false);

    // Invalid spans (to < t) are refused cleanly.
    expect(momentFrames(trace, { hero: 'beastmaster', t: 1848, to: 1826 })).toEqual({ error: 'no_such_time' });
  });
});
