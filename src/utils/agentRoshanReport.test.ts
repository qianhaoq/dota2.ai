import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { roshanReport, aegisTakes, ROSHAN_TOOL, AEGIS_SECONDS } from '../../lib/agent/roshanReport.js';
import { resolveRef } from '../../lib/agent/evidence.js';
import { KNOWLEDGE_TOOLS } from '../../lib/agent/knowledgeTools.js';
import { deepReviewSystem, reviewToolkit, verifyReview } from '../../lib/agent/deepReview.js';
import { chatSystem } from '../../lib/agent/chat.js';

const FIXTURE = new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url);
/** A real ranked game (9100904020): Beastmaster on Dire, lost in 42:31. Radiant took one Roshan. */
const trace = JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString());

/** Heroes at fixed spots; `items` per hero { key: { held: [[from, to]] } }; `deaths` [second, victim]; `fell` [second, building]. */
function synth({ n = 1000, heroes, pos = {}, items = {}, deaths = [], fell = [] }: any) {
  const H = heroes.map(([key, team]: [string, number], i: number) => ({ key, npc: `npc_dota_hero_${key}`, team, player_index: i }));
  const names = [...H.map((h: any) => h.npc)];
  const id = (name: string) => { let i = names.indexOf(name); if (i < 0) { names.push(name); i = names.length - 1; } return i; };
  const buildings = fell.map(([s, b]: any) => [s, id(`npc_dota_${b}`), 2, 0]);
  return {
    schema: 'dota2.ai/match-trace@1', match_id: 1, t0: 0, n, heroes: H, names,
    states: H.map((h: any) => { const p = pos[h.key] ?? [0, 0]; return { x: Array(n).fill(p[0]), y: Array(n).fill(p[1]), hp: Array(n).fill(500), max_hp: Array(n).fill(1000), mana: Array(n).fill(300), level: Array(n).fill(20), alive: Array(n).fill(1), mana_peak: Array(n).fill(300) }; }),
    abilities: H.map(() => ({})), items: H.map((h: any) => items[h.key] ?? {}), controls: H.map(() => ({})),
    casts: [], item_uses: [], purchases: [], buildings, modifiers: [], damage: [], net_worth: [], gaps: [],
    deaths: deaths.map(([s, v]: any) => [s, names.indexOf(`npc_dota_hero_${v}`), -1, 0]),
  };
}
const heroes = [['axe', 2], ['lina', 2], ['sven', 2], ['pudge', 3], ['zuus', 3]];

describe('a Roshan is an Aegis pickup', () => {
  it('used when the holder dies holding it, expired after 300 s, else the game ended or unknown', () => {
    const t: any = synth({
      heroes,
      items: { axe: { item_aegis: { held: [[100, 250]] } }, pudge: { item_aegis: { held: [[400, 400 + AEGIS_SECONDS]] } }, sven: { item_aegis: { held: [[900, 999]] } } },
      deaths: [[250, 'axe']],
    });
    expect(aegisTakes(t).map((x: any) => [t.heroes[x.holder].key, x.from, x.ended])).toEqual([['axe', 100, 'used'], ['pudge', 400, 'expired'], ['sven', 900, 'game_ended']]);
  });

  it('who stood near the holder, the player\'s place in it, what else dropped, and what each side took in the next 300 s', () => {
    const t: any = synth({
      heroes,
      pos: { axe: [0, 0], lina: [1000, 0], sven: [9000, 9000], pudge: [0, 2000], zuus: [5000, 0] },
      items: { axe: { item_aegis: { held: [[100, 400]] } }, lina: { item_cheese: { held: [[105, 600]] } } },
      fell: [[200, 'badguys_tower2_mid'], [390, 'badguys_tower3_mid'], [401, 'badguys_melee_rax_mid'], [250, 'goodguys_tower1_top']],
    });
    const r: any = roshanReport(t, { hero: 'sven' });
    expect(r).toMatchObject({ roshans_my_team_took: 1, roshans_enemy_took: 0, my_team_aegis_expired: 1, buildings_my_team_took_with_aegis: 2, my_team_roshans_with_no_building_after: 0, roshans_i_was_at: 0 });
    expect(r.takes[0]).toMatchObject({
      ref: 'roshan:sven:1', clock: '1:40', taken_by: 'my_team', aegis_holder: 'axe', taking_side_near: ['lina'], other_side_near: ['pudge'], me: 'not_there',
      also_dropped: [{ item: 'cheese', hero: 'lina' }], aegis: 'expired',
      // 401 is past the 300 s from the pickup at 100.
      buildings_taking_side_took_in_the_next_300s: [{ clock: '3:20', building: 'badguys_tower2_mid' }, { clock: '6:30', building: 'badguys_tower3_mid' }],
      buildings_other_side_took_in_the_next_300s: [{ clock: '4:10', building: 'goodguys_tower1_top' }],
    });
    // From the other side the same take is the enemy's, and the holder's own report says so.
    expect((roshanReport(t, { hero: 'axe' }) as any).takes[0].me).toBe('holder');
    expect((roshanReport(t, { hero: 'pudge' }) as any).takes[0]).toMatchObject({ taken_by: 'enemy', me: 'there' });
  });
});

