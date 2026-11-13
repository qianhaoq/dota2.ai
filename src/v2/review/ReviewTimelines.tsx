import React from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { heroDisplayName } from './heroDisplayName';
import { surface } from './ConversationCards';
import type { Review } from './types';
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const inflictors: Record<string, [string, string]> = { pudge_meat_hook:['Meat Hook','肉钩'], pudge_dismember:['Dismember','肢解'], necrolyte_reapers_scythe:["Reaper’s Scythe",'死神镰刀'], skeleton_king_bone_guard:['Bone Guard','骨卫'] };
const items: Record<string, [string, string]> = { black_king_bar: ['Black King Bar', '黑皇杖'], phase_boots: ['Phase Boots', '相位鞋'], spirit_vessel: ['Spirit Vessel', '魂之灵瓮'], urn_of_shadows: ['Urn of Shadows', '影之灵龛'] };
export default function ReviewTimelines({ review }: { review: Review }) {
 const { lang } = useI18n(); const zh = lang === 'zh';
 return <>
 {!!review.deaths?.length && <section className={surface}><h2>{zh ? '死亡记录' : 'Deaths'}</h2><ol className="space-y-[8px]">{review.deaths.map((d, i) => <li key={i}><time>{clock(d.t)}</time>{' · '}{d.killer === 'npc_dota_wraith_king_skeleton_warrior' ? (zh ? '冥魂大帝骨卫骷髅' : 'Wraith King skeleton') : d.killer ? heroDisplayName(d.killer, lang) : (zh ? '击杀者待核实' : 'Killer unverified')}{d.inflictor && inflictors[d.inflictor] ? ` · ${inflictors[d.inflictor][zh ? 1 : 0]}` : ''}</li>)}</ol></section>}
 {!!review.purchases?.some(p => p.key_item || items[p.item]) && <section className={surface}><h2>{zh ? '关键购买记录' : 'Key purchases'}</h2><p>{zh ? '购买不代表送达或使用；使用时间需单独核实；若已核实，见上方片段。' : 'Purchases are not delivery or use times. Use times need separate evidence; verified uses appear in the moments above.'}</p><ul className="space-y-[8px]">{review.purchases.filter(p => p.key_item || items[p.item]).map((p,i) => <li key={i}>{clock(p.t)}{' · '}{items[p.item]?.[zh ? 1 : 0] ?? p.item.replaceAll('_',' ')}</li>)}</ul></section>}
 {!!review.data_gaps.length && <details className={surface}><summary className="min-h-[44px] cursor-pointer">{zh ? '本局还缺什么' : 'What remains unverified'}</summary><ul>
 {(!review.series.radiant_gold_adv?.length || !review.series.radiant_xp_adv?.length) && <li>{zh ? '没有可校准的经济或经验曲线，因此不画缺失的曲线。净资产不等于累计获得金钱。' : 'Missing calibrated gold or XP series are not plotted. Net worth is not earned gold.'}</li>}
 {review.data_gaps.some(g => /death|position|ability|playerstats/.test(g.topic)) && <li>{zh ? '交战时血量、站位和技能命中仍需结合录像核实。' : 'Health, positions and spell hits during fights need replay review.'}</li>}
 {review.data_gaps.some(g => /item|build|purchase/.test(g.topic)) && <li>{zh ? '购买、送达和实际使用需要分别核对。' : 'Verify purchase, delivery and actual use separately.'}</li>}
 </ul></details>}
 </>;
}
