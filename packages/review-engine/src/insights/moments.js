/** Replay moments cite linked observations, never verdicts about causality. */
import { formatBuildingName } from '../objectiveLabels.js';
import { STATIC_HEROES } from '../staticHeroes.js';
import dictionary from '../../data/display-names.json' with { type: 'json' };

export const clock = t => {const sign=t<0?'-':'';const s=Math.abs(Number(t))||0;return `${sign}${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;};
const names = {
 npc_dota_wraith_king_skeleton_warrior:['Wraith King skeleton','冥魂大帝骨卫骷髅'],
};

/** Unknown ids never become invented localized names. Missing ZH uses official EN. */
export function itemName(key, lang) {
 const entry = dictionary.items[String(key).replace(/^item_/, '')];
 return entry?.[lang] ?? entry?.en ?? (lang === 'zh' ? '未知物品' : 'Unknown item');
}
export function evidenceName(key, lang) {
 const zh = lang === 'zh';
 if (!key) return zh ? '未知单位或技能' : 'Unknown unit or ability';
 if (names[key]) return names[key][zh ? 1 : 0];
 const hero = Object.values(STATIC_HEROES).find(h => h.internalName === key || h.internalName === `npc_dota_hero_${key}` || h.internalSlug === key);
 if (hero) return zh ? hero.nameZh : hero.nameEn;
 if (/tower|rax|fort|goodguys|badguys/.test(key)) return formatBuildingName(key, lang);
 if (key.startsWith('npc_dota_neutral_')) return zh ? '中立生物' : 'Neutral creep';
 const entry = dictionary.abilities[key];
 if (entry) return entry[lang] ?? entry.en;
 if (dictionary.items[key] || key.startsWith('item_')) return itemName(key, lang);
 return zh ? '未知单位或技能' : 'Unknown unit or ability';
}
export function buildMoments(result, player, lang, players = [player]) {
 const zh = lang === 'zh', out = [];
 const normalize = key => key?.replace(/^npc_dota_hero_/, '');
 const heroKey = p => STATIC_HEROES[p.hero_id]?.internalName;
 const focus = heroKey(player);
 const same = (a,b) => !!a && !!b && normalize(a) === normalize(b);
 const known = new Set(players.map(heroKey).filter(Boolean).map(normalize));
 // Targets must already exist elsewhere in this artifact, never be invented.
 for (const p of players) for (const e of [...(p.kills_log ?? []), ...(p.deaths_log ?? [])]) if(e.key) known.add(normalize(e.key));
 // Conservative area-cast classification; unknown untargeted spells are omitted.
 const areaCasts = new Set(['earthshaker_echo_slam','juggernaut_blade_fury','morphling_waveform','tidehunter_ravage','enigma_black_hole','crystal_maiden_freezing_field']);
 const excluded = /^(invoker_(quas|wex|exort|invoke|forge_spirit)|morphling_morph_(str|agi))$/;
 const casts = players.flatMap((p,pi)=>(p.ability_cast_log ?? []).map((c,ci)=>({ ...c, actor:heroKey(p), owner:p, pi, ci }))).filter(c=>!excluded.test(c.key));
 const linked = (c,d) => same(c.target,focus) || !!(d?.inflictor && c.key===d.inflictor) || (same(c.actor,focus) && !!c.target && known.has(normalize(c.target)));
 const fact = (id,e,label) => {
  const {owner,pi,ci,...event}=e;
  result.facts[id]={id,kind:'entity',value:event,t:e.t,display:{en:label('en'),zh:label('zh'),t:clock(e.t)},citation:'r1',source_path:[e.source_path,e.end_source_path].filter(Boolean).join('; ')};
  return id;
 };
 const castText = (c,l) => `${clock(c.t)} · ${evidenceName(c.actor,l)} · ${evidenceName(c.key,l)}${c.target ? ' → '+evidenceName(c.target,l) : ''}`;
 const add = (id,kind,from,to,base,primary,support=[]) => {
  const ids=[...base.ids];
  // Untargeted inflictor casts are already named on the death fact; do not
  // add a second undecorated cast line in the evidence list.
  for(const c of [...primary,...support].sort((a,b)=>a.t-b.t)) {
   if(base.inflictor && c.key===base.inflictor && !c.target) continue;
   const unproven=support.includes(c);
   ids.push(fact(`cast.${id}.${c.pi}.${c.ci}`,c,l=>castText(c,l)+(unproven?(l==='zh'?' · 附近时间的施法，未证明命中':' · cast in the nearby window; a hit is not proven'):'')));
  }

  for(const [ki,k] of (player.kills_log ?? []).entries()) {
   if(!primary.some(c=>same(c.actor,focus)&&same(c.target,k.key)&&k.time>=c.t&&k.time<=to)) continue;
   ids.push(fact(`kill.${id}.${ki}`,{...k,t:k.time},l=>`${clock(k.time)} · ${l==='zh'?'存在击杀记录':'A kill record exists'} · ${evidenceName(k.key,l)}`));
  }
  // Only final cited facts define the span; omitted inflictor casts cannot
  // contribute a clock. Nearby untargeted support is evidence, not a hit claim.
  const times=ids.flatMap(id=>{
   const f=result.facts[id];
   const t=f.t ?? f.value?.t ?? result.deaths.find(d=>d.fact_id===id)?.t;
   return [t,f.value?.ended_at].filter(Number.isFinite);
  });
  from=Math.min(...times);to=Math.max(...times);
  const clauses=[];
  for(const c of primary) {
   if(!c.target || !ids.includes(`cast.${id}.${c.pi}.${c.ci}`)) continue;
   const actor=evidenceName(c.actor,lang), target=evidenceName(c.target,lang), ability=evidenceName(c.key,lang);
   clauses.push({t:c.t,text:zh?`${actor}${clock(c.t)}对${target}施放${ability}`:`${actor} cast ${ability} on ${target} at ${clock(c.t)}`});
  }
  for(const factId of ids) {
   const d=result.deaths.find(d=>d.fact_id===factId);
   if(d) {
    const killer=d.killer?evidenceName(d.killer,lang):(zh?'未知单位':'an unknown unit');
    const ability=d.inflictor?evidenceName(d.inflictor,lang):null;
    clauses.push({t:d.t,text:zh?`${evidenceName(focus,lang)}${clock(d.t)}被${killer}${ability?'以'+ability:''}击杀`:`${evidenceName(focus,lang)} was killed by ${killer}${ability?' with '+ability:''} at ${clock(d.t)}`});
   } else if(factId.startsWith('kill.')) {
    const k=result.facts[factId].value;
    clauses.push({t:k.t,text:zh?`${clock(k.t)}对${evidenceName(k.key,lang)}有击杀记录`:`a kill on ${evidenceName(k.key,lang)} was recorded at ${clock(k.t)}`});
   }
  }
  clauses.sort((a,b)=>a.t-b.t);
  const sentence=clauses.map((c,i)=>(i?(clauses[i-1].t<c.t?(zh?'，随后':', then '):(zh?'，':', ')):'')+c.text).join('');
  const use=kind==='item_window'?result.facts[base.ids[0]].value:null;
  const text=(use?(zh?`${clock(use.t)}–${clock(use.ended_at)}使用${itemName(use.key,lang)}期间，`:`While using ${itemName(use.key,lang)} from ${clock(use.t)}–${clock(use.ended_at)}, `):'')+sentence+(zh?'。':'.');
  const death=result.deaths.find(d=>base.ids.includes(d.fact_id));
  const first=primary.toSorted((a,b)=>a.t-b.t).find(c=>c.target && ids.includes(`cast.${id}.${c.pi}.${c.ci}`));
  const ability=first?evidenceName(first.key,lang):null;
  const inflictor=death?.inflictor?evidenceName(death.inflictor,lang):null;
  const enemyAbilities=[...new Set(primary.toSorted((a,b)=>a.t-b.t).filter(c=>same(c.target,focus)&&!same(c.actor,focus)).map(c=>evidenceName(c.key,lang)))].join(zh?'、':' / ');
  const title=use
   ? (zh?`使用${itemName(use.key,lang)}期间${enemyAbilities?'被施放'+enemyAbilities:'有死亡记录'}`:`${enemyAbilities?enemyAbilities+' casts':'Death recorded'} during ${itemName(use.key,lang)}`)
   : (zh?`${ability??evidenceName(focus,lang)}${first&&first.t<death?.t?'后':'与'}${inflictor?'被'+inflictor+'击杀':'被'+evidenceName(death?.killer,lang)+'击杀'}`:`${ability??evidenceName(focus,lang)}${first&&first.t<death?.t?' followed by':' and'} death ${inflictor?'to '+inflictor:'by '+evidenceName(death?.killer,lang)}`);
  out.push({id,kind,title,status:'ok',time:{from,to},claim:{text,slots:text,phrasing:'template'},fact_ids:ids,metrics:[],citations:['r1'],evidence:{kind:'death_timeline',highlight:[from/60,to/60],markers:ids,moments:[]},baseline:null,target:null,data_gap:null});
 };
 for(const [index,d] of result.deaths.entries()) {
  const nearby=casts.filter(c=>Number.isFinite(c.t)&&Math.abs(c.t-d.t)<=5);
  const primary=nearby.filter(c=>linked(c,d) && (!c.source_path || c.source_path!==result.facts[d.fact_id]?.source_path));
  // The killing ability alone is one event, already shown in the death list.
  const independent=primary.filter(c=>!(d.inflictor && c.key===d.inflictor));
  if(!independent.length) continue;
  const seen=new Set();
  const support=nearby.filter(c=>!primary.includes(c)&&same(c.actor,d.killer)&&!c.target&&areaCasts.has(c.key)&&!seen.has(c.key)&&seen.add(c.key));
  add(`death.${index+1}`,'ability_into_death',Math.min(d.t,...primary.map(c=>c.t),...support.map(c=>c.t)),Math.max(d.t,...primary.map(c=>c.t),...support.map(c=>c.t)),{ids:[d.fact_id],inflictor:d.inflictor},primary,support);
 }
 for(const [index,u] of (player.item_use_log ?? []).filter(u=>u.key==='black_king_bar').entries()) {
  if(!Number.isFinite(u.t)||!Number.isFinite(u.ended_at)||u.ended_at<u.t||!u.end_source_path) continue;
  const primary=casts.filter(c=>Number.isFinite(c.t)&&c.t>=u.t&&c.t<=u.ended_at&&linked(c)&&c.source_path!==u.source_path);
  const enemy=primary.some(c=>same(c.target,focus)&&Number.isInteger(c.owner.player_slot)&&Number.isInteger(player.player_slot)&&(c.owner.player_slot<128)!==(player.player_slot<128));
  const deaths=result.deaths.filter(d=>d.t>=u.t&&d.t<=u.ended_at);
  if(!enemy&&!deaths.length) continue;
  const label=l=>`${clock(u.t)}–${clock(u.ended_at)} · ${itemName(u.key,l)}`;
  const id=fact(`use.bkb.${index+1}`,u,label);
  add(`bkb.${index+1}`,'item_window',u.t,u.ended_at,{ids:[id,...deaths.map(d=>d.fact_id)]},primary);
 }
 return out.sort((a,b)=>a.time.from-b.time.from);
}
