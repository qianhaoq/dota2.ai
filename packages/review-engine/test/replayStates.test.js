import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readReplaySupplement, HERO_STATE_CAPS, HERO_STATE_SAMPLING } from '../../../lib/matchReview/replayIngest/extractor.js';

const stateRow = (t, hero, team, extra = {}) => JSON.stringify({entity_kind:'real_hero', t, hero, team, x:100+t, y:-200+t, hp:1000, max_hp:1200, mana:300.4, max_mana:450, level:6, life_state:0, player_index:team===2?0:1, visible_dire:null, visible_radiant:null,
  items:[{name:'item_phase_boots',slot:0,charges:0,cooldown:0},{name:'item_magic_wand',slot:2,charges:5,cooldown:0}],
  abilities:[{name:hero+'_q',slot:0,level:2,cooldown:3.45,charges:0},{name:hero+'_w',slot:1,level:0,cooldown:0,charges:0}],
  ...extra});

/** events.jsonl rows kept by readReviewEvents, plus the anchor kinds. */
const events = [
  {type:'DOTA_COMBATLOG_DEATH',t:600.2,target:'npc_dota_hero_axe',target_hero:true,target_illusion:false,attacker:'npc_dota_hero_invoker',attacker_hero:true,attacker_illusion:false},
  {type:'DOTA_COMBATLOG_TEAM_BUILDING_KILL',t:120.5,target:'npc_dota_badguys_tower1_mid',attacker_team:2},
  {type:'DOTA_COMBATLOG_ITEM',t:900,attacker:'npc_dota_hero_axe',attacker_hero:true,attacker_illusion:false,inflictor:'item_black_king_bar'},
];

/** Dense states rows every 0.25 s from t=0 to 1000 for both heroes. */
function statesLines(withVisibility = true) {
  const lines = [];
  for (let i=0;i<=4000;i++) {
    const t = i*0.25;
    lines.push(stateRow(t,'axe',2));
    lines.push(stateRow(t,'invoker',3,withVisibility && i===1200 ? {visible_dire:true,visible_radiant:true}:{}));
  }
  return lines;
}

async function supplementTo(traceDir, ev) {
  const signal = new AbortController().signal;
  return readReplaySupplement(traceDir, ev.map((e,i)=>({...e,trace_index:i})), signal);
}

describe('bounded hero-state sampling from a states trace', () => {
  let traceDir;
  beforeAll(() => {
    traceDir = mkdtempSync(join(tmpdir(),'replay-states-'));
    writeFileSync(join(traceDir,'states.jsonl'), statesLines().join('\n')+'\n');
  });
  const made = [];
  afterAll(() => { for (const d of [traceDir, ...made]) if (d) rmSync(d, { recursive: true, force: true }); });

  it('keeps ~30 s cadence rows with real game_time, HP/mana and compact cooldowns', async () => {
    const sup = await supplementTo(traceDir, events);
    const hs = sup.heroStates;
    expect(hs).toBeTruthy();
    expect(hs.sampling).toBe(HERO_STATE_SAMPLING);
    expect(hs.visibility).toBe('fields_present');
    const axe300 = hs.samples.filter(s=>s.hero==='axe' && Math.abs(s.t-300)<=HERO_STATE_CAPS.cadence_tolerance_s);
    expect(axe300).toHaveLength(1);
    expect(axe300[0].t).toBe(300);
    expect(axe300[0].hp).toBe(1000);
    expect(axe300[0].mana).toBe(300);
    expect(axe300[0].items).toEqual([{name:'item_phase_boots',slot:0},{name:'item_magic_wand',slot:2,charges:5}]);
    expect(axe300[0].abilities).toEqual([{name:'axe_q',slot:0,level:2,cooldown:3.5}]);
  });

  it('adds dense rows around mixed anchors and never the full trace', async () => {
    const sup = await supplementTo(traceDir, events);
    const hs = sup.heroStates;
    expect(hs.anchors.map(a=>a.kind)).toEqual(['building_kill','hero_death','item_use']);
    const aroundDeath = hs.samples.filter(s=>s.t>=600.2-HERO_STATE_CAPS.window_before_s && s.t<=600.2+HERO_STATE_CAPS.window_after_s);
    const perSecond = new Set(aroundDeath.filter(s=>s.hero==='axe').map(s=>Math.floor(s.t-(600.2-HERO_STATE_CAPS.window_before_s))));
    expect(perSecond.size).toBeGreaterThan(15);
    expect(hs.samples.length).toBeLessThan(4000);
    expect(hs.truncated).toBe(false);
  });

  it('still derives nearest death positions exactly as before', async () => {
    const sup = await supplementTo(traceDir, events);
    expect(sup.positions).toHaveLength(1);
    expect(sup.positions[0]).toMatchObject({death_source_path:'trace/events.jsonl[0]'});
    expect(Math.abs(sup.positions[0].t-600.2)).toBeLessThanOrEqual(0.25);
  });

  it('flags all-null trace visibility instead of inventing fog', async () => {
    const nullDir = mkdtempSync(join(tmpdir(),'replay-states-null-'));
    made.push(nullDir);
    writeFileSync(join(nullDir,'states.jsonl'), statesLines(false).join('\n')+'\n');
    const sup = await supplementTo(nullDir, events);
    expect(sup.heroStates.visibility).toBe('null_in_trace');
  });
});

/** Held Night Stalker trace: local yield check, skipped when the trace is absent. */
const HELD_TRACE = '/workspace/t911u-9080127650-official/extract-5a8e575/trace';
describe.skipIf(!existsSync(join(HELD_TRACE,'states.jsonl')))('held NS trace yield (local, read-only)', () => {
  it('yields positions, HP/mana, cooldowns and 30 s last-hit snapshots from the real trace', async () => {
    const { readReviewEvents } = await import('../../../lib/matchReview/replayIngest/extractor.js');
    const trace = await readReviewEvents(join(HELD_TRACE,'events.jsonl'));
    const sup = await readReplaySupplement(HELD_TRACE, trace.events);
    const hs = sup.heroStates;
    expect(hs.truncated).toBe(false);
    expect(hs.visibility).toBe('null_in_trace');
    expect(hs.anchors.length).toBeGreaterThan(0);
    expect(hs.anchors.some(a=>a.kind==='hero_death')).toBe(true);
    expect(hs.anchors.some(a=>a.kind==='building_kill')).toBe(true);
    const ns = hs.samples.filter(s=>s.hero==='night_stalker');
    expect(ns.length).toBeGreaterThan(50);
    expect(ns.every(s=>Number.isFinite(s.x) && Number.isFinite(s.y))).toBe(true);
    expect(ns.some(s=>Number.isFinite(s.hp) && Number.isFinite(s.mana) && s.level>0)).toBe(true);
    expect(hs.samples.some(s=>(s.abilities??[]).some(a=>a.cooldown>0))).toBe(true);
    expect(sup.positions.length).toBeGreaterThan(0);
    const fort = trace.events.find(e=>e.type==='DOTA_COMBATLOG_TEAM_BUILDING_KILL' && e.target==='npc_dota_badguys_fort');
    expect(Math.abs(fort.t-1906.77)).toBeLessThan(1);
    expect(fort.attacker_team).toBe(2);
  });
});
