import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildReview} from '../src/buildReview.js';
import {applyReplayArtifact} from '../src/replay.js';
import {buildMainline} from '../src/review/mainline.js';
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
 // Mainline structure: overview first, then 3–5 decision windows. A short
 // stomp can honestly carry fewer grounded frames; the overview flags it
 // instead of the engine padding a death or a swing window.
 expect(r.insights[0].id).toBe('review_overview');
 expect(r.insights[0].kind).toBe('review_overview');
 const windows=r.insights.filter(i=>i.kind==='review_window');
 expect(windows.length).toBeGreaterThanOrEqual(match===9088239359?2:3);
 expect(windows.length).toBeLessThanOrEqual(5);
 if(match===9088239359)expect(r.insights[0].data_gap).toBe('mainline_windows_fewer_than_three');
 else expect(r.insights[0].data_gap).toBeNull();
 // Death- and swing-centred framing is gone, and windows never carry an
 // evaluation section: unsupported judgments are omitted, not softened.
 for(const w of windows){
  expect(w.title).not.toMatch(/阵亡与后续|death and aftermath|优势序列骤变|advantage swing/i);
  expect(w.sections?.some(s=>s.label_key==='evaluation')).toBe(false);
  expect(w.title).not.toMatch(/阵亡|死亡窗口|death window/i);
 }
 expect(windows.map(w=>w.id)).toEqual(windows.map((w,i)=>`window.${i+1}`));
 expect(r.insights.every(i=>!i.id.startsWith('purchase.')&&i.kind!=='purchase_context')).toBe(true);
 // Purchases live in the appendix only: no window title, claim or section
 // enumerates purchases or purchase progress.
 for(const w of windows){
  expect(w.title+w.claim.text+(w.sections??[]).map(s=>s.text).join('')).not.toMatch(/此前已购入|窗口内装备进度|purchased so far|item progress|already purchased/);
 }
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
  // Phase overview deaths are the recorded list (what the death appendix
  // shows), never the linked-cast subset: laning holds five recorded deaths
  // before 15:00 (first 3:18), late game three (first 25:44).
  expect(r.insights[0].claim.text).toContain(lang==='zh'?'阵亡 5 次（首次 3:18':'5 deaths (first at 3:18');
  expect(r.insights[0].claim.text).toContain(lang==='zh'?'阵亡 3 次（首次 25:44':'3 deaths (first at 25:44');
  expect(r.insights[0].claim.text).not.toMatch(lang==='zh'?/阵亡 [12] 次（首次/:/ [12] deaths? \(first at/);
  expect(r.deaths.some(d=>d.inflictor==='pudge_meat_hook')).toBe(true);
  expect(r.insights.some(i=>i.fact_ids.some(id=>r.facts[id].value?.inflictor==='pudge_meat_hook'||r.facts[id].value?.key==='pudge_meat_hook'))).toBe(false);
  // Linked kill evidence (dismember, bone guard, reaper's scythe) stays reachable.
  for(const inf of ['pudge_dismember','skeleton_king_bone_guard'])expect(r.insights.some(i=>i.fact_ids.some(id=>r.facts[id].value?.inflictor===inf))).toBe(true);
  expect(r.insights.some(i=>i.fact_ids.some(id=>r.facts[id].value?.key==='necrolyte_reapers_scythe'))).toBe(true);
  // The item-timing window anchors on the linked use, not just the purchase:
  // the linked use.bkb fact is cited and the recorded interval is in the copy.
  const bkbWin=windows.find(w=>/黑皇杖|Black King Bar/.test(w.title));
  expect(bkbWin).toBeTruthy();
  expect(bkbWin.fact_ids.some(id=>id.startsWith('use.bkb.'))).toBe(true);
  expect(bkbWin.claim.text).toContain(lang==='zh'?'黑皇杖使用':'Black King Bar use');
  expect(bkbWin.claim.text).toContain('26:37');
 }
 if(match===9089115713){
  expect(copy).not.toMatch(/sniper|狙击手|冰霜新星|射火巫师/i);
  // Scoreboard K/D 9/1 survives into the overview; the single verified death
  // is Earthshaker's, without an invented inflictor.
  expect(r.insights[0].claim.text).toContain(lang==='zh'?'记分板 K/D 9/1，助攻 12':'scoreboard K/D 9/1, 12 assists');
  expect(r.insights[0].claim.text).toContain(lang==='zh'?'击杀记录 6 次':'6 recorded kills');
  const deathWin=windows.find(w=>w.fact_ids.includes('death.1'));
  expect(deathWin).toBeTruthy();
  expect(deathWin.claim.text).toContain(lang==='zh'?'撼地者':'Earthshaker');
  expect(r.facts['death.1'].value.inflictor).toBeUndefined();
  expect(deathWin.fact_ids.some(id=>r.facts[id].value?.key==='earthshaker_echo_slam')).toBe(true);
  // The early window stands on its own as kills-vs-conversion: six recorded
  // kills against zero *new* enemy structures taken inside the window (never
  // a whole-match cumulative zero), with the 12:50 tower named as a Dire
  // self-denial rather than a push and no purchase list in the body.
  const early=windows.find(w=>w.time.from<=345&&w.time.to>=925);
  expect(early).toBeTruthy();
  expect(early.title).toMatch(/击杀未转化为地图目标|kills without map conversion/);
  for(const t of ['5:44','6:33','9:15','12:00','12:14','14:43'])expect(early.claim.text).toContain(t);
  expect(early.claim.text).toContain(lang==='zh'?'本窗口内我方没有新增摧毁敌方建筑':'took no new enemy structure inside this window');
  expect(early.claim.text).not.toMatch(/摧毁的敌方建筑为 0 处|had taken 0 enemy structures/);
  const earlyCopy=early.title+early.claim.text+(early.sections??[]).map(s=>s.text).join('');
  if(lang==='zh')expect(earlyCopy).not.toMatch(/慧光|陨星锤|远行鞋|已购入|装备进度/);
  else expect(earlyCopy).not.toMatch(/Kaya|Meteor Hammer|Boots of Travel|already purchased|item progress/);
  expect(early.claim.text).toContain(lang==='zh'?'12:50 夜魇中路一塔由夜魇自己拆除，不计为我方推进':'Dire mid T1 tower at 12:50 was demolished by Dire itself, not counted as your team\'s push');
  // The mid window keeps an empty kill log honest: teammates' kills and smokes
  // are named as context, non-participation is never claimed, and losing the
  // match is not treated as evidence the mid-game choices were wrong.
  const mid=windows.find(w=>w.time.from<=930&&w.time.to>=2080);
  expect(mid).toBeTruthy();
  const midCopy=mid.claim.text+(mid.sections??[]).map(s=>s.text).join(' ');
  // A bucket fact an earlier consumer created is reused, not orphaned: the
  // window prints its starting advantage (bucket 15, ≈−4,167) and must cite it.
  expect(midCopy).toContain('-4,167');
  expect(mid.fact_ids).toContain('net_worth.adv.at.15');
  expect(midCopy).not.toMatch(/未参战|不在场|did not participate|not in the fight|should have (grouped|farmed)|本该|应当抱团|该去带线/);
  const gapNote=(mid.sections??[]).find(s=>s.label_key==='missing'&&/击杀日志为空|kill log is empty/.test(s.text));
  expect(gapNote).toBeTruthy();
  expect(gapNote.text).toContain(lang==='zh'?'队友有击杀记录':'teammates recorded');
  expect(gapNote.text).toContain(lang==='zh'?'使用雾':'smoke uses');
  expect((mid.sections??[]).some(s=>s.label_key==='comparable')).toBe(true);
  expect(midCopy).toContain(lang==='zh'?'输掉比赛本身不是中期决策有误的证据':'losing the match is not evidence those choices were wrong');
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
 // Synthesized 30 s samples: low mana across the whole span, so a sample
 // lands next to each promoted death (the practice evidence anchor) as well
 // as at the window starts carrying them (11:21 outer towers, 25:03 BKB).
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
  // The proof cites samples at the death anchors, never window starts.
  expect(condition).toContain(lang==='zh'?'阵亡时点附近':'next to the');
  for(const id of r.practice.items[0].fact_ids)expect(r.facts[id]).toBeTruthy();
  expect(r.practice.items[0].fact_ids.some(id=>id.startsWith('state.death.'))).toBe(true);
  expect(r.practice.items[0].fact_ids.some(id=>/^death\.\d+$/.test(id))).toBe(true);
 }
});
/** In-memory synthetic facts for direct buildMainline calls (no downloads). */
const synthMatch=()=>{
 const facts={};
 const objectives=[];
 const obj=(t,key,team)=>{
  const o={t,type:'building_kill',key,team:team===2?'radiant':'dire'};
  const id=`obj.${t}.${objectives.length}`;
  facts[id]={id,kind:'entity',value:o,t,display:{en:`${clock(t)}: ${key} destroyed by team ${team}`,zh:`${clock(t)}：${key} 被阵营 ${team} 摧毁`},citation:'r1',source_path:'objectives'};
  objectives.push({...o,fact_id:id});
 };
 const death=(i,t,killer)=>{
  const id=`death.${i}`;
  facts[id]={id,kind:'entity',value:{t,killer},t,display:{en:`${clock(t)} · Death · ${killer}`,zh:`${clock(t)} · 死亡 · ${killer}`},citation:'r1',source_path:'deaths_log'};
  return {t,killer,fact_id:id};
 };
 return {facts,objectives,obj,death};
};
it('never claims a whole-match zero-takes conversion when a take predates the window',()=>{
 const m=synthMatch();
 // Radiant Invoker already took Dire top T1 at 1:40, then a 3-kill cluster
 // with no in-window take: the theme is "no NEW conversion in this stretch".
 m.obj(100.2,'npc_dota_badguys_tower1_top',2);
 const focus={hero_id:74,player_slot:0,kills_log:[
  {time:600.4,key:'npc_dota_hero_lion'},
  {time:650.2,key:'npc_dota_hero_pudge'},
  {time:700.1,key:'npc_dota_hero_slark'},
 ]};
 const {insights}=buildMainline({facts:m.facts,deaths:[]},{duration:900,players:[focus]},focus,[focus],'zh',m.objectives,[]);
 const win=insights.find(i=>i.kind==='review_window'&&/击杀未转化为地图目标/.test(i.title));
 expect(win).toBeTruthy();
 expect(win.claim.text).toContain('本窗口内我方没有新增摧毁敌方建筑');
 expect(win.claim.text+(win.sections??[]).map(s=>s.text).join('')).not.toMatch(/摧毁的敌方建筑为 0 处|had taken 0 enemy structures/);
 const known=(win.sections??[]).find(s=>s.label_key==='known');
 // The pre-window take IS known at the decision time — printed, not erased.
 expect(known.text).toContain('10:00 前我方摧毁对方建筑 1 处');
 const comparable=(win.sections??[]).find(s=>s.label_key==='comparable');
 expect(comparable.text).toContain('窗口开始前全场已推进 1 处');
});
it('keeps practice insufficient without hero-state samples, even with BKB and death windows',()=>{
 const m=synthMatch();
 // Dire Night Stalker: BKB bought at 1:40 and never used; two own-structure
 // loss clusters at 5:00/5:50 and 10:00/10:50, each followed by a promoted
 // death. The BKB checklist pattern matches on purchase logs alone — it must
 // still be insufficient because no reusable state samples exist.
 m.obj(300.5,'npc_dota_badguys_tower1_top',2);
 m.obj(350.2,'npc_dota_badguys_tower1_bot',2);
 m.obj(600.4,'npc_dota_badguys_tower2_top',2);
 m.obj(650.1,'npc_dota_badguys_tower2_bot',2);
 const deaths=[m.death(1,360.3,'pudge'),m.death(2,660.2,'lion')];
 const focus={hero_id:60,player_slot:132,purchase_log:[{time:100,key:'black_king_bar'}],item_use_log:[],kills_log:[]};
 m.facts['item.first.black_king_bar']={id:'item.first.black_king_bar',kind:'time',value:100,t:100,display:{en:'Black King Bar at 1:40',zh:'1:40 购入黑皇杖'},citation:'r1',source_path:'purchase_log'};
 const {insights,practice}=buildMainline({facts:m.facts,deaths},{duration:900,players:[focus]},focus,[focus],'zh',m.objectives,[{fact_ids:['death.1','death.2']}]);
 const windows=insights.filter(i=>i.kind==='review_window');
 expect(windows).toHaveLength(2);
 expect(windows.every(w=>w.fact_ids.some(id=>/^death\.\d+$/.test(id)))).toBe(true);
 expect(practice).toMatchObject({status:'insufficient',items:[]});
 expect(practice.note).toBeTruthy();
});
it('does not prove low-mana practice from window-start samples when death-adjacent mana is high',()=>{
 const a=JSON.parse(readFileSync('data/replay-facts/9080127650.json'));
 // 17% mana at the two window starts (11:21, 25:03) but 98% at the actual
 // deaths (14:55, 25:44): the start-of-window samples must not stand in for
 // the fight-anchor samples.
 const row=(t,mana)=>({t,hero:'night_stalker',team:3,x:0,y:0,hp:900,max_hp:1200,mana,max_mana:600,level:14,life_state:1,player_index:4});
 const samples=[row(681,100),row(895,590),row(1503,100),row(1544,590)];
 const raw={match_id:a.match_id,players:a.players};
 const merged={...applyReplayArtifact(raw,a),hero_states:{samples,sampling:'planted window-start vs death-anchor samples',visibility:'null_in_trace',truncated:false,anchors:[]}};
 const r=buildReview(merged,{heroId:60,lang:'zh',fetchedAt:a.fetched_at});
 expect(validateReview(r)).toEqual({ok:true,errors:[]});
 expect(r.practice).toMatchObject({status:'insufficient',items:[]});
});
it('does not double-count one death across overlapping windows into proven low-mana practice',()=>{
 const m=synthMatch();
 // Reviewer repro: Dire Night Stalker; a linked-use BKB window 500–809 and an
 // objective-loss window 600–900 partially overlap; both contain the ONLY
 // promoted death death.1 @ 650, and the only focus state sample sits at 650
 // with mana 100/600 (17%). Two windows citing one death are one observation —
 // never a "repeated pattern".
 m.facts['item.first.black_king_bar']={id:'item.first.black_king_bar',kind:'time',value:560,t:560,display:{en:'Black King Bar at 9:20',zh:'9:20 购入黑皇杖'},citation:'r1',source_path:'purchase_log'};
 m.facts['use.bkb.1']={id:'use.bkb.1',kind:'entity',value:{t:800,ended_at:809},t:800,display:{en:'8:00–8:29 Black King Bar use',zh:'8:00–8:29 黑皇杖使用（记录区间）'},citation:'r1',source_path:'item_use_log'};
 m.obj(600,'npc_dota_badguys_tower2_top',2);
 m.obj(700,'npc_dota_badguys_tower2_bot',2);
 m.obj(800,'npc_dota_badguys_tower3_top',2);
 m.obj(900,'npc_dota_badguys_tower3_bot',2);
 const deaths=[m.death(1,650,'pudge')];
 const focus={hero_id:60,player_slot:132,purchase_log:[{time:560,key:'black_king_bar'}],item_use_log:[{t:800,ended_at:809,key:'black_king_bar',end_source_path:'end'}],kills_log:[]};
 const raw={duration:1000,players:[focus],hero_states:{samples:[{t:650,hero:'night_stalker',team:3,x:100,y:100,hp:500,max_hp:1000,mana:100,max_mana:600,level:12,life_state:1}],sampling:'synthesized single sample for the overlap test',visibility:'null_in_trace',truncated:false,anchors:[]}};
 const {insights,practice}=buildMainline({facts:m.facts,deaths},raw,focus,[focus],'zh',m.objectives,[{fact_ids:['death.1']}]);
 const windows=insights.filter(i=>i.kind==='review_window');
 // The overlap itself stays (window selection is not redesigned here): both
 // frames exist and both carry the shared death as execution evidence.
 expect(windows.map(w=>w.time)).toEqual([{from:500,to:809},{from:600,to:900}]);
 expect(windows.every(w=>w.fact_ids.includes('death.1'))).toBe(true);
 // One independent death cannot ground a repeated pattern.
 expect(practice).toMatchObject({status:'insufficient',items:[]});
});
it('does not prove the BKB checklist from one death shared by overlapping windows',()=>{
 const m=synthMatch();
 // BKB bought at 1:40 and never used; a kills window 610–681 overlaps a loss
 // stretch 500–800; both contain the only promoted death death.1 @ 655. The
 // sample there is healthy-mana, so only the unused-BKB branch can fire — and
 // it must not, because there is only one independent death.
 m.facts['item.first.black_king_bar']={id:'item.first.black_king_bar',kind:'time',value:100,t:100,display:{en:'Black King Bar at 1:40',zh:'1:40 购入黑皇杖'},citation:'r1',source_path:'purchase_log'};
 m.obj(500,'npc_dota_badguys_tower1_top',2);
 m.obj(600,'npc_dota_badguys_tower1_bot',2);
 m.obj(700,'npc_dota_badguys_tower2_top',2);
 m.obj(800,'npc_dota_badguys_tower2_bot',2);
 const deaths=[m.death(1,655,'lion')];
 const focus={hero_id:60,player_slot:132,purchase_log:[{time:100,key:'black_king_bar'}],item_use_log:[],kills_log:[
  {time:610,key:'npc_dota_hero_lion'},{time:650,key:'npc_dota_hero_pudge'},{time:680,key:'npc_dota_hero_slark'},
 ]};
 const raw={duration:1000,players:[focus],hero_states:{samples:[{t:655,hero:'night_stalker',team:3,x:0,y:0,hp:900,max_hp:1200,mana:500,max_mana:600,level:14,life_state:1}],sampling:'synthesized single healthy-mana sample for the overlap test',visibility:'null_in_trace',truncated:false,anchors:[]}};
 const {insights,practice}=buildMainline({facts:m.facts,deaths},raw,focus,[focus],'zh',m.objectives,[{fact_ids:['death.1']}]);
 const windows=insights.filter(i=>i.kind==='review_window');
 expect(windows.map(w=>w.time)).toEqual([{from:500,to:800},{from:610,to:680}]);
 expect(windows.every(w=>w.fact_ids.includes('death.1'))).toBe(true);
 expect(practice).toMatchObject({status:'insufficient',items:[]});
});
it('still proves practice when overlapping windows carry independent deaths',()=>{
 const m=synthMatch();
 // Positive control: the same BKB/loss overlap, but each window carries its
 // OWN promoted death with its own low-mana sample (10:50 and 14:10). Partial
 // overlap is not the crime — double-counting one death is.
 m.facts['item.first.black_king_bar']={id:'item.first.black_king_bar',kind:'time',value:560,t:560,display:{en:'Black King Bar at 9:20',zh:'9:20 购入黑皇杖'},citation:'r1',source_path:'purchase_log'};
 m.facts['use.bkb.1']={id:'use.bkb.1',kind:'entity',value:{t:800,ended_at:809},t:800,display:{en:'8:00–8:29 Black King Bar use',zh:'8:00–8:29 黑皇杖使用（记录区间）'},citation:'r1',source_path:'item_use_log'};
 m.obj(660,'npc_dota_badguys_tower2_top',2);
 m.obj(780,'npc_dota_badguys_tower2_bot',2);
 m.obj(900,'npc_dota_badguys_tower3_top',2);
 const deaths=[m.death(1,650,'pudge'),m.death(2,850,'lion')];
 const focus={hero_id:60,player_slot:132,purchase_log:[{time:560,key:'black_king_bar'}],item_use_log:[{t:800,ended_at:809,key:'black_king_bar',end_source_path:'end'}],kills_log:[]};
 const raw={duration:1000,players:[focus],hero_states:{samples:[
  {t:650,hero:'night_stalker',team:3,x:100,y:100,hp:500,max_hp:1000,mana:100,max_mana:600,level:12,life_state:1},
  {t:850,hero:'night_stalker',team:3,x:120,y:120,hp:480,max_hp:1000,mana:90,max_mana:600,level:14,life_state:1},
 ],sampling:'synthesized per-death samples for the overlap control',visibility:'null_in_trace',truncated:false,anchors:[]}};
 const {insights,practice}=buildMainline({facts:m.facts,deaths},raw,focus,[focus],'zh',m.objectives,[{fact_ids:['death.1','death.2']}]);
 const windows=insights.filter(i=>i.kind==='review_window');
 expect(windows.map(w=>w.time)).toEqual([{from:500,to:809},{from:660,to:900}]);
 expect(windows[0].fact_ids.includes('death.1')).toBe(true);
 expect(windows[1].fact_ids.includes('death.2')).toBe(true);
 expect(practice.status).toBe('proven');
 expect(practice.items.length).toBeGreaterThanOrEqual(1);
 expect(practice.items[0].condition).toContain('10:50');
 expect(practice.items[0].condition).toContain('14:10');
 // Each independent death is cited exactly once.
 expect(practice.items[0].fact_ids).toEqual([...new Set(practice.items[0].fact_ids)]);
 for(const id of ['death.1','death.2'])expect(practice.items[0].fact_ids.filter(x=>x===id)).toHaveLength(1);
});
it('cites each death once when overlapping windows prove the unused-BKB pattern',()=>{
 const m=synthMatch();
 // Positive control for the checklist branch: BKB unused, two overlapping
 // windows, two INDEPENDENT anchored deaths (6:55 shared, 12:40 only in the
 // wider frame). The pattern may prove, but never by repeating a death id.
 m.facts['item.first.black_king_bar']={id:'item.first.black_king_bar',kind:'time',value:100,t:100,display:{en:'Black King Bar at 1:40',zh:'1:40 购入黑皇杖'},citation:'r1',source_path:'purchase_log'};
 m.obj(500,'npc_dota_badguys_tower1_top',2);
 m.obj(600,'npc_dota_badguys_tower1_bot',2);
 m.obj(700,'npc_dota_badguys_tower2_top',2);
 m.obj(800,'npc_dota_badguys_tower2_bot',2);
 const deaths=[m.death(1,655,'lion'),m.death(2,760,'pudge')];
 const focus={hero_id:60,player_slot:132,purchase_log:[{time:100,key:'black_king_bar'}],item_use_log:[],kills_log:[
  {time:610,key:'npc_dota_hero_lion'},{time:650,key:'npc_dota_hero_pudge'},{time:680,key:'npc_dota_hero_slark'},
 ]};
 const raw={duration:1000,players:[focus],hero_states:{samples:[
  {t:655,hero:'night_stalker',team:3,x:0,y:0,hp:900,max_hp:1200,mana:500,max_mana:600,level:14,life_state:1},
  {t:760,hero:'night_stalker',team:3,x:0,y:0,hp:880,max_hp:1200,mana:480,max_mana:600,level:15,life_state:1},
 ],sampling:'synthesized healthy-mana samples for the overlap control',visibility:'null_in_trace',truncated:false,anchors:[]}};
 const {insights,practice}=buildMainline({facts:m.facts,deaths},raw,focus,[focus],'zh',m.objectives,[{fact_ids:['death.1','death.2']}]);
 const windows=insights.filter(i=>i.kind==='review_window');
 expect(windows.map(w=>w.time)).toEqual([{from:500,to:800},{from:610,to:680}]);
 const bkb=practice.items.find(it=>it.goal.includes('黑皇杖'));
 expect(bkb).toBeTruthy();
 expect(bkb.fact_ids).toEqual([...new Set(bkb.fact_ids)]);
 for(const id of ['death.1','death.2'])expect(bkb.fact_ids.filter(x=>x===id)).toHaveLength(1);
});
it('does not prove the unused-BKB pattern when the item-use log records in-window uses',()=>{
 const m=synthMatch();
 // Two NON-overlapping loss stretches (5:00–7:40, 18:20–21:00), each carrying
 // its own promoted death with a death-adjacent healthy-mana sample, BKB
 // bought at 1:40. The log records BKB uses at 5:10 and 18:30, but neither
 // interval holds an enemy cast or a death, so buildMoments never promotes
 // them: no use.bkb.* fact exists. "No promoted use" is not "no use" — the
 // checklist must not claim 窗口内无使用记录 over these windows.
 m.facts['item.first.black_king_bar']={id:'item.first.black_king_bar',kind:'time',value:100,t:100,display:{en:'Black King Bar at 1:40',zh:'1:40 购入黑皇杖'},citation:'r1',source_path:'purchase_log'};
 m.obj(300,'npc_dota_badguys_tower1_top',2);
 m.obj(400,'npc_dota_badguys_tower1_bot',2);
 m.obj(1100,'npc_dota_badguys_tower2_top',2);
 m.obj(1200,'npc_dota_badguys_tower2_bot',2);
 const deaths=[m.death(1,460,'lion'),m.death(2,1260,'pudge')];
 const focus={hero_id:60,player_slot:132,purchase_log:[{time:100,key:'black_king_bar'}],item_use_log:[
  {t:310,ended_at:319,key:'black_king_bar',end_source_path:'end'},{t:1110,ended_at:1119,key:'black_king_bar',end_source_path:'end'},
 ],kills_log:[]};
 const raw={duration:1500,players:[focus],hero_states:{samples:[
  {t:460,hero:'night_stalker',team:3,x:0,y:0,hp:900,max_hp:1200,mana:500,max_mana:600,level:14,life_state:1},
  {t:1260,hero:'night_stalker',team:3,x:0,y:0,hp:880,max_hp:1200,mana:480,max_mana:600,level:15,life_state:1},
 ],sampling:'synthesized healthy-mana samples for the recorded-use test',visibility:'null_in_trace',truncated:false,anchors:[]}};
 const build=()=>buildMainline({facts:m.facts,deaths},raw,focus,[focus],'zh',m.objectives,[{fact_ids:['death.1','death.2']}]);
 const withUses=build();
 const windows=withUses.insights.filter(i=>i.kind==='review_window');
 expect(windows.map(w=>w.time)).toEqual([{from:300,to:460},{from:1100,to:1260}]);
 // No window cites a promoted use fact — yet the log records uses inside both.
 expect(windows.every(w=>!w.fact_ids.some(id=>id.startsWith('use.bkb.')))).toBe(true);
 // Healthy mana means only the unused-BKB branch could fire; with recorded
 // in-window uses it must not, and the condition copy never appears.
 expect(withUses.practice).toMatchObject({status:'insufficient',items:[]});
 expect(JSON.stringify(withUses.practice)).not.toContain('窗口内无使用记录');
 // Control: identical windows with no recorded use at all still prove.
 focus.item_use_log=[];
 const noUse=build();
 expect(noUse.practice.status).toBe('proven');
 expect(noUse.practice.items.some(it=>it.goal.includes('黑皇杖'))).toBe(true);
});
it('titles an offensive high-ground push by structure tier, never as outer towers',()=>{
 const m=synthMatch();
 // Radiant focus takes Dire mid T3 then the melee barracks, no Ancient in the
 // window: an offensive high-ground stretch, not "enemy outer towers taken".
 m.obj(700.2,'npc_dota_badguys_tower3_mid',2);
 m.obj(760.4,'npc_dota_badguys_melee_rax_mid',2);
 const focus={hero_id:74,player_slot:0,kills_log:[]};
 for(const lang of ['zh','en']){
  const {insights}=buildMainline({facts:m.facts,deaths:[]},{duration:900,players:[focus]},focus,[focus],lang,m.objectives,[]);
  const win=insights.find(i=>i.kind==='review_window');
  expect(win).toBeTruthy();
  expect(win.title).not.toMatch(/外塔|outer towers/i);
  expect(win.title).toMatch(lang==='zh'?/高地/:/high ground/i);
 }
 // Control: a stretch that really is only T1/T2 takes keeps the outer title.
 const m2=synthMatch();
 m2.obj(300.1,'npc_dota_badguys_tower1_mid',2);
 m2.obj(420.6,'npc_dota_badguys_tower2_top',2);
 const focus2={hero_id:74,player_slot:0,kills_log:[]};
 const {insights:ins2}=buildMainline({facts:m2.facts,deaths:[]},{duration:900,players:[focus2]},focus2,[focus2],'zh',m2.objectives,[]);
 expect(ins2.find(i=>i.kind==='review_window').title).toMatch(/推掉敌方外塔/);
});
it.each([[9089115713,74,3025],[9080127650,60,1906],[9088239359,71,1227]])('keeps the Ancient in the last window under production integer duration %s (%s)',(match,heroId,duration)=>{
 const a=JSON.parse(readFileSync(`data/replay-facts/${match}.json`));
 const raw={match_id:match,duration,players:a.players};
 const r=buildReview(applyReplayArtifact(raw,a),{heroId,lang:'zh',fetchedAt:a.fetched_at});
 expect(validateReview(r)).toEqual({ok:true,errors:[]});
 const windows=r.insights.filter(i=>i.kind==='review_window');
 const last=windows[windows.length-1];
 const fort=a.objectives.find(o=>String(o.key??'').endsWith('_fort'));
 expect(fort).toBeTruthy();
 // The event horizon never falls below the last verified event: the Ancient
 // stays inside the last window's range, facts, claim and stage naming.
 expect(last.time.to).toBeGreaterThanOrEqual(fort.time);
 expect(last.fact_ids.some(id=>r.facts[id]?.value?.key===fort.key)).toBe(true);
 expect(last.claim.text).toContain(clock(fort.time));
 expect(last.title).toMatch(/高地攻坚至基地被破|高地失守至基地被破/);
 expect(last.title).not.toMatch(/外塔攻防同期|外塔反推|己方高地失守/);
});
it.each([[9088239359,71,1227],[9080127650,60,1906]])('cuts known structure counts at the window start, not the next whole minute (%s)',(match,heroId,duration)=>{
 const a=JSON.parse(readFileSync(`data/replay-facts/${match}.json`));
 const raw={match_id:match,duration,players:a.players};
 const r=buildReview(applyReplayArtifact(raw,a),{heroId,lang:'zh',fetchedAt:a.fetched_at});
 const windows=r.insights.filter(i=>i.kind==='review_window');
 // Spirit Breaker window 1 opens at 11:02 (662 s) — the 11:04 mid T1 had not
 // happened yet; Night Stalker's high-ground window opens at 26:37 (1597 s) —
 // the 26:45/26:50 barracks are not yet known either.
 const w=windows.find(w=>w.time.from===(match===9088239359?662:1597));
 expect(w).toBeTruthy();
 const known=(w.sections??[]).find(s=>s.label_key==='known');
 expect(known).toBeTruthy();
 expect(known.text).not.toMatch(/12:00 前|27:00 前/);
 if(match===9088239359)expect(known.text).toContain('11:02 前我方摧毁对方建筑 0 处');
 else expect(known.text).toContain('26:37 前我方失去建筑 6 处');
 // The decision-time clock on the fact is the actual cutoff (the window
 // start), and no post-start event leaks into the known layer.
 for(const bit of known.text.split('；'))expect(bit).not.toMatch(/11:04|26:45|26:50|27:25/);
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
