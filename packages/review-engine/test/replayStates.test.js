import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adaptReplayEvents, applyReplayArtifact, isVerifiedReplay } from '../src/replay.js';
import { readReplaySupplement, HERO_STATE_CAPS, HERO_STATE_SAMPLING } from '../../../lib/matchReview/replayIngest/extractor.js';

const metadata = {demo_bytes:1000,demo_sha256:'a'.repeat(64),fetched_at:'2026-11-11T00:00:00Z'};
const raw = {match_id:42,duration:1200,radiant_win:true,players:[{hero_id:2,player_slot:0},{hero_id:60,player_slot:132}]};

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

async function supplementTo(traceDir, events) {
  const signal = new AbortController().signal;
  return readReplaySupplement(traceDir, events.map((e,i)=>({...e,trace_index:i})), signal);
}

describe('bounded hero-state sampling from a states trace', () => {
  let traceDir;
  beforeAll(() => {
    traceDir = mkdtempSync(join(tmpdir(),'replay-states-'));
    writeFileSync(join(traceDir,'states.jsonl'), statesLines().join('\n')+'\n');
  });

  it('keeps ~30 s cadence rows with real game_time, HP/mana and compact cooldowns', async () => {
    const sup = await supplementTo(traceDir, events);
    const hs = sup.heroStates;
    expect(hs).toBeTruthy();
    expect(hs.sampling).toBe(HERO_STATE_SAMPLING);
    expect(hs.visibility).toBe('fields_present'); // one row carries non-null visibility
    const axe300 = hs.samples.filter(s=>s.hero==='axe' && Math.abs(s.t-300)<=HERO_STATE_CAPS.cadence_tolerance_s);
    expect(axe300).toHaveLength(1); // grid 300 sits outside every anchor window
    expect(axe300[0].t).toBe(300); // real game_time kept, not snapped to a grid
    expect(axe300[0].hp).toBe(1000);
    expect(axe300[0].mana).toBe(300);
    expect(axe300[0].items).toEqual([{name:'item_phase_boots',slot:0},{name:'item_magic_wand',slot:2,charges:5}]);
    expect(axe300[0].abilities).toEqual([{name:'axe_q',slot:0,level:2,cooldown:3.5}]); // level-0 ability and zero cooldown omitted
  });

  it('adds dense rows around mixed anchors and never the full trace', async () => {
    const sup = await supplementTo(traceDir, events);
    const hs = sup.heroStates;
    // One structure anchor, one hero-death anchor, one verified item anchor (merged within 30 s).
    expect(hs.anchors.map(a=>a.kind)).toEqual(['building_kill','hero_death','item_use']);
    const aroundDeath = hs.samples.filter(s=>s.t>=600.2-HERO_STATE_CAPS.window_before_s && s.t<=600.2+HERO_STATE_CAPS.window_after_s);
    const perSecond = new Set(aroundDeath.filter(s=>s.hero==='axe').map(s=>Math.floor(s.t-(600.2-HERO_STATE_CAPS.window_before_s))));
    expect(perSecond.size).toBeGreaterThan(15); // ~1 s cadence rows exist
    expect(hs.samples.length).toBeLessThan(4000); // bounded, far below the 8002 trace rows
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
    writeFileSync(join(nullDir,'states.jsonl'), statesLines(false).join('\n')+'\n'); // same rows, visibility stays null
    const sup = await supplementTo(nullDir, events);
    expect(sup.heroStates.visibility).toBe('null_in_trace');
  });
});

