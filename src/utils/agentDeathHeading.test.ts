import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { runTraceTool } from '../../packages/review-engine/src/trace/index.js';
import { ownFountain } from '../../packages/review-engine/src/trace/tools.js';
import { linkHeroNames } from '../../packages/review-engine/src/trace/build.js';

const FIXTURE = new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url);
const real = linkHeroNames(JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString()));

const FOUNTAIN = [-7000, -6500];
/**
 * One Radiant hero (and one enemy far away) over `n` seconds. `path(i)` is where the hero stands at second i;
 * the hero dies at each second in `deaths` and is dead for `deadFor` seconds, reappearing in the fountain
 * unless `respawn` is false (then the trace ends with the hero dead: no respawn is ever sampled).
 */
function synth({ n = 300, path, deaths, deadFor = 20, respawn = true }: { n?: number; path: (i: number) => [number, number]; deaths: number[]; deadFor?: number; respawn?: boolean }) {
  const H = [{ key: 'tidehunter', npc: 'npc_dota_hero_tidehunter', team: 2, player_index: 0 }, { key: 'ursa', npc: 'npc_dota_hero_ursa', team: 3, player_index: 5 }];
  const names = H.map((h) => h.npc);
  const deadAt = (i: number) => deaths.some((d) => i > d && (respawn ? i <= d + deadFor : true));
  const me = { x: [] as (number | null)[], y: [] as (number | null)[], hp: [] as number[], max_hp: [] as number[], mana: [] as number[], level: [] as number[], alive: [] as number[], mana_peak: [] as number[] };
  for (let i = 0; i < n; i += 1) {
    const dead = deadAt(i);
    // Alive again: back in the fountain for a few seconds, then on the path.
    const justBack = !dead && deaths.some((d) => i > d + deadFor && i <= d + deadFor + 3);
    const [x, y] = dead ? FOUNTAIN : justBack ? FOUNTAIN : path(i);
    me.x.push(x); me.y.push(y); me.hp.push(800); me.max_hp.push(1000); me.mana.push(300); me.level.push(10); me.alive.push(dead ? 0 : 1); me.mana_peak.push(300);
  }
  const far = { x: Array(n).fill(7000), y: Array(n).fill(6500), hp: Array(n).fill(900), max_hp: Array(n).fill(1000), mana: Array(n).fill(300), level: Array(n).fill(10), alive: Array(n).fill(1), mana_peak: Array(n).fill(300) };
  return {
    schema: 'dota2.ai/match-trace@1', match_id: 1, t0: 0, n, heroes: H, names,
    states: [me, far], abilities: H.map(() => ({})), items: H.map(() => ({})), controls: H.map(() => ({})),
    casts: [], item_uses: [], purchases: [], buildings: [], modifiers: [], damage: [], net_worth: [], gaps: [],
    deaths: deaths.map((s) => [s, 0, 1, 0]),
  };
}

describe('death_context: what the hero was doing and which way they were heading', () => {
  it('a hero walking home before the death: the distance to the fountain falls, and the window says by how much', () => {
    // Second death at 200: from 188 to 199 the hero walks from (2000, 0) toward the fountain, 200 units a second.
    const t: any = synth({ deaths: [100, 200], path: (i) => (i >= 188 && i < 200 ? [2000 - (i - 188) * 200, 0] : [2000, 0]) });
    expect(ownFountain(t, 0, 0)).toEqual({ x: FOUNTAIN[0], y: FOUNTAIN[1] });
    const d = runTraceTool(t, 'death_context', { hero: 'tidehunter' }).deaths[1];
    const first = d.snapshots[0].me; const last = d.snapshots.at(-1).me;
    expect(first.to_own_fountain).toBe(Math.round(Math.hypot(2000 + 7000, 6500)));
    expect(last.to_own_fountain).toBeLessThan(first.to_own_fountain);
    expect(d.moved_toward_own_fountain).toBe(first.to_own_fountain - last.to_own_fountain);
    expect(d.moved_toward_own_fountain).toBeGreaterThan(1500);
    expect(first.doing).toBe('none_of_these');
    // The summary lists it as a death heading home; the first death (standing still) is in neither list.
    const where = runTraceTool(t, 'death_context', { hero: 'tidehunter' }).deaths_where;
    expect(where.heading_home_1500_or_more).toEqual([d.clock]);
    expect(where.heading_away_1500_or_more).toEqual([]);
    expect(where.farming_at_window_start).toEqual([]);
  });

  it('walking away from home is negative', () => {
    const t: any = synth({ deaths: [100, 200], path: (i) => (i >= 188 && i < 200 ? [-2000 + (i - 188) * 300, 0] : [-2000, 0]) });
    expect(runTraceTool(t, 'death_context', { hero: 'tidehunter' }).deaths[1].moved_toward_own_fountain).toBeLessThan(-1500);
  });

  it('unknown stays unknown: with no respawn ever sampled there is no fountain, no distance and no heading — null, never 0', () => {
    const t: any = synth({ deaths: [200], respawn: false, path: (i) => [2000 - Math.max(0, i - 188) * 200, 0] });
    expect(ownFountain(t, 0, 0)).toBeNull();
    const d = runTraceTool(t, 'death_context', { hero: 'tidehunter' }).deaths[0];
    expect(d.snapshots.every((s: any) => s.me.to_own_fountain === null)).toBe(true);
    expect(d.moved_toward_own_fountain).toBeNull();
    // Unknown heading puts the death in neither list.
    const where = runTraceTool(t, 'death_context', { hero: 'tidehunter' }).deaths_where;
    expect([where.heading_home_1500_or_more, where.heading_away_1500_or_more]).toEqual([[], []]);
  });

  it('a heading needs both ends: a window start with no position sampled leaves it null', () => {
    const t: any = synth({ deaths: [100, 200], path: () => [2000, 0] });
    // Blank the hero's position for the window's first seconds (stateAt looks two seconds either way).
    for (let i = 184; i <= 192; i += 1) { t.states[0].x[i] = null; t.states[0].y[i] = null; }
    const d = runTraceTool(t, 'death_context', { hero: 'tidehunter' }).deaths[1];
    expect(d.snapshots[0].me).toBeNull();
    expect(d.moved_toward_own_fountain).toBeNull();
  });

  it('on the real game every death has the facts, measured from where Beastmaster respawns', () => {
    const r: any = runTraceTool(real, 'death_context', { hero: 'beastmaster' });
    expect(r.deaths).toHaveLength(11);
    for (const d of r.deaths) {
      for (const s of d.snapshots) if (s.me) {
        expect(typeof s.me.doing).toBe('string');
        expect(typeof s.me.to_own_fountain).toBe('number');
      }
      expect(typeof d.moved_toward_own_fountain).toBe('number');
    }
  });
});
