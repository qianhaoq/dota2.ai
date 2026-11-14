/** Replay candidates are observations plus questions, never verdicts about causality. */
import { formatBuildingName } from '../objectiveLabels.js';
import { STATIC_HEROES } from '../staticHeroes.js';

export const clock = t => {const sign=t<0?'-':'';const s=Math.abs(Number(t))||0;return `${sign}${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;};
const names = {
 npc_dota_wraith_king_skeleton_warrior:['Wraith King skeleton','冥魂大帝骨卫骷髅'],
 pudge_meat_hook:['Meat Hook','肉钩'],pudge_dismember:['Dismember','肢解'],necrolyte_reapers_scythe:["Reaper’s Scythe",'死神镰刀'],skeleton_king_bone_guard:['Bone Guard','骨卫'],
};
const titleCase = value => String(value).split(/[_\s]+/).filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
export function evidenceName(key, lang) {
  const zh = lang === 'zh';
  if (key == null || key === '') return zh ? '未知单位或技能' : 'Unknown unit or ability';
  if (names[key]) return names[key][zh ? 1 : 0];
  const text = String(key);
  const slug = text.startsWith('npc_dota_hero_') ? text.slice('npc_dota_hero_'.length) : text;
  const hero = Object.values(STATIC_HEROES).find(h => h.internalName === text || h.internalName === `npc_dota_hero_${text}` || h.internalSlug === slug);
  if (hero) return zh ? hero.nameZh : hero.nameEn;
  if (text.startsWith('npc_dota_hero_')) return titleCase(slug);
  if (text.startsWith('npc_dota_neutral_')) return zh ? '中立生物' : 'Neutral creep';
  if (text.includes('tower') || text.includes('rax') || text.includes('fort') || text.includes('goodguys') || text.includes('badguys')) {
    return formatBuildingName(text, lang);
  }
  if (text.startsWith('npc_dota_')) {
    const rest = titleCase(text.replace(/^npc_dota_/, ''));
    return zh ? `${rest || '未知单位'}` : (rest || 'Unknown unit');
  }
  if (text.startsWith('item_')) return titleCase(text.slice(5));
  if (text.includes('_') && !text.includes(' ')) return titleCase(text);
  return text;
}
export function buildMoments(result, player, lang) {
 const zh=lang==='zh', out=[], casts=player.ability_cast_log??[], uses=player.item_use_log??[];
 const fact=(id,e,text)=>{result.facts[id]={id,kind:'entity',value:e,t:e.t,display:{en:text,zh:text,t:clock(e.t)},citation:'r1',source_path:[e.source_path,e.end_source_path].filter(Boolean).join('; ')};return id;};
 const add=(id,from,to,text,prompt,ids,kind='ability_into_death')=>{const citations=[...new Set(ids.map(fid=>result.facts[fid]?.citation).filter(Boolean))];out.push({id,kind,title:zh?'值得复看的片段':'Replay moment',status:'ok',time:{from,to},claim:{text,slots:text,phrasing:'template'},prompt:`${clock(from)}–${clock(to)} · ${prompt}`,fact_ids:ids,metrics:[],citations:citations.length?citations:['r1'],evidence:{kind:'death_timeline',highlight:[from/60,to/60],markers:ids,moments:[]},baseline:null,target:null,data_gap:null});};
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
   const purchase=(player.purchase_log??[]).find(p=>p.key==='black_king_bar'&&p.time>d.t);
   if(purchase){const feast=casts.findLast(c=>c.key==='night_stalker_midnight_feast'&&c.target?.startsWith('npc_dota_neutral_')&&c.t<d.t&&d.t-c.t<60); const e={...purchase,t:purchase.time};add('skeleton_before_bkb',Math.max(0,d.t-44),purchase.time+7,zh?`${feast ? clock(feast.t)+' 对中立生物使用午夜盛宴；' : ''}${clock(d.t)} 被冥魂大帝骨卫骷髅击杀；${clock(purchase.time)} 买入黑皇杖。购买记录不能判断出装优劣。`:`${clock(d.t)}: killed by a Wraith King skeleton; Black King Bar purchased at ${clock(purchase.time)}. This does not grade the build.`,zh?'离开野区后发生了什么，队友当时在做什么？':'Review this interval: what happened after farming, and where were teammates?',[...(feast ? [fact('cast.feast_before_skeleton',feast,zh?'对中立生物使用午夜盛宴':'Used Midnight Feast on a neutral')] : []),d.fact_id,fact('purchase.bkb_after_skeleton',e,zh?'买入黑皇杖':'Purchased Black King Bar')]);}
  }
 }
 const bkb=uses.filter(u=>u.key==='black_king_bar'&&Number.isFinite(u.ended_at));
 const afterBkb=[...new Map(bkb.map(u=>result.deaths.find(d=>d.t>u.ended_at)).filter(Boolean).map(d=>[d.fact_id,d])).values()];
 if(bkb.length){const ids=bkb.map((u,i)=>fact(`use.bkb.${i+1}`,u,`${clock(u.t)}–${clock(u.ended_at)}`));add('bkb_windows',bkb[0].t,Math.max(bkb.at(-1).ended_at,...afterBkb.map(d=>d.t)),(zh?'黑皇杖实际开启窗口：':'Black King Bar use windows: ')+bkb.map(u=>`${clock(u.t)}–${clock(u.ended_at)}`).join('、')+(afterBkb.length ? (zh ? `。随后死亡：${afterBkb.map(d=>clock(d.t)).join('、')}，均在对应免疫结束后。` : `. Subsequent deaths: ${afterBkb.map(d=>clock(d.t)).join(', ')}, after the corresponding immunity ended.`) : '')+(zh?'不能据此判断开早或开晚。':' This does not establish early or late use.'),zh?'复看黑皇杖结束后的交战：退出路线和队友位置如何？':'Review fights after BKB ends: check exits and teammate positions.',[...ids,...afterBkb.map(d=>d.fact_id)]);}
 // Generic candidates use verified event times, without assuming spell hit quality.
 for (const [index,d] of result.deaths.entries()) {
  if(out.some(i=>i.fact_ids.includes(d.fact_id))) continue;
  const c=casts.filter(c=>Number.isFinite(c.t)&&c.t<=d.t&&d.t-c.t<=8).at(-1);
  const ids=c?[fact(`cast.before_death.${index}`,c,`${clock(c.t)} · ${evidenceName(c.key,lang)}`),d.fact_id]:[d.fact_id];
  ids.push(...Object.values(result.facts).filter(f=>f.id.startsWith('obj.')&&Number.isFinite(f.t)&&Math.abs(f.t-d.t)<=20).map(f=>f.id));
  add(!c&&index===0?'verified_death':`death.${index}`,c?Math.max(0,c.t-4):d.t,c?d.t+4:d.t,
   `${clock(d.t)} · ${zh?'死亡记录':'Death recorded'}${d.inflictor?' · '+evidenceName(d.inflictor,lang):''}`,
   zh?'待核实：复看这段时间的站位、视野和队友位置。':'Replay question: check position, vision and teammates in this interval.',ids,c?'ability_into_death':'notable_death');
 }
 for(const [index,u] of uses.entries()) {
  if(!Number.isFinite(u.t)||out.some(i=>i.fact_ids.some(id=>result.facts[id]?.value===u))) continue;
  const end=Number.isFinite(u.ended_at)?u.ended_at:u.t;
  const d=result.deaths.find(d=>d.t>end&&d.t-end<=120);
  add(`item.${index}`,u.t,d?.t??end,`${clock(u.t)}${end!==u.t?'–'+clock(end):''} · ${evidenceName(u.key,lang)}${d?' · '+clock(d.t)+' '+(zh?'死亡记录':'death recorded'):''}`,
   zh?'待核实：物品使用前后，交战和退出路线如何？':'Replay question: what happened during and after this item use?',[fact(`use.item.${index}`,u,`${evidenceName(u.key,lang)} · ${clock(u.t)}–${clock(end)}`),...(d?[d.fact_id]:[])],'item_window');
 }
 for(const [index,p] of (player.purchase_log??[]).entries()) {
  if(!Number.isFinite(p.time)||out.some(i=>i.fact_ids.some(id=>result.facts[id]?.t===p.time))) continue;
  add(`purchase.${index}`,p.time,p.time,`${clock(p.time)} · ${zh?'购买':'Purchased'} ${evidenceName(p.key,lang)}`,
   zh?'待核实：何时送达、何时使用？购买记录本身不评价出装。':'Replay question: when was it delivered and used? A purchase alone does not grade the build.',[fact(`purchase.context.${index}`,{...p,t:p.time},evidenceName(p.key,lang))],'purchase_context');
 }
 if(!out.length) {
  const timed=Object.values(result.facts).filter(f=>Number.isFinite(f.t));
  const event=timed.find(f=>f.id.startsWith('obj.')&&f.citation==='r1')??timed.find(f=>f.citation==='r1')??timed[0];
  const ids=event?[event.id]:Object.keys(result.facts).slice(0,1);
  const verified=ids.some(id=>result.facts[id]?.citation==='r1');
  add(verified?'verified_timeline':'recorded_timeline',event?.t??0,event?.t??0,verified?(zh?'本局已核实记录':'Verified match record'):(zh?'本局记录':'Match record'),zh?'待核实：复看一次关键目标前的准备。':'Replay question: review preparation before a key objective.',ids,'objective_context');
 }
 const preferred=['hook_death','void_dismember','darkness_scythe','skeleton_before_bkb','bkb_windows'];
 for(const i of out) { if(i.id==='skeleton_before_bkb')i.kind='purchase_context';if(i.id==='bkb_windows')i.kind='item_window';if(i.id==='verified_death')i.kind='notable_death'; }
 // Greedy coverage: completeness first, then distance from already selected windows.
 const selected=out.filter(i=>preferred.includes(i.id));
 const rest=out.filter(i=>!preferred.includes(i.id));
 while(selected.length<5&&rest.length) {
  rest.sort((a,b)=>{
   const score=i=>i.fact_ids.length+ (selected.length?Math.min(...selected.map(s=>Math.abs(s.time.from-i.time.from)))/600:0);
   return score(b)-score(a)||a.time.from-b.time.from;
  }); selected.push(rest.shift());
 }
 return selected.sort((a,b)=>a.time.from-b.time.from).slice(0,5);
}
