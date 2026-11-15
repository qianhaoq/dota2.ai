import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildReview} from '../src/buildReview.js';
import {applyReplayArtifact} from '../src/replay.js';
import {buildMoments,evidenceName,itemName,clock} from '../src/insights/moments.js';
import {validateReview} from '../src/schema/validate.js';
import dictionary from '../data/display-names.json' with {type:'json'};
import {STATIC_HEROES} from '../src/staticHeroes.js';
const samples=[[9080127650,60,2],[9089115713,74,0],[9088239359,71,0]];
for(const [match,heroId,bkbCount] of samples) it.each(['zh','en'])(`selects only linked evidence for ${match} (%s)`,lang=>{
 const a=JSON.parse(readFileSync(`data/replay-facts/${match}.json`));
 const p=a.players.find(p=>p.hero_id===heroId);
 const r=buildReview(applyReplayArtifact({match_id:match,players:a.players},a),{heroId,lang,fetchedAt:a.fetched_at,presetFollowups:true});
 expect(validateReview(r)).toEqual({ok:true,errors:[]});
 const copy=r.insights.map(i=>[i.claim.text,i.prompt,...i.fact_ids.map(id=>r.facts[id].display[lang])]).flat().join(' ')+r.followups.map(f=>f.label).join(' ');
 expect(copy).not.toMatch(/何时送达|何时使用|when.*delivered|SHA-256|trace\/|source_path|视野|队友位置|vision|teammate positions|因此死亡|所以输掉/);
 expect(r.insights.every(i=>!i.id.startsWith('purchase.')&&i.kind!=='purchase_context')).toBe(true);
 const windows=r.insights.filter(i=>i.kind==='item_window');
 expect(windows).toHaveLength(bkbCount);
 expect(r.insights.map(i=>i.id)).toEqual(({9080127650:['death.3','death.5','death.6','bkb.1','bkb.2'],9089115713:['death.1'],9088239359:['death.4','death.5','death.6']})[match]);
 const selected=r.insights.flatMap(i=>i.fact_ids.map(id=>r.facts[id]));
 expect(copy+JSON.stringify(selected.map(f=>({id:f.id,value:f.value})))).not.toMatch(/invoker_quas|invoker_wex|invoker_exort|invoker_invoke|morphling_morph_str|morphling_morph_agi/);
 const focusKey=STATIC_HEROES[heroId].internalName;
 for(const i of r.insights) for(const id of i.fact_ids.filter(id=>id.startsWith('cast.'))){
 const c=r.facts[id].value; const d=r.deaths.find(d=>i.fact_ids.includes(d.fact_id));
 if(c.target && c.actor!==focusKey && c.target!==focusKey) expect(c.key).toBe(d?.inflictor);
 }
 expect(r.item_uses).toEqual((p.item_use_log??[]).filter(u=>u.key==='black_king_bar'&&Number.isFinite(u.t)&&Number.isFinite(u.ended_at)&&u.end_source_path).map(u=>({t:u.t,item:u.key,ended_at:u.ended_at})));
 for(const i of windows){
  expect(i.fact_ids.length).toBeGreaterThanOrEqual(2);
  const u=r.facts[i.fact_ids[0]].value;
  expect(u.key).toBe('black_king_bar');
  expect(u.end_source_path).toBeTruthy();
  expect(i.time).toEqual({from:u.t,to:u.ended_at});
  expect(i.time.to-i.time.from).toBeLessThanOrEqual(10);
 }
 for(const i of r.insights){
  if(i.id.startsWith('death.')){
   const index=Number(i.id.split('.')[1])-1;
   const original=p.deaths_log[index];
   expect(r.facts[i.fact_ids[0]].value.inflictor).toBe(original.inflictor);
   if(original.key)expect(i.claim.text).toContain(evidenceName(original.key,lang));
   if(original.inflictor){expect(dictionary.abilities[original.inflictor]).toBeTruthy();expect(i.claim.text).toContain(dictionary.abilities[original.inflictor][lang]??dictionary.abilities[original.inflictor].en);}
  }
  for(const id of i.fact_ids){
   const f=r.facts[id];expect(f.citation).toBe('r1');
   expect(f.value?.key).not.toBe('tpscroll');
   expect(id).not.toMatch(/^purchase/);
   if(!id.startsWith('cast.death.'))continue;
   const c=f.value;
   const owner=a.players.find(p=>p.ability_cast_log?.some(e=>e.source_path===c.source_path));
   expect(owner).toBeTruthy();
   const death=r.deaths.find(d=>i.fact_ids.includes(d.fact_id));
   const killer=death.killer?.replace(/^npc_dota_hero_/,'');
   const actor=STATIC_HEROES[owner.hero_id].internalSlug;
   const target=c.target?.replace(/^npc_dota_hero_/,'');
   const focus=STATIC_HEROES[heroId].internalSlug;
   const qualified=target===focus || (death.inflictor&&c.key===death.inflictor) || (actor===focus&&!!target&&a.players.some(p=>STATIC_HEROES[p.hero_id].internalSlug===target));
   const support=actor===killer&&!target&&f.display[lang].includes(lang==='zh'?'未证明命中':'a hit is not proven');
   expect(qualified||support).toBeTruthy();
   expect(dictionary.abilities[c.key]).toBeTruthy();
   expect(f.display[lang]).toContain(evidenceName(c.key,lang));
   expect(f.display[lang]).toContain(evidenceName(STATIC_HEROES[owner.hero_id].internalName,lang));
  }
 }
 for(const purchase of p.purchase_log){
  expect(r.purchases).toContainEqual(expect.objectContaining({t:purchase.time,item:purchase.key}));
  expect(dictionary.items[purchase.key]).toBeTruthy();
  expect(itemName(purchase.key,lang)).toBe(dictionary.items[purchase.key][lang]??dictionary.items[purchase.key].en);
 }
 if(match===9080127650){
  const pre=r.purchases.find(p=>p.t < -79 && p.t > -80);expect(pre).toBeTruthy();expect(clock(pre.t)).toBe('-1:19');
  expect(r.deaths.some(d=>d.inflictor==='pudge_meat_hook')).toBe(true);
  expect(r.insights.some(i=>i.fact_ids.some(id=>r.facts[id].value?.inflictor==='pudge_meat_hook'||r.facts[id].value?.key==='pudge_meat_hook'))).toBe(false);
  for(const inf of ['pudge_dismember','skeleton_king_bone_guard'])expect(r.insights.some(i=>i.fact_ids.some(id=>r.facts[id].value?.inflictor===inf))).toBe(true);
  expect(r.insights.some(i=>i.fact_ids.some(id=>r.facts[id].value?.key==='necrolyte_reapers_scythe'))).toBe(true);
 }
 if(match===9089115713){
  expect(copy).not.toMatch(/sniper|狙击手|冰霜新星|射火巫师/i);
  const death=r.insights.find(i=>i.id==='death.1');
  expect(death.claim.text).toContain(lang==='zh'?'撼地者':'Earthshaker');
  expect(r.facts['death.1'].value.inflictor).toBeUndefined();
  expect(death.fact_ids.some(id=>r.facts[id].value?.key==='earthshaker_echo_slam')).toBe(true);
 }
 if(match===9088239359){
  for(const inf of ['lion_finger_of_death','juggernaut_blade_fury'])expect(r.insights.some(i=>i.fact_ids.some(id=>r.facts[id].value?.inflictor===inf))).toBe(true);
  for(const t of [272,624,860])expect(r.insights.some(i=>Math.floor(i.time.from)===t&&i.kind==='item_window')).toBe(false);
  const wave=r.insights.find(i=>i.id==='death.4');
  const fury=r.insights.find(i=>i.id==='death.6');
  const stripDeath=text=>text.replace(lang==='zh'?/死亡记录[^；]*/g:/Death recorded[^；]*/g,'');
  expect(wave.claim.text).toMatch(lang==='zh'?'暗影冲刺 → 变体精灵':'Charge of Darkness');
  expect(wave.claim.text).toMatch(lang==='zh'?'死亡记录 · 变体精灵 · 波浪形态':'Death recorded · Morphling · Waveform');
  expect(stripDeath(wave.claim.text)).not.toMatch(lang==='zh'?'波浪形态':'Waveform');
  expect(wave.claim.text).not.toMatch(lang==='zh'?'未证明命中':'a hit is not proven');
  expect(wave.fact_ids.some(id=>r.facts[id].value?.key==='morphling_waveform')).toBe(true);
  expect(stripDeath(fury.claim.text)).not.toMatch(lang==='zh'?'剑刃风暴':'Blade Fury');
  expect(fury.claim.text).not.toMatch(lang==='zh'?'未证明命中':'a hit is not proven');
 }
});
it('resolves official names from the same real ids, with neutral unknown fallbacks',()=>{
 expect(evidenceName('invoker_cold_snap','zh')).toBe('急速冷却');expect(evidenceName('invoker_cold_snap','en')).toBe('Cold Snap');
 expect(evidenceName('snapfire','zh')).toBe('电炎绝手');expect(evidenceName('snapfire','en')).toBe('Snapfire');
 expect(evidenceName('unregistered_spell','zh')).toBe('未知单位或技能');expect(itemName('unregistered_item','en')).toBe('Unknown item');
});
it.each([40,90,110])('never splices a TP to a death %ss later',delay=>{
 const result={facts:{d:{id:'d',citation:'r1'}},deaths:[{t:100+delay,killer:'lion',fact_id:'d'}]};
 const moments=buildMoments(result,{item_use_log:[{t:100,key:'tpscroll'}],purchase_log:[{time:-79,key:'recipe_null_talisman'}]},'zh');
 expect(moments).toEqual([]);
});
it('ignores unlinked contemporaneous casts and objectives and does not infer missing inflictors',()=>{
 const result={facts:{d:{id:'d',citation:'r1'},'obj.100':{id:'obj.100',t:100}},deaths:[{t:100,killer:'earthshaker',fact_id:'d'}]};
 const focus={hero_id:74};
 const unrelated={hero_id:26,ability_cast_log:[{t:99,key:'lion_impale',target:'npc_dota_hero_snapfire'}]};
 const moments=buildMoments(result,focus,'zh',[focus,unrelated]);
 expect(moments).toEqual([]);
});
it('requires an enemy target or overlapping death inside the verified BKB interval',()=>{
 const focus={hero_id:60,player_slot:128,item_use_log:[{t:100,ended_at:109,key:'black_king_bar',source_path:'use',end_source_path:'end'}],ability_cast_log:[{t:102,key:'night_stalker_void',target:'npc_dota_hero_lion',source_path:'own'}]};
 const ally={hero_id:128,player_slot:129,ability_cast_log:[{t:103,key:'snapfire_firesnap_cookie',target:'npc_dota_hero_night_stalker',source_path:'ally'}]};
 const enemy={hero_id:26,player_slot:0,ability_cast_log:[{t:104,key:'lion_voodoo',target:'npc_dota_hero_snapfire',source_path:'third'}]};
 const make=()=>({facts:{},deaths:[]});
 expect(buildMoments(make(),focus,'en',[focus,ally,enemy])).toEqual([]);
 enemy.ability_cast_log[0].target='npc_dota_hero_night_stalker';
 const r=make();const clips=buildMoments(r,focus,'en',[focus,ally,enemy]);
 expect(clips).toHaveLength(1);expect(clips[0].time).toEqual({from:100,to:109});
 enemy.ability_cast_log[0].t=110;
 expect(buildMoments(make(),focus,'en',[focus,ally,enemy])).toEqual([]);
});
it('does not promote a death whose only link is the recorded inflictor',()=>{
 const focus={hero_id:60};
 const killer={hero_id:14,ability_cast_log:[{t:100,key:'pudge_meat_hook',source_path:'hook'}]};
 const result={facts:{d:{id:'d',citation:'r1'}},deaths:[{t:100,killer:'pudge',inflictor:'pudge_meat_hook',fact_id:'d'}]};
 expect(buildMoments(result,focus,'zh',[focus,killer])).toEqual([]);
});
it('keeps untargeted killer casts only as deduplicated unproven support after qualification',()=>{
 const focus={hero_id:74};
 const killer={hero_id:7,ability_cast_log:[{t:99,key:'earthshaker_echo_slam',source_path:'aoe1'},{t:100,key:'earthshaker_echo_slam',source_path:'aoe2'},{t:99,key:'earthshaker_enchant_totem',source_path:'untargeted'}]};
 const make=()=>({facts:{d:{display:{en:'Death',zh:'死亡'}}},deaths:[{t:100,killer:'earthshaker',fact_id:'d'}]});
 expect(buildMoments(make(),focus,'en',[focus,killer])).toEqual([]);
 const other={hero_id:84,ability_cast_log:[{t:99,key:'ogre_magi_fireblast',target:'npc_dota_hero_invoker',source_path:'targeted'}]};
 const r=make();const [clip]=buildMoments(r,focus,'en',[focus,killer,other]);
 expect(clip.fact_ids.filter(id=>r.facts[id].value?.key==='earthshaker_echo_slam')).toHaveLength(1);
 expect(clip.claim.text).not.toContain('Echo Slam');
 expect(clip.fact_ids.some(id=>r.facts[id].value?.key==='earthshaker_enchant_totem')).toBe(false);
 expect(clip.fact_ids.map(id=>r.facts[id].display.en).join(' ')).toContain('a hit is not proven');
});
