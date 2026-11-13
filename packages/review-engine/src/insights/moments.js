/** Replay candidates are observations plus questions, never verdicts about causality. */
export const clock = t => `${Math.floor(t/60)}:${String(Math.floor(t%60)).padStart(2,'0')}`;
const names = {
 npc_dota_wraith_king_skeleton_warrior:['Wraith King skeleton','冥魂大帝骨卫骷髅'],
 pudge_meat_hook:['Meat Hook','肉钩'],pudge_dismember:['Dismember','肢解'],necrolyte_reapers_scythe:["Reaper’s Scythe",'死神镰刀'],skeleton_king_bone_guard:['Bone Guard','骨卫'],
};
export function evidenceName(key, lang) { return names[key]?.[lang === 'zh' ? 1 : 0] ?? key; }
export function buildMoments(result, player, lang) {
 const zh=lang==='zh', out=[], casts=player.ability_cast_log??[], uses=player.item_use_log??[];
 const fact=(id,e,text)=>{result.facts[id]={id,kind:'entity',value:e,t:e.t,display:{en:text,zh:text,t:clock(e.t)},citation:'r1',source_path:[e.source_path,e.end_source_path].filter(Boolean).join('; ')};return id;};
 const add=(id,from,to,text,prompt,ids)=>out.push({id,title:zh?'值得复看的片段':'Replay moment',status:'ok',time:{from,to},claim:{text,slots:text,phrasing:'template'},prompt:`${clock(from)}–${clock(to)} · ${prompt}`,fact_ids:ids,metrics:[],citations:['r1'],evidence:{kind:'death_timeline',highlight:[from/60,to/60],markers:ids,moments:[]},baseline:null,target:null,data_gap:null});
 for(const d of result.deaths){
  const inf=d.inflictor;
  if(inf==='pudge_meat_hook' && !out.some(i=>i.id==='hook_death')) add('hook_death',d.t-4,d.t+6,zh?`${clock(d.t)} 被帕吉肉钩击杀。`:`${clock(d.t)}: killed by Pudge’s Meat Hook.`,zh?'复看钩子前后：当时站位、视野和队友在哪里？':'Review the hook: where were you, vision and teammates?',[d.fact_id]);
  if(inf==='pudge_dismember' && !out.some(i=>i.id==='void_dismember')) {
   const c=casts.findLast(c=>c.key==='night_stalker_void'&&c.target==='npc_dota_hero_slark'&&c.t<=d.t&&d.t-c.t<3);
   if(c)add('void_dismember',c.t-4,d.t+4,zh?`${clock(c.t)} 对斯拉克施放虚空；${clock(d.t)} 被帕吉肢解击杀。`:`${clock(c.t)}: cast Void on Slark; ${clock(d.t)}: killed by Pudge’s Dismember.`,zh?'练习复盘：逐帧记录两个事件间的位置和控制；先核实发生了什么，再评价选择。':'Review frame by frame: record positions and disables between these events before judging the choice.',[fact('cast.void_before_dismember',c,zh?'对斯拉克施放虚空':'Cast Void on Slark'),d.fact_id]);
  }
  if(inf==='necrolyte_reapers_scythe' && !out.some(i=>i.id==='darkness_scythe')){
   const c=casts.findLast(c=>c.key==='night_stalker_darkness'&&c.t<=d.t&&d.t-c.t<5);
   if(c)add('darkness_scythe',c.t,d.t+2,zh?`${clock(c.t)} 开启暗夜时分，约 ${Math.round(d.t-c.t)} 秒后被瘟疫法师死神镰刀击杀。`:`${clock(c.t)}: cast Darkness; killed by Necrophos’ Reaper’s Scythe about ${Math.round(d.t-c.t)} seconds later.`,zh?'开启大招后：开启大招时的血量、站位和敌方集火如何？':'Review the ult-to-death window: check health, position and enemy focus.',[fact('cast.darkness_before_scythe',c,zh?'开启暗夜时分':'Cast Darkness'),d.fact_id]);
  }
  if(d.killer==='npc_dota_wraith_king_skeleton_warrior' && !out.some(i=>i.id==='skeleton_before_bkb')){
   const purchase=player.purchase_log.find(p=>p.key==='black_king_bar'&&p.time>d.t);
   if(purchase){const feast=casts.findLast(c=>c.key==='night_stalker_midnight_feast'&&c.target?.startsWith('npc_dota_neutral_')&&c.t<d.t&&d.t-c.t<60); const e={...purchase,t:purchase.time};add('skeleton_before_bkb',Math.max(0,d.t-44),purchase.time+7,zh?`${feast ? clock(feast.t)+' 对中立生物使用午夜盛宴；' : ''}${clock(d.t)} 被冥魂大帝骨卫骷髅击杀；${clock(purchase.time)} 买入黑皇杖。购买记录不能判断出装优劣。`:`${clock(d.t)}: killed by a Wraith King skeleton; Black King Bar purchased at ${clock(purchase.time)}. This does not grade the build.`,zh?'离开野区后发生了什么，队友当时在做什么？':'Review this interval: what happened after farming, and where were teammates?',[...(feast ? [fact('cast.feast_before_skeleton',feast,zh?'对中立生物使用午夜盛宴':'Used Midnight Feast on a neutral')] : []),d.fact_id,fact('purchase.bkb_after_skeleton',e,zh?'买入黑皇杖':'Purchased Black King Bar')]);}
  }
 }
 const bkb=uses.filter(u=>u.key==='black_king_bar'&&Number.isFinite(u.ended_at));
 const afterBkb=bkb.map(u=>result.deaths.find(d=>d.t>u.ended_at)).filter(Boolean);
 if(bkb.length){const ids=bkb.map((u,i)=>fact(`use.bkb.${i+1}`,u,`${clock(u.t)}–${clock(u.ended_at)}`));add('bkb_windows',bkb[0].t,bkb.at(-1).ended_at,(zh?'黑皇杖实际开启窗口：':'Black King Bar use windows: ')+bkb.map(u=>`${clock(u.t)}–${clock(u.ended_at)}`).join('、')+(afterBkb.length ? (zh ? `。随后死亡：${afterBkb.map(d=>clock(d.t)).join('、')}，均在对应免疫结束后。` : `. Subsequent deaths: ${afterBkb.map(d=>clock(d.t)).join(', ')}, after the corresponding immunity ended.`) : '')+(zh?'不能据此判断开早或开晚。':' This does not establish early or late use.'),zh?'复看黑皇杖结束后的交战：退出路线和队友位置如何？':'Review fights after BKB ends: check exits and teammate positions.',[...ids,...afterBkb.map(d=>d.fact_id)]);}
 if (!out.length && result.deaths.length) {
  const d=result.deaths[0]; add('verified_death',d.t,d.t,zh?`${clock(d.t)} 有一条已核实的死亡记录，完整记录见下方。`:`${clock(d.t)}: a verified death is recorded; see the timeline below.`,zh?'建议复看死亡前后的站位、视野和队友位置。':'Review position, vision and teammates around this death.',[d.fact_id]);
 }
 return out;
}
