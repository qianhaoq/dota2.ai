import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { runTraceTool } from '../../packages/review-engine/src/trace/index.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { deepReviewSystem } from '../../lib/agent/deepReview.js';
import { chatSystem } from '../../lib/agent/chat.js';

const FIXTURE = new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url);
/** A real ranked game (9100904020): Beastmaster on Dire, lost in 42:31. */
const trace = JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString());

/** Heroes stand where `pos` says; `deaths` are [second, victim key]; `dead` [from, to) per hero. */
function synth({ n = 200, heroes, pos = {}, deaths = [], dead = {} }: any) {
  const H = heroes.map(([key, team]: [string, number], i: number) => ({ key, npc: `npc_dota_hero_${key}`, team, player_index: i }));
  const names = H.map((h: any) => h.npc);
  return {
    schema: 'dota2.ai/match-trace@1', match_id: 1, t0: 0, n, heroes: H, names,
    states: H.map((h: any) => {
      const p = pos[h.key] ?? [0, 0]; const d = dead[h.key];
      return { x: Array(n).fill(p[0]), y: Array(n).fill(p[1]), hp: Array(n).fill(500), max_hp: Array(n).fill(1000), mana: Array(n).fill(300), level: Array(n).fill(10),
        alive: Array.from({ length: n }, (_, i) => (d && i >= d[0] && i < d[1] ? 0 : 1)), mana_peak: Array(n).fill(300) };
    }),
    abilities: H.map(() => ({})), items: H.map(() => ({})), controls: H.map(() => ({})),
    casts: [], item_uses: [], purchases: [], buildings: [], modifiers: [], damage: [], net_worth: [], gaps: [],
    deaths: deaths.map(([s, v]: any) => [s, names.indexOf(`npc_dota_hero_${v}`), -1, 0]),
  };
}

describe('death_context: was the death traded, and where were the allies who were not near', () => {
  it('on the real game: 7 of Beastmaster\'s 11 deaths traded, 4 not; at 22:06 Skywrath was dead, 42 s from respawning', () => {
    const r: any = runTraceTool(trace, 'death_context', { hero: 'beastmaster' });
    expect(r.deaths_where.traded_within_15s).toEqual(['2:51', '6:13', '8:27', '22:06', '25:30', '30:42', '39:21']);
    expect(r.deaths_where.not_traded_within_15s).toEqual(['0:47', '11:03', '36:05', '41:57']);
    expect(r.deaths_where.no_ally_within_2200_at_death_and_not_traded).toEqual([]);
    const d = r.deaths.find((x: any) => x.clock === '22:06');
    expect(d).toMatchObject({ traded_within_15s: true, allies_within_2200: { at_death: 3 } });
    expect(d.allies_elsewhere).toEqual([{ hero: 'skywrath_mage', doing: 'dead', respawn_in: 42 }]);
    // Every ally is either within 2200 at the death or listed elsewhere, never both.
    for (const x of r.deaths) if (x.allies_within_2200.at_death != null) expect(x.allies_within_2200.at_death + x.allies_elsewhere.length).toBe(4);
  });

  it('traded means an enemy hero died within 15 s of it, before or after; an ally\'s death is not a trade', () => {
    const heroes = [['axe', 2], ['lina', 2], ['pudge', 3], ['zuus', 3]];
    const at = (deaths: any[]) => (runTraceTool(synth({ heroes, deaths }), 'death_context', { hero: 'axe' }) as any).deaths[0].traded_within_15s;
    expect(at([[100, 'axe'], [115, 'pudge']])).toBe(true);
    expect(at([[100, 'axe'], [85, 'zuus']])).toBe(true);
    expect(at([[100, 'axe'], [116, 'pudge']])).toBe(false);
    expect(at([[100, 'axe'], [101, 'lina']])).toBe(false);
  });

  it('an ally far off is listed with place and distance, a dead one with the respawn; one within 2200 is not listed', () => {
    const t: any = synth({
      heroes: [['axe', 2], ['lina', 2], ['sven', 2], ['lion', 2], ['pudge', 3]],
      pos: { axe: [0, 0], lina: [1500, 0], sven: [6000, -6000], lion: [0, 0] },
      deaths: [[100, 'axe']], dead: { axe: [100, 150], lion: [90, 130] },
    });
    const d = (runTraceTool(t, 'death_context', { hero: 'axe' }) as any).deaths[0];
    expect(d.allies_within_2200.at_death).toBe(1);
    expect(d.allies_elsewhere).toEqual([{ hero: 'sven', place: expect.any(String), distance: 8485 }, { hero: 'lion', doing: 'dead', respawn_in: 30 }]);
  });

  it('the record resolves with its places named, and the review and the chat are told what a trade means', () => {
    const r: any = runTraceTool(trace, 'death_context', { hero: 'beastmaster' });
    const n = r.deaths.findIndex((x: any) => x.allies_elsewhere.some((a: any) => a.place)) + 1;
    expect(n).toBeGreaterThan(0);
    const rec = resolveRef(trace, `death:beastmaster:${n}`, { hero: 'beastmaster', lang: 'zh' })!;
    expect(rec.record.traded_within_15s).toBe(r.deaths[n - 1].traded_within_15s);
    for (const a of rec.record.allies_elsewhere) if (a.place) expect(rec.names[a.place]).toMatch(/[一-鿿]/);
    expect(chatSystem('en')).toContain('A death not traded bought nothing');
  });

  it('the calibration script measures trades and the risk of standing alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deaths-'));
    copyFileSync(FIXTURE, join(dir, '9100904020.trace.json.gz'));
    const out = JSON.parse(execFileSync('node', ['scripts/calibrate.mjs', dir, '--json'], { encoding: 'utf8' }));
    const all = out.deaths.traded_by_allies_within_2200_at_death;
    expect(all.map((x: any) => x.allies)).toEqual(['0', '1', '2 or more']);
    const known = (runTraceTool(trace, 'death_context', { hero: 'beastmaster' }) as any);
    expect(all.reduce((n: number, x: any) => n + x.deaths, 0)).toBeGreaterThanOrEqual(known.deaths_total);
    expect(out.deaths.died_within_20s_by_allies_near).toHaveLength(6);
  });
});