describe('roshan_report on a real game', () => {
  const r: any = roshanReport(trace, { hero: 'beastmaster' });

  it('Radiant\'s Roshan at 32:18: Phantom Assassin held it with Axe and Mirana near, used it at 36:43, and took the top tier-2', () => {
    expect(r).toMatchObject({ roshans_my_team_took: 0, roshans_enemy_took: 1, buildings_enemy_took_with_aegis: 1 });
    expect(r.takes[0]).toMatchObject({
      clock: '32:18', taken_by: 'enemy', aegis_holder: 'phantom_assassin', taking_side_near: ['axe', 'mirana'], other_side_near: [], me: 'not_there',
      aegis: 'used', aegis_used_at: '36:43', buildings_taking_side_took_in_the_next_300s: [{ clock: '36:22', building: 'badguys_tower2_top' }],
    });
  });

  it('refs resolve with the place named; one take\'s facts need its own ref; the model gets the tool and the rule', () => {
    const one = resolveRef(trace, 'roshan:beastmaster:1', { hero: 'beastmaster', lang: 'zh' })!;
    expect(one.record.aegis_holder).toBe('phantom_assassin');
    expect(one.names.river_top_jungle).toMatch(/[一-鿿]/);
    expect(resolveRef(trace, 'roshan:beastmaster', { hero: 'beastmaster' })?.record).not.toHaveProperty('takes');
    expect(resolveRef(trace, 'roshan:beastmaster:2', { hero: 'beastmaster' })).toBeNull();
    const record = reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh' })!.runTool('roshan_report', { hero: 'beastmaster' });
    const ev = (refs: string[], fact: string) => verifyReview({ verdict: 'v', mainline: [], findings: [], game_plan: { course: 'c', evidence: [{ refs, fact }] } }, [record]).problems.filter((p: any) => p.where === 'plan_evidence');
    expect(ev(['roshan:beastmaster'], '32:18 对面打掉肉山。')).not.toEqual([]);
    expect(ev(['roshan:beastmaster:1'], '32:18 对面打掉肉山，36:43 盾用掉。')).toEqual([]);
    expect(KNOWLEDGE_TOOLS).toContain(ROSHAN_TOOL);
    expect(deepReviewSystem('zh')).toContain('roshan_report for the player');
    expect(deepReviewSystem('zh')).toMatch(/never say a side took no Roshan/);
    expect(chatSystem('zh')).toContain('roshan_report for the player');
  });

  it('the other tools\' Roshan gap points at roshan_report, and the prompt no longer forbids Roshan timings (a real review put a known Roshan among its blind spots)', () => {
    const kit = reviewToolkit({ trace, hero: 'beastmaster', lang: 'zh' })!;
    const gap = kit.runTool('match_overview', {}).gaps.find((g: any) => g.topic === 'roshan');
    expect(gap.reason).toMatch(/roshan_report reads each Roshan from the Aegis pickup/);
    expect(kit.runTool('roshan_report', { hero: 'beastmaster' }).gaps.find((g: any) => g.topic === 'roshan').reason).toMatch(/a take is an Aegis pickup/);
    const system = deepReviewSystem('zh');
    expect(system).toContain('6c. Always call roshan_report for the player');
    expect(system).toContain('Roshan is not a blind spot when it lists a take');
    expect(system).not.toMatch(/Roshan timings/);
    expect(chatSystem('zh')).toContain('Roshan is known from roshan_report');
  });

  it('the calibration script counts the Roshans and what followed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'roshan-'));
    copyFileSync(FIXTURE, join(dir, '9100904020.trace.json.gz'));
    const out = JSON.parse(execFileSync('node', ['scripts/calibrate.mjs', dir, '--json'], { encoding: 'utf8' }));
    expect(out.roshans).toMatchObject({ takes: 1, aegis: { used: 1, expired: 0, game_ended: 0 }, buildings_in_the_next_300s: { taking_side: 1, other_side: 0 }, takes_with_no_building_after: 0 });
  });
});
