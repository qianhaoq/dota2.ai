import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createTraceBuilder, runTraceTool, observersNear, boughtBackAfter, WARD_NEAR } from '../../packages/review-engine/src/trace/index.js';
import { buildTraceFromExtract } from '../../lib/agent/traceBuild.js';
import { fightReport, gapsOf } from '../../lib/agent/fightReport.js';
import { deepReviewSystem, verifyReview } from '../../lib/agent/deepReview.js';
import { chatSystem } from '../../lib/agent/chat.js';

/** A real ranked game (9100904020), its trace built before wards and buybacks were read. */
const old = JSON.parse(gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url))).toString());

const state = (t: number, hero: string, team: number, slot: number, extra: any = {}) => ({ entity_kind: 'real_hero', t, hero, team, player_index: slot, x: 0, y: 0, hp: 500, max_hp: 600, mana: 100, level: 10, life_state: 0, abilities: [], items: [], controls: {}, ...extra });
/** Axe (Radiant, slot 0) and Lina (Dire, slot 5), 200 s; Lina dead from 100 to 150, back early by a buyback at 120. */
function built({ wards = null as any[] | null, buyback = true } = {}) {
  const b = createTraceBuilder();
  for (let t = 0; t < 200; t += 1) {
    b.addState(state(t, 'axe', 2, 0));
    b.addState(state(t, 'lina', 3, 5, { life_state: t >= 100 && t < 120 ? 2 : 0 }));
  }
  b.addEvent({ type: 'DOTA_COMBATLOG_DEATH', t: 100, attacker: 'npc_dota_hero_axe', attacker_hero: true, attacker_illusion: false, target: 'npc_dota_hero_lina', target_hero: true, target_illusion: false }, 0);
  if (buyback) {
    b.addEvent({ type: 'DOTA_COMBATLOG_BUYBACK', t: 120, value: 5, value_name: 'npc_dota_hero_sniper', attacker: 'dota_unknown', target: 'dota_unknown' }, 1);
    // A slot that is no hero of this match is dropped.
    b.addEvent({ type: 'DOTA_COMBATLOG_BUYBACK', t: 130, value: 7 }, 2);
  }
  for (const w of wards ?? []) b.addWard(w);
  return b.finish({ match_id: 1 });
}

describe('the trace reads wards and buybacks from the extract', () => {
  it('a buyback\'s value is the player slot: it is matched to the hero with that slot, never to the name the log puts beside it', () => {
    const t: any = built();
    expect(t.buybacks).toEqual([[120, t.heroes.findIndex((h: any) => h.key === 'lina')]]);
    expect(built({ buyback: false }).buybacks).toEqual([]);
  });

  it('wards become [placed, ended, team, o/s, x, y]; one standing when the replay began has no placing; no ward file, no list', () => {
    const t: any = built({ wards: [
      { entity_id: 'a', event: 'present', kind: 'observer', t: 0.1, team: 2, x: -730.6, y: -597.2 },
      { entity_id: 'b', event: 'created', kind: 'sentry', t: 15.56, team: 3, x: 100, y: 100 },
      { entity_id: 'b', event: 'deleted', kind: 'sentry', t: 75.63, team: 3, x: 100, y: 100 },
      { entity_id: 'c', event: 'created', kind: 'observer', t: 90, team: 3, x: 0, y: 1500 },
      // A deletion of a ward never seen placed, and a row with no team, are not wards.
      { entity_id: 'z', event: 'deleted', kind: 'observer', t: 95, team: 2, x: 0, y: 0 },
      { entity_id: 'y', event: 'created', kind: 'observer', t: 96, team: 0, x: 0, y: 0 },
    ] });
    expect(t.wards).toEqual([[null, null, 2, 'o', -731, -597], [15.6, 75.6, 3, 's', 100, 100], [90, null, 3, 'o', 0, 1500]]);
    expect(t.gaps.find((g: any) => g.topic === 'vision').reason).toBe('ward_placements_only_not_what_each_side_saw');
    const none: any = built();
    expect(none).not.toHaveProperty('wards');
    expect(none.gaps.find((g: any) => g.topic === 'vision').reason).toBe('no_fog_of_war_in_trace');
  });

  it('the extract reader streams wards-native.jsonl when the extractor wrote one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'extract-'));
    mkdirSync(join(dir, 'trace'));
    writeFileSync(join(dir, 'trace', 'states.jsonl'), [0, 1, 2].map((t) => JSON.stringify(state(t, 'axe', 2, 0))).join('\n'));
    writeFileSync(join(dir, 'trace', 'events.jsonl'), '');
    expect(await buildTraceFromExtract(dir, { match_id: 2 })).not.toHaveProperty('wards');
    writeFileSync(join(dir, 'trace', 'wards-native.jsonl'), JSON.stringify({ entity_id: 'a', event: 'created', kind: 'observer', t: 1, team: 2, x: 5, y: 5 }));
    expect((await buildTraceFromExtract(dir, { match_id: 2 }) as any).wards).toEqual([[1, null, 2, 'o', 5, 5]]);
  });
});

