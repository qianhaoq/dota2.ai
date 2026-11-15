import React from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { heroDisplayName } from './heroDisplayName';
import { surface } from './ConversationCards';
import type { Review } from './types';
import { formatMatchClock } from '../evidence/labels';
import { evidenceName } from '../../../packages/review-engine/src/insights/moments.js';
import { itemDisplayName } from '../evidence/itemNames';
const clock = formatMatchClock;
export default function ReviewTimelines({ review }: { review: Review }) {
 const { lang } = useI18n(); const zh = lang === 'zh';
 return <>
 {!!review.deaths?.length && <section className={surface}><h2>{zh ? '死亡记录' : 'Deaths'}</h2><ol className="space-y-[8px]">{review.deaths.map((d, i) => <li key={i}><time>{clock(d.t)}</time>{' · '}{d.killer ? heroDisplayName(d.killer, lang) : (zh ? '击杀者待核实' : 'Killer unverified')}{d.inflictor ? ` · ${evidenceName(d.inflictor, lang)}` : ''}</li>)}</ol></section>}
 {!!review.purchases?.length && <section className={surface}><h2>{zh ? '关键购买记录' : 'Key purchases'}</h2><p>{zh ? '购买不代表送达或使用；使用时间需单独核实；若已核实，见上方片段。' : 'Purchases are not delivery or use times. Use times need separate evidence; verified uses appear in the moments above.'}</p><ul className="space-y-[8px]">{review.purchases.map((p,i) => <li key={i}>{clock(p.t)}{' · '}{itemDisplayName(p.item, lang)}</li>)}</ul></section>}
 {!!review.data_gaps.length && <details className={surface}><summary className="min-h-[44px] cursor-pointer">{zh ? '本局还缺什么' : 'What remains unverified'}</summary><ul>
 {(!review.series.radiant_gold_adv?.length || !review.series.radiant_xp_adv?.length) && <li>{zh ? '没有可校准的经济或经验曲线，因此不画缺失的曲线。净资产不等于累计获得金钱。' : 'Missing calibrated gold or XP series are not plotted. Net worth is not earned gold.'}</li>}
 {review.data_gaps.some(g => /death|position|ability|playerstats/.test(g.topic)) && <li>{zh ? '交战时血量、站位和技能命中仍需结合录像核实。' : 'Health, positions and spell hits during fights need replay review.'}</li>}
 {review.data_gaps.some(g => /item|build|purchase/.test(g.topic)) && <li>{zh ? '购买、送达和实际使用需要分别核对。' : 'Verify purchase, delivery and actual use separately.'}</li>}
 </ul></details>}
 </>;
}
