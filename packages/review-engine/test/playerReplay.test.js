import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildReview } from '../src/buildReview.js';
import { applyReplayArtifact } from '../src/replay.js';
import { validateReview } from '../src/schema/validate.js';
import { answerPresetFollowup } from '../src/phrasing/followups.js';
const bytes=readFileSync('data/replay-facts/9080127650.json');
const artifact=JSON.parse(bytes);
const raw={match_id:9080127650,duration:1906.767,radiant_win:true,radiant_score:48,dire_score:19,players:artifact.players.map(p=>({hero_id:p.hero_id,player_slot:p.player_slot,...(p.hero_id===60?{kills:4,deaths:8,assists:6}:{})}))};
const review=lang=>buildReview(applyReplayArtifact(raw,artifact),{heroId:60,lang,fetchedAt:artifact.fetched_at,presetFollowups:true});
describe('official replay player review',()=>{
 it.each(['zh','en'])('emits cited replay moments rather than forced verdict slots (%s)',lang=>{
  const r=review(lang);
  expect(r.state).toBe('parsed');
  expect(validateReview(r)).toEqual({ok:true,errors:[]});
  expect(r.insights.map(i=>i.id)).toEqual(['hook_death','void_dismember','darkness_scythe','skeleton_before_bkb','bkb_windows']);
  for(const i of r.insights){expect(i.status).toBe('ok');expect(i.prompt).toBeTruthy();expect(i.fact_ids.length).toBeGreaterThan(0);for(const id of i.fact_ids)expect(r.facts[id]?.citation).toBe('r1');}
  expect(r.deaths[5]).toMatchObject({killer:'npc_dota_wraith_king_skeleton_warrior',inflictor:'skeleton_king_bone_guard'});
  expect(r.facts['cast.darkness_before_scythe'].t).toBeCloseTo(705,0);
  expect(r.deaths[3].t-r.facts['cast.darkness_before_scythe'].t).toBeCloseTo(3.27,1);
  expect(r.facts['purchase.bkb_after_skeleton'].t).toBeCloseTo(1563.47,1);
  expect(r.facts['cast.feast_before_skeleton'].t).toBeCloseTo(1501.4,0);
  expect(r.facts['use.bkb.1'].value).toMatchObject({key:'black_king_bar'});
  expect(r.facts['use.bkb.1'].value.ended_at).toBeCloseTo(1654.2,1);
  expect(r.facts['use.bkb.2'].value.t).toBeCloseTo(1797.27,1);
  expect(r.facts['use.bkb.2'].value.ended_at).toBeCloseTo(1805.27,1);
  expect(r.followups).toHaveLength(3);
  const copy=r.insights.map(i=>i.claim.text+' '+i.prompt).join(' ')+r.followups.map(f=>answerPresetFollowup(f,r.facts,lang).text).join(' ');
  expect(copy).not.toMatch(/state_sample|sample_t|net_worth_t|trace_version|trace\//);
  expect(new Set(r.data_gaps.map(g=>g.topic)).size).toBe(r.data_gaps.length);
 });
 it('keeps a compact identity-free artifact and preserves verified match anchors',()=>{
  expect(bytes.length).toBeLessThan(350000);
  const walk=v=>{if(v&&typeof v==='object')for(const [k,c]of Object.entries(v)){expect(k).not.toMatch(/account|persona/i);walk(c);}};walk(artifact);
  expect(artifact.schema).toBe('dota2.ai/replay-facts@1');expect(artifact.trace_version).toBe(4);
  const p=artifact.players.find(p=>p.hero_id===60);
  expect(p.deaths_log.map(d=>Math.floor(d.time))).toEqual([198,279,495,708,895,1544,1716,1832]);
  expect(p.ability_cast_log.filter(c=>c.key==='night_stalker_darkness')).toHaveLength(7);
  expect(p.phase_boots_use_count).toBe(80);
  expect(artifact.objectives.find(o=>o.key==='npc_dota_badguys_fort').time).toBeCloseTo(1906.767,2);
 });
 it('keeps the OpenDota sample parsed and the displayed followups bounded',()=>{
  const sample=JSON.parse(readFileSync('src/fixtures/match9035042364.parsed.json'));
  const r=buildReview(sample,{heroId:14,lang:'en',fetchedAt:artifact.fetched_at,presetFollowups:true});
  expect(r.state).toBe('parsed');expect(validateReview(r).ok).toBe(true);
 });
});

it('retains compact enrichment through the official-file event reader and adapter', async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {readReviewEvents}=await import('../../../lib/matchReview/replayIngest/extractor.js');
 const {adaptReplayEvents}=await import('../src/replay.js');
 const dir=await mkdtemp(join(tmpdir(),'player-review-'));
 try {
  const actor={attacker:'npc_dota_hero_night_stalker',attacker_hero:true,attacker_illusion:false};
  const target={target:'npc_dota_hero_night_stalker',target_hero:true,target_illusion:false};
  const events=[
   {...actor,type:'DOTA_COMBATLOG_ABILITY',t:705,inflictor:'night_stalker_darkness'},
   {...target,type:'DOTA_COMBATLOG_DEATH',t:708,attacker:'npc_dota_wraith_king_skeleton_warrior',inflictor:'skeleton_king_bone_guard'},
   {...actor,type:'DOTA_COMBATLOG_ITEM',t:1645,inflictor:'item_black_king_bar'},
   {...target,type:'DOTA_COMBATLOG_MODIFIER_REMOVE',t:1654,inflictor:'modifier_black_king_bar_immune'},
   {...actor,type:'DOTA_COMBATLOG_ITEM',t:1700,inflictor:'item_phase_boots'},
  ];
  const path=join(dir,'events.jsonl');await writeFile(path,events.map(e=>JSON.stringify(e)).join('\n')+'\n');
  const read=await readReviewEvents(path);
  expect(read.events).toHaveLength(5);
  const a=adaptReplayEvents({match_id:1,players:[{hero_id:60,player_slot:132}]},read.events,{});
  const p=a.players[0];
  expect(p.ability_cast_log).toEqual([{t:705,key:'night_stalker_darkness',source_path:'trace/events.jsonl[0]'}]);
  expect(p.deaths_log[0]).toMatchObject({key:'npc_dota_wraith_king_skeleton_warrior',inflictor:'skeleton_king_bone_guard'});
  expect(p.item_use_log).toEqual([{t:1645,key:'black_king_bar',source_path:'trace/events.jsonl[2]',ended_at:1654,end_source_path:'trace/events.jsonl[3]'}]);
  expect(p.phase_boots_use_count).toBe(1);
 } finally {await rm(dir,{recursive:true,force:true});}
});

it('builds generic spell, item and purchase candidates and a usable zero-death fallback',async()=>{
 const {buildMoments}=await import('../src/insights/moments.js');
 const make=()=>({facts:{'death.one':{id:'death.one',t:100}},deaths:[{t:100,inflictor:'lina_laguna_blade',fact_id:'death.one'}]});
 const r=make();const moments=buildMoments(r,{ability_cast_log:[{t:96,key:'lion_impale'}],item_use_log:[{t:50,key:'magic_wand',ended_at:52}],purchase_log:[{time:120,key:'blink'}]},'en');
 expect(moments.some(i=>i.kind==='ability_into_death')).toBe(true);expect(moments.some(i=>i.kind==='item_window')).toBe(true);expect(moments.some(i=>i.kind==='purchase_context')).toBe(true);
 for(const i of moments){expect(i.fact_ids.every(id=>r.facts[id])).toBe(true);expect(i.time).toBeTruthy();expect(i.prompt).toBeTruthy();}
 const zero=buildMoments({facts:{'match.id':{id:'match.id'}},deaths:[]},{},'en');expect(zero).toHaveLength(1);expect(zero[0].fact_ids).toEqual(['match.id']);
});