describe('hero states and snapshots in the compact artifact', () => {
  it('carries hero_states into the artifact with honest gaps', () => {
    const heroStates = {source:'trace/states.jsonl',anchors:[{t:600.2,kind:'hero_death',key:'npc_dota_hero_axe',score:1}],caps:HERO_STATE_CAPS,truncated:false,visibility:'null_in_trace',sampling:HERO_STATE_SAMPLING,samples:[{t:600,hero:'axe',team:2,x:100,y:-200,hp:1000,max_hp:1200,mana:300,max_mana:450,level:6,life_state:0,items:[{name:'item_phase_boots',slot:0}],abilities:[{name:'axe_q',slot:0,level:2}]}]};
    const a = adaptReplayEvents(raw, events, metadata, null, [], heroStates);
    expect(a.hero_states).toMatchObject({source:'trace/states.jsonl',visibility:'null_in_trace',truncated:false});
    expect(a.hero_states.samples[0]).toMatchObject({hero:'axe',hp:1000});
    expect(a.data_gaps).toContainEqual({topic:'creep_waves',reason:'states_have_no_creep_entities'});
    expect(a.data_gaps).toContainEqual({topic:'hero_state_visibility',reason:'states_visibility_null_in_trace'});
    // Combat-log Roshan contact is never a kill clock: always a registered gap.
    expect(a.data_gaps).toContainEqual({topic:'roshan_kill',reason:'no_reliable_roshan_kill_event'});
    expect(a.data_gaps).not.toContainEqual({topic:'hero_states',reason:'sample_cap_truncated'});
  });

  it('applies to a match and keeps legacy no-state artifacts verifiable', () => {
    const heroStates = {source:'trace/states.jsonl',anchors:[],caps:HERO_STATE_CAPS,truncated:false,visibility:'fields_present',sampling:HERO_STATE_SAMPLING,samples:[{t:602,hero:'axe',team:2,x:1,y:2,hp:10,max_hp:20,mana:0,max_mana:0,level:1,life_state:0}]};
    const a = adaptReplayEvents(raw, [], metadata, null, [], heroStates);
    const applied = applyReplayArtifact(raw, a);
    expect(applied.hero_states.samples[0]).toMatchObject({t:602,hero:'axe'});
    expect(isVerifiedReplay(applied.replay_ingest,42)).toBe(true);
    const legacy = adaptReplayEvents(raw, [], metadata);
    expect(legacy.hero_states).toBeUndefined();
    const legacyApplied = applyReplayArtifact(raw, legacy);
    expect(legacyApplied.hero_states).toBeUndefined();
    expect(isVerifiedReplay(legacyApplied.replay_ingest,42)).toBe(true);
  });
});

describe('inventory snapshots keep their actual game_time', () => {
  const meta = {players:[
    {player_slot:0,inventory_snapshots:[{game_time:29,last_hits:4,denies:1,level:1},{game_time:599,last_hits:48,denies:2,kills:3,deaths:1,assists:5,level:11},{game_time:629,last_hits:53,denies:2,level:12}]},
    {player_slot:132,inventory_snapshots:[{game_time:600,last_hits:10}]},
  ]};
  it('retains snapshots off the minute grid and cites the real sample time', () => {
    const a = adaptReplayEvents(raw, [], metadata, meta);
    const p = a.players[0];
    expect(p.inventory_snapshots.map(s=>s.t)).toEqual([29,599,629]);
    expect(p.inventory_snapshots[1]).toMatchObject({last_hits:48,denies:2,kills:3,deaths:1,assists:5,level:11});
    expect(p.snapshot_sampling).toContain('actual game_time');
    // minute-aligned view: 29→0 (Δ29), 599→10 (Δ1), 629 stays out of minute 10 once 599 won
    expect(p.lh_t[10]).toBe(48);
    expect(p.lh_t_sample[10]).toBe(599);
    expect(p.lh_t[0]).toBe(4);
    expect(p.lh_t_sample[0]).toBe(29);
    expect(a.data_gaps).not.toContainEqual({topic:'lh_t',reason:'metadata_snapshot_missing'});
  });

  it('exposes lh_at_10 from the nearest snapshot within 30 s', () => {
    const sparse = {players:[{player_slot:0,inventory_snapshots:[{game_time:581,last_hits:44,denies:1}]},{player_slot:132,inventory_snapshots:[]}]};
    const a = adaptReplayEvents(raw, [], metadata, sparse);
    expect(a.players[0].lh_t[10]).toBe(44);
    expect(a.players[0].lh_t_sample[10]).toBe(581);
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
    expect(hs.visibility).toBe('null_in_trace'); // every states row's visibility is null in this extraction
    expect(hs.anchors.length).toBeGreaterThan(0);
    expect(hs.anchors.some(a=>a.kind==='hero_death')).toBe(true);
    expect(hs.anchors.some(a=>a.kind==='building_kill')).toBe(true);
    const ns = hs.samples.filter(s=>s.hero==='night_stalker');
    expect(ns.length).toBeGreaterThan(50);
    expect(ns.every(s=>Number.isFinite(s.x) && Number.isFinite(s.y))).toBe(true);
    expect(ns.some(s=>Number.isFinite(s.hp) && Number.isFinite(s.mana) && s.level>0)).toBe(true);
    expect(hs.samples.some(s=>(s.abilities??[]).some(a=>a.cooldown>0))).toBe(true);
    expect(sup.positions.length).toBeGreaterThan(0);
    // Dire Night Stalker: Dire ancient fell at 31:46 (1906.77 s) to team 2 → loss.
    const fort = trace.events.find(e=>e.type==='DOTA_COMBATLOG_TEAM_BUILDING_KILL' && e.target==='npc_dota_badguys_fort');
    expect(Math.abs(fort.t-1906.77)).toBeLessThan(1);
    expect(fort.attacker_team).toBe(2);
  });
});
