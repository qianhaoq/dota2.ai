import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildReview} from '../src/buildReview.js';
import {applyReplayArtifact} from '../src/replay.js';
import {buildMoments,evidenceName,itemName,clock} from '../src/insights/moments.js';
import {validateReview} from '../src/schema/validate.js';
import dictionary from '../data/display-names.json' with {type:'json'};
import {STATIC_HEROES} from '../src/staticHeroes.js';
const samples=[[9080127650,60],[9089115713,74],[9088239359,71]];
for(const [match,heroId] of samples) it.each(['zh','en'])(`selects only linked evidence for ${match} (%s)`,lang=>{
 const a=JSON.parse(readFileSync(`data/replay-facts/${match}.json`));
 const p=a.players.find(p=>p.hero_id===heroId);
 // Scoreboard K/D/A rides on the OpenDota raw in production; inject the
 // officially verified values so the overview carries the same numbers.
 const raw={match_id:match,players:a.players.map(pl=>pl.hero_id===heroId?{...pl,kills:heroId===74?9:pl.kills,deaths:heroId===74?1:pl.deaths,assists:heroId===74?12:pl.assists}:pl)};
 const r=buildReview(applyReplayArtifact(raw,a),{heroId,lang,fetchedAt:a.fetched_at,presetFollowups:true});
 expect(validateReview(r)).toEqual({ok:true,errors:[]});
 // Mainline structure: overview first, then 3–5 decision windows.
 expect(r.insights[0].id).toBe('review_overview');
 expect(r.insights[0].kind).toBe('review_overview');
 const windows=r.insights.filter(i=>i.kind==='review_window');
 expect(windows.length).toBeGreaterThanOrEqual(3);
 expect(windows.length).toBeLessThanOrEqual(5);
 expect(windows.map(w=>w.id)).toEqual(windows.map((w,i)=>`window.${i+1}`));
 expect(r.insights.every(i=>!i.id.startsWith('purchase.')&&i.kind!=='purchase_context')).toBe(true);
 const copy=r.insights.map(i=>[i.claim.text,i.title,i.prompt,...(i.sections??[]).map(s=>s.text),...i.fact_ids.map(id=>r.facts[id].display[lang])]).flat().join(' ')
  +(r.practice?[(r.practice.note??''),...r.practice.items.flatMap(it=>[it.goal,it.condition])].join(' '):'')
  +r.followups.map(f=>f.label).join(' ');
 expect(copy).not.toMatch(/何时送达|何时使用|when.*delivered|SHA-256|trace\/|source_path|视野|队友位置|vision|teammate positions|因此死亡|所以输掉/);
 const selected=r.insights.flatMap(i=>i.fact_ids.map(id=>r.facts[id]));
 expect(copy+JSON.stringify(selected.map(f=>({id:f.id,value:f.value})))).not.toMatch(/invoker_quas|invoker_wex|invoker_exort|invoker_invoke|morphling_morph_str|morphling_morph_agi/);
 // Every referenced fact is replay-cited, never a purchase or an untargeted
 // hook/TP splice; cast evidence stays qualified or marked as unproven support.
 const focusKey=STATIC_HEROES[heroId].internalName;
 for(const i of r.insights){
  expect(i.fact_ids.length).toBeGreaterThan(0);
  for(const id of i.fact_ids){
   const f=r.facts[id];expect(f).toBeTruthy();expect(f.citation==='r1'||id==='scoreboard.kda'&&f.citation==='s1').toBe(true);
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
 expect(r.item_uses).toEqual((p.item_use_log??[]).filter(u=>u.key==='black_king_bar'&&Number.isFinite(u.t)&&Number.isFinite(u.ended_at)&&u.end_source_path).sort((a,b)=>a.t-b.t).map(u=>({t:u.t,item:u.key,ended_at:u.ended_at})));
 // Overview and window copy: no causality arrows, sentence-final, clocks only
 // from cited facts and inside the window frame.
 const allInsights=[r.insights[0],...windows];
 for(const i of allInsights){
  expect(i.claim.text).not.toMatch(/→| · |死亡记录|Death recorded/);
  expect(i.claim.text).toMatch(lang==='zh'?/。$/:/\.$/);
  expect(i.title).not.toMatch(/已核实|Verified fight|最该改|值得复看|遭遇|hit was verified|encountered/);
  const times=i.fact_ids.flatMap(id=>{const f=r.facts[id];return [f.t,f.value?.ended_at].filter(Number.isFinite);});
  const clocks=i.claim.text.match(/-?\d+:\d{2}/g)??[];
  for(const time of clocks)expect(times.map(clock)).toContain(time);
  if(i.kind==='review_window'){
   for(const time of clocks){const secs=time.split(':').map(Number);expect(secs[0]*60+secs[1]).toBeGreaterThanOrEqual(i.time.from);}
   for(const section of i.sections){
    expect(section.text).not.toMatch(/→| · |死亡记录|Death recorded/);
    expect(section.text).toMatch(lang==='zh'?/。$/:/\.$/);
    for(const id of section.fact_ids??[]) expect(i.fact_ids).toContain(id);
   }
   expect(i.sections.filter(s=>s.label_key==='known')).toHaveLength(1);
   expect(i.sections.filter(s=>s.label_key==='actions')).toHaveLength(1);
  }
 }
 for(const purchase of p.purchase_log){
  expect(r.purchases).toContainEqual(expect.objectContaining({t:purchase.time,item:purchase.key}));
  expect(dictionary.items[purchase.key]).toBeTruthy();
  expect(itemName(purchase.key,lang)).toBe(dictionary.items[purchase.key][lang]??dictionary.items[purchase.key].en);
 }
 if(match===9080127650){
  const pre=r.purchases.find(p=>p.t < -79 && p.t > -80);expect(pre).toBeTruthy();expect(clock(pre.t)).toBe('-1:19');
  // Night Stalker is Dire; the Ancient that fell at 31:46 was the Dire fort,
  // destroyed by team 2 (Radiant) — the recorded loss.
  expect(r.player.team).toBe('dire');
  expect(r.insights[0].claim.text).toContain(lang==='zh'?'31:46 夜魇基地被天辉摧毁':'31:46: Dire lost the Ancient (destroyed by Radiant)');
  expect(r.deaths.some(d=>d.inflictor==='pudge_meat_hook')).toBe(true);
  expect(r.insights.some(i=>i.fact_ids.some(id=>r.facts[id].value?.inflictor==='pudge_meat_hook'||r.facts[id].value?.key==='pudge_meat_hook'))).toBe(false);
  // Linked kill evidence (dismember, bone guard, reaper's scythe) stays reachable.
  for(const inf of ['pudge_dismember','skeleton_king_bone_guard'])expect(r.insights.some(i=>i.fact_ids.some(id=>r.facts[id].value?.inflictor===inf))).toBe(true);
  expect(r.insights.some(i=>i.fact_ids.some(id=>r.facts[id].value?.key==='necrolyte_reapers_scythe'))).toBe(true);
 }
 if(match===9089115713){
  expect(copy).not.toMatch(/sniper|狙击手|冰霜新星|射火巫师/i);
  // Scoreboard K/D 9/1 survives into the overview; the single verified death
  // is Earthshaker's, without an invented inflictor.
  expect(r.insights[0].claim.text).toContain(lang==='zh'?'记分板 K/D 9/1，助攻 12':'scoreboard K/D 9/1, 12 assists');
  const deathWin=windows.find(w=>w.fact_ids.includes('death.1'));
  expect(deathWin).toBeTruthy();
  expect(deathWin.claim.text).toContain(lang==='zh'?'撼地者':'Earthshaker');
  expect(r.facts['death.1'].value.inflictor).toBeUndefined();
  expect(deathWin.fact_ids.some(id=>r.facts[id].value?.key==='earthshaker_echo_slam')).toBe(true);
  // Corrected tower facts: 12:50 is a Dire self-denial; Radiant's only two
  // enemy towers are 18:45 top T1 and 40:28 bot T1; nothing calls 12:50 a push.
  const overview=r.insights[0].claim.text+(r.insights[0].sections??[]).map(s=>s.text).join(' ');
  const denyText=lang==='zh'?'12:50 夜魇中路一塔被夜魇摧毁':'12:50: Dire lost mid T1 tower (destroyed by Dire)';
  expect(overview).toContain(denyText);
  expect(overview).not.toContain(lang==='zh'?'12:50 夜魇中路一塔被天辉摧毁':'12:50: Dire lost mid T1 tower (destroyed by Radiant)');
  expect(overview).toContain(lang==='zh'?'18:45 夜魇上路一塔被天辉摧毁':'18:45: Dire lost top T1 tower (destroyed by Radiant)');
  expect(overview).toContain(lang==='zh'?'40:28 夜魇下路一塔被天辉摧毁':'40:28: Dire lost bot T1 tower (destroyed by Radiant)');
  // The advantage series is labeled net worth, never earned gold.
  expect(overview).toContain(lang==='zh'?'净资产优势':'net-worth advantage');
  expect(overview).not.toMatch(lang==='zh'?/赚金优势(?!（60 秒桶)/:/earned-gold advantage/);
  // An unlinked BKB use never becomes a near-duplicate window: every BKB-titled
  // window cites its use fact, and the truncating series is named as such.
  for(const w of windows){
   if(!/黑皇杖|Black King Bar/.test(w.title))continue;
   expect(w.fact_ids.some(id=>id.startsWith('use.bkb.'))).toBe(true);
   expect(w.claim.text).toContain(lang==='zh'?'黑皇杖使用':'Black King Bar use');
  }
  expect(windows.some(w=>(w.sections??[]).some(s=>s.label_key==='missing'&&/截断|truncates/.test(s.text)))).toBe(true);
 }
 if(match===9088239359){
  for(const inf of ['lion_finger_of_death','juggernaut_blade_fury'])expect(r.insights.some(i=>i.fact_ids.some(id=>r.facts[id].value?.inflictor===inf))).toBe(true);
  // The Waveform death names its inflictor without duplicating the cast line;
  // the Blade Fury death keeps its exact second (17:55, not 17:54).
  const waveWin=windows.find(w=>r.deaths.find(d=>d.fact_id==='death.4')&&w.fact_ids.includes('death.4'));
  const furyWin=windows.find(w=>w.fact_ids.includes('death.6'));
  expect(waveWin&&waveWin.claim.text).toContain(lang==='zh'?'被变体精灵以波浪形态击杀':'killed by Morphling with Waveform');
  if(furyWin){
   expect(furyWin.claim.text).toContain(lang==='zh'?'被主宰以剑刃风暴击杀':'killed by Juggernaut with Blade Fury');
   expect(furyWin.claim.text).toContain('17:55');
   expect(furyWin.claim.text).not.toContain('17:54');
  }
  expect(r.facts['death.4'].value?.inflictor).toBe('morphling_waveform');
  expect(waveWin?.fact_ids.some(id=>id.startsWith('cast.')&&r.facts[id].value?.key==='morphling_waveform')).toBe(false);
 }
 // No hero-state samples exist in these legacy artifacts: windows must say so
 // instead of implying HP/mana was known, and practice cannot be proven.
 for(const w of windows){
  expect(w.fact_ids.some(id=>id.startsWith('state.win.'))).toBe(false);
 }
 expect(r.practice).toMatchObject({status:'insufficient',items:[]});
 expect(r.practice.note).toBeTruthy();
 expect(r.data_gaps).toContainEqual({topic:'hero_states',reason:'hero_states_not_in_artifact'});
});
it('produces a proven practice goal only when hero-state samples ground a repeated pattern',()=>{
 const a=JSON.parse(readFileSync('data/replay-facts/9080127650.json'));
 // Synthesized 30 s samples: low mana near the start of the promoted death
 // windows (8:15, 14:55, 25:44 → window starts 7:15, 13:55, 24:44).
 const samples=[];
 for(let t=420;t<=1560;t+=30) samples.push({t,hero:'night_stalker',team:3,x:100,y:100,hp:500,max_hp:1000,mana:120,max_mana:600,level:12,life_state:1,player_index:4});
 const raw={match_id:a.match_id,players:a.players};
 const merged={...applyReplayArtifact(raw,a),hero_states:{samples,sampling:'synthesized 30 s samples for the practice test',visibility:'null_in_trace',truncated:false,anchors:[]}};
 for(const lang of ['zh','en']){
  const r=buildReview(merged,{heroId:60,lang,fetchedAt:a.fetched_at});
  expect(validateReview(r)).toEqual({ok:true,errors:[]});
  expect(r.data_gaps.some(g=>g.reason==='hero_states_not_in_artifact')).toBe(false);
  // The windows now carry the state samples the legacy artifacts lacked.
  const windows=r.insights.filter(i=>i.kind==='review_window');
  const stateWins=windows.filter(w=>w.fact_ids.some(id=>id.startsWith(`state.win.`)));
  expect(stateWins.length).toBeGreaterThanOrEqual(2);
  expect(r.practice.status).toBe('proven');
  expect(r.practice.items.length).toBeGreaterThanOrEqual(1);
  const goal=r.practice.items[0].goal, condition=r.practice.items[0].condition;
  expect(goal).toContain(lang==='zh'?'50%':'50%');
  expect(condition).toContain(lang==='zh'?'时序相关，非因果':'temporal, not causal');
  for(const id of r.practice.items[0].fact_ids)expect(r.facts[id]).toBeTruthy();
  expect(r.practice.items[0].fact_ids.some(id=>id.startsWith('state.win.'))).toBe(true);
  expect(r.practice.items[0].fact_ids.some(id=>/^death\.\d+$/.test(id))).toBe(true);
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

it.each([99.1,99.8,99.9])('uses raw times for same-clock order words (cast %s)',t=>{
 const focus={hero_id:71,ability_cast_log:[{t,key:'spirit_breaker_charge_of_darkness',target:'npc_dota_hero_lion',source_path:'cast'}]};
 const d={t:99.8,killer:'lion',inflictor:'lion_finger_of_death',fact_id:'d'};
 for(const lang of ['zh','en']){
  const r={facts:{d:{id:'d',t:d.t,value:d}},deaths:[d]};
  const [card]=buildMoments(r,focus,lang,[focus,{hero_id:26}]);
  expect(card.claim.text.match(/1:39/g)).toHaveLength(2);
  expect(card.claim.text.includes(lang==='zh'?'随后':'then')).toBe(t!==d.t);
  expect(card.title.includes(lang==='zh'?'后':'followed by')).toBe(t<d.t);
  if(t>d.t)expect(card.claim.text.indexOf(lang==='zh'?'击杀':'killed')).toBeLessThan(card.claim.text.indexOf(lang==='zh'?'施放':'cast'));
 }
});

it('sorts BKB casts and the public item-use list by raw time',()=>{
 const a=JSON.parse(readFileSync('data/replay-facts/9080127650.json'));
 const focus=a.players.find(p=>p.hero_id===60);
 focus.item_use_log.reverse();
 for(const p of a.players)p.ability_cast_log?.reverse();
 const r=buildReview(applyReplayArtifact({match_id:a.match_id,players:a.players},a),{heroId:60,lang:'en',fetchedAt:a.fetched_at});
 expect(r.item_uses.map(u=>u.t)).toEqual(r.item_uses.map(u=>u.t).toSorted((a,b)=>a-b));
 for(const card of r.insights.filter(i=>i.kind==='item_window')){
  const casts=card.fact_ids.filter(id=>id.startsWith('cast.')).map(id=>r.facts[id].value).toSorted((a,b)=>a.t-b.t);
  const citedTimes=card.fact_ids.filter(id=>id.startsWith('cast.')).map(id=>r.facts[id].t);
  expect(citedTimes).toEqual(citedTimes.toSorted((a,b)=>a-b));
  let position=-1;
  for(const c of casts){const next=card.claim.text.indexOf(`at ${clock(c.t)}`,position+1);expect(next).toBeGreaterThan(position);position=next;}
 }
});