describe('what the tools say with them, and without', () => {
  it('observers near a spot are counted while standing and within 1600; a trace without wards says null', () => {
    const t: any = built({ wards: [
      { entity_id: 'a', event: 'created', kind: 'observer', t: 10, team: 2, x: 0, y: 1500 },
      { entity_id: 'b', event: 'created', kind: 'observer', t: 10, team: 3, x: 0, y: 1700 },
      { entity_id: 'c', event: 'created', kind: 'sentry', t: 10, team: 3, x: 0, y: 100 },
      { entity_id: 'd', event: 'created', kind: 'observer', t: 10, team: 3, x: 0, y: 200 },
      { entity_id: 'd', event: 'deleted', kind: 'observer', t: 50, team: 3, x: 0, y: 200 },
    ] });
    expect(WARD_NEAR).toBe(1600);
    expect(observersNear(t, { x: 0, y: 0 }, 40)).toEqual({ 2: 1, 3: 1 });
    expect(observersNear(t, { x: 0, y: 0 }, 60)).toEqual({ 2: 1, 3: 0 });
    expect(observersNear(t, { x: 0, y: 0 }, 5)).toEqual({ 2: 0, 3: 0 });
    expect(observersNear(old, { x: 0, y: 0 }, 60)).toBeNull();
  });

  it('death_context: each death\'s observers and buyback; on a trace without them, null — and its counts list nothing', () => {
    const t: any = built({ wards: [{ entity_id: 'a', event: 'created', kind: 'observer', t: 10, team: 2, x: 0, y: 1000 }] });
    const lina: any = runTraceTool(t, 'death_context', { hero: 'lina' });
    expect(lina.deaths[0]).toMatchObject({ observers_within_1600: { my_team: 0, enemy: 1 }, bought_back: '2:00' });
    expect(lina.deaths_where).toMatchObject({ no_own_observer_within_1600: ['1:40'], enemy_observer_within_1600: ['1:40'], bought_back: ['1:40'] });
    expect(boughtBackAfter(t, t.heroes.findIndex((h: any) => h.key === 'lina'), 100)).toBe(120);
    const r: any = runTraceTool(old, 'death_context', { hero: 'beastmaster' });
    expect(r.deaths.every((d: any) => d.observers_within_1600 === null && d.bought_back === null)).toBe(true);
    expect(r.deaths_where).toMatchObject({ no_own_observer_within_1600: [], enemy_observer_within_1600: [], bought_back: [] });
  });

  it('a buyback belongs to one death: never to an earlier one past which the hero died again (review of #305)', () => {
    const t: any = built({ buyback: false });
    const lina = t.heroes.findIndex((h: any) => h.key === 'lina');
    // Died at 20, back at 30 by the clock, died again at 30.3, bought back at 30.7.
    t.states[lina].alive = t.states[lina].alive.map((_: number, i: number) => (i >= 20 && i < 30 ? 0 : 1));
    t.deaths = [[20, t.names.indexOf('npc_dota_hero_lina'), -1, 0], [30.3, t.names.indexOf('npc_dota_hero_lina'), -1, 1]];
    t.buybacks = [[30.7, lina]];
    expect(boughtBackAfter(t, lina, 20)).toBe(false);
    expect(boughtBackAfter(t, lina, 30.3)).toBe(30.7);
  });

  it('fight_report gives each side\'s observers near a fight, null without wards; the gaps say what the trace knows', () => {
    expect((fightReport(old, { hero: 'beastmaster' }) as any).fights[0].my_team.observers_within_1600_of_the_fight).toBeNull();
    const oldGaps = gapsOf(old).map((g: any) => g.topic);
    expect(oldGaps).toEqual(expect.arrayContaining(['vision', 'buyback']));
    const t: any = built({ wards: [] });
    t.wards = [[0, null, 2, 'o', 0, 0]];
    const gaps = gapsOf(t);
    expect(gaps.map((g: any) => g.topic)).not.toContain('buyback');
    expect(gaps.find((g: any) => g.topic === 'vision')?.reason).toMatch(/ward placements are in the trace, not what each side saw/);
  });

  it('a measure in a summary\'s field name backs the number: "within 15 s" citing deaths:<hero> (a real review had one refused)', () => {
    const record = runTraceTool(old, 'death_context', { hero: 'beastmaster' });
    const ev = (fact: string) => verifyReview({ verdict: 'v', mainline: [], findings: [], game_plan: { course: 'c', evidence: [{ refs: ['deaths:beastmaster'], fact }] } }, [record]).problems.filter((p: any) => p.where === 'plan_evidence');
    expect(ev('11 次阵亡里 0:47 那次 15 秒内没有换到人。')).toEqual([]);
    // A span no field states is still refused.
    expect(ev('11 次阵亡里 0:47 那次 17 秒内没有换到人。')).not.toEqual([]);
    // Who was near is no longer a field (owner, 2026-11-27): "no ally within 2200" is backed by nothing.
    expect(ev('11 次阵亡里只有 2:51 那次身边 2200 码内没有队友。')).not.toEqual([]);
  });

  it('the review and the chat are told what a ward near a spot does and does not show', () => {
    expect(deepReviewSystem('en')).toContain('observers_within_1600');
    expect(deepReviewSystem('en')).toContain('show placement, never who saw whom');
    expect(chatSystem('en')).toContain('Asked about wards or vision');
  });

  it('the calibration script splits deaths and moments by observers near, only from traces with a ward list', () => {
    const calibrate = (trace: any) => {
      const dir = mkdtempSync(join(tmpdir(), 'wards-'));
      writeFileSync(join(dir, '1.trace.json.gz'), gzipSync(JSON.stringify(trace)));
      return JSON.parse(execFileSync('node', ['scripts/calibrate.mjs', dir, '--json'], { encoding: 'utf8' })).wards;
    };
    // Without a ward list: no game counted and nothing in any row (unknown, not "no observer").
    const none = calibrate(old);
    expect(none.games_with_wards).toBe(0);
    for (const x of [...none.deaths_traded, ...none.died_within_20s]) expect(x.deaths ?? x.moments).toBe(0);
    // An empty list is known: every death has no observer near.
    const empty = calibrate({ ...old, wards: [] });
    const deaths = empty.deaths_traded.find((x: any) => x.case === 'no observer of either side within 1600').deaths;
    expect(empty.games_with_wards).toBe(1);
    expect(deaths).toBeGreaterThan(0);
    expect(empty.deaths_traded.find((x: any) => x.case === 'enemy observer within 1600').deaths).toBe(0);
    // A Dire observer standing all game at the first Radiant hero's first death: that death counts under the enemy's.
    const dc: any = runTraceTool(old, 'death_context', { hero: old.heroes.find((h: any) => h.team === 2).key });
    const at = dc.deaths.find((d: any) => d.at != null).at;
    const one = calibrate({ ...old, wards: [[null, null, 3, 'o', at.x, at.y]] });
    expect(one.deaths_traded.find((x: any) => x.case === 'enemy observer within 1600').deaths).toBeGreaterThan(0);
    expect(one.died_within_20s.some((x: any) => x.case === 'enemy observer within 1600' && x.moments > 0)).toBe(true);
  // Runs scripts/calibrate.mjs twice in child processes: 2.5–6 s on CI depending on what runs beside it (#471).
  }, 30000);
});
