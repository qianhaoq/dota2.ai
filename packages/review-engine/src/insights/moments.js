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
 const heroKey = p => STATIC_HEROES[p.hero_id]?.internalName;
 const focus = heroKey(player);
 const fact = (id, e, en, zhText) => {
  result.facts[id] = {id, kind:'entity', value:e, t:e.t, display:{en,zh:zhText,t:clock(e.t)},citation:'r1',source_path:[e.source_path,e.end_source_path].filter(Boolean).join('; ')};
  return id;
 };
 const add = (id, from, to, text, prompt, ids, kind) => out.push({id,kind,title:zh?'值得复看的片段':'Replay moment',status:'ok',time:{from,to},claim:{text,slots:text,phrasing:'template'},prompt,fact_ids:ids,metrics:[],citations:['r1'],evidence:{kind:'death_timeline',highlight:[from/60,to/60],markers:ids,moments:[]},baseline:null,target:null,data_gap:null});
 for (const [index,d] of result.deaths.entries()) {
  if (!d.killer && !d.inflictor) continue;
  const ids = [d.fact_id];
  let from = d.t, to = d.t;
  // Five seconds is only a collection horizon. Each cast must independently
  // share an actor, target or inflictor with this death in the same artifact.
  for (const [pi,p] of players.entries()) for (const [ci,c] of (p.ability_cast_log ?? []).entries()) {
   if (!Number.isFinite(c.t) || Math.abs(c.t-d.t)>5) continue;
   const actor = heroKey(p);
   const killer = d.killer?.startsWith('npc_dota_') ? d.killer : d.killer ? `npc_dota_hero_${d.killer}` : null;
   if (!(actor && (actor===focus || actor===killer)) && !(c.target && (c.target===focus || c.target===killer)) && !(d.inflictor && c.key===d.inflictor)) continue;
   const label = l => `${clock(c.t)} · ${evidenceName(actor,l)} · ${evidenceName(c.key,l)}${c.target ? ' → '+evidenceName(c.target,l) : ''}`;
   ids.push(fact(`cast.death.${index}.${pi}.${ci}`,c,label('en'),label('zh')));
   from=Math.min(from,c.t);to=Math.max(to,c.t);
  }
  const text = `${clock(d.t)} · ${zh?'死亡记录':'Death recorded'}${d.killer?' · '+evidenceName(d.killer,lang):''}${d.inflictor?' · '+evidenceName(d.inflictor,lang):''}`;
  add(`death.${index+1}`,from,to,text,zh?'列出同一片段中有身份字段关联的记录；这些记录不判定死亡原因或操作对错。':'Identity-linked records in this window do not establish causation or grade the play.',ids,ids.length>1?'ability_into_death':'notable_death');
 }
 for (const [index,u] of (player.item_use_log ?? []).filter(u=>u.key==='black_king_bar').entries()) {
  if (!Number.isFinite(u.t) || !Number.isFinite(u.ended_at) || u.ended_at<u.t || !u.end_source_path) continue;
  const label = l => `${clock(u.t)}–${clock(u.ended_at)} · ${itemName(u.key,l)}`;
  const id=fact(`use.bkb.${index+1}`,u,label('en'),label('zh'));
  add(`bkb.${index+1}`,u.t,u.ended_at,label(lang),zh?'已记录免疫开始与结束；不能据此判断开早或开晚。':'Recorded immunity start and end do not establish early or late use.',[id],'item_window');
 }
 return out.sort((a,b)=>a.time.from-b.time.from);
}
