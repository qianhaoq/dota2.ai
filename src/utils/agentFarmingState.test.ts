import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { FARM_NEAR, heroStateAt as stateAtRaw, linkHeroNames } from '../../packages/review-engine/src/trace/index.js';
import { CREEPS_WITH_KILLS, gapsOf } from '../../lib/agent/fightReport.js';

const heroStateAt = (t: any, h: number, s: number) => stateAtRaw(t, h, s) as any;

/**
 * "Farming" in what a hero was doing (#359 item 3): a lane creep or neutral kill within FARM_NEAR seconds. On the
 * committed game the creep rows before 10:00 are a fixture (creeps-9100904020.json.gz).
 */
const fixture = (name: string) => JSON.parse(gunzipSync(readFileSync(new URL(`../../packages/review-engine/test/fixtures/${name}`, import.meta.url))).toString());
const bare = linkHeroNames(fixture('trace-9100904020.json.gz'));
const creeps = fixture('creeps-9100904020.json.gz');
const ix = (npc: string) => bare.names.indexOf(npc);
const trace = { ...bare, creep_kills: creeps.creep_kills.map(([t, npc, kind, lh, nw]: any[]) => [t, ix(npc), kind, lh, nw]) };
const seat = (key: string) => trace.heroes.findIndex((h: any) => h.key === key);

describe('farming, in what the replay shows a hero doing', () => {
  it('a lane creep or neutral kill within 10 s, and nothing above it in the order, is farming', () => {
    expect(FARM_NEAR).toBe(10);
    const pa = seat('phantom_assassin'); const nx = ix('npc_dota_hero_phantom_assassin');
    const times = trace.creep_kills.filter((r: any) => r[1] === nx && ['l', 'n', 'u'].includes(r[2])).map((r: any) => r[0]);
    let farming = 0;
    for (let t = 60; t < 600; t += 1) {
      const s = heroStateAt(trace, pa, t);
      const near = times.some((k: number) => Math.abs(k - t) <= FARM_NEAR);
      if (s.doing === 'farming') { farming += 1; expect([t, near]).toEqual([t, true]); }
      // Alive, near a kill, and nothing that comes first: farming.
      if (near && s.alive && !['trading_damage_with_enemy_heroes', 'hitting_enemy_buildings'].includes(s.doing)) expect([t, s.doing]).toEqual([t, 'farming']);
    }
    // In the lane stage Phantom Assassin farmed most of the time.
    expect(farming).toBeGreaterThan(200);
  });

  it('a trace without creep kills (built before they were kept) never says farming — and never says "not farming" either', () => {
    const pa = seat('phantom_assassin');
    for (let t = 100; t < 600; t += 7) expect(heroStateAt(bare, pa, t).doing).not.toBe('farming');
  });

  it('dead, trading damage and hitting buildings come before farming', () => {
    const pa = seat('phantom_assassin'); const nx = ix('npc_dota_hero_phantom_assassin');
    const kill = trace.creep_kills.find((r: any) => r[1] === nx && r[2] === 'l' && r[0] > 120)[0];
    // Make her dead at that second: dead wins.
    const st = trace.states[pa]; const k = Math.round(kill) - trace.t0;
    const dead = { ...trace, states: trace.states.map((x: any, i: number) => (i === pa ? { ...st, alive: st.alive.map((v: any, j: number) => (Math.abs(j - k) <= 1 ? 0 : v)) } : x)) };
    expect(heroStateAt(dead, pa, kill).doing).toBe('dead');
  });
});

describe('the creeps gap says what is still not shown (Codex on #398)', () => {
  it('with creep kills: farming is shown, the waves are not; without: as before', () => {
    expect(gapsOf(trace).find((g: any) => g.topic === 'creeps')).toEqual({ topic: 'creeps', reason: CREEPS_WITH_KILLS });
    expect(CREEPS_WITH_KILLS).toContain('Where the waves stood');
    expect(CREEPS_WITH_KILLS).not.toContain('not shown —');
    expect(gapsOf(bare).find((g: any) => g.topic === 'creeps')!.reason).toContain('may have been farming');
  });
});
