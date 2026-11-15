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
 {!!review.item_uses?.length && <section className={surface}><h2>{zh ? '使用记录' : 'Item uses'}</h2><ul>{review.item_uses.map((u,i)=><li key={i}>{clock(u.t)}{u.ended_at != null ? `–${clock(u.ended_at)}` : ''}{' · '}{itemDisplayName(u.item,lang)}</li>)}</ul></section>}
 {!!review.purchases?.length && <section className={surface}><h2>{zh ? '关键购买记录' : 'Key purchases'}</h2><p>{zh ? '购买不代表送达或使用。' : 'Purchases are not delivery or use times.'}</p><ul className="space-y-[8px]">{review.purchases.map((p,i) => <li key={i}>{clock(p.t)}{' · '}{itemDisplayName(p.item, lang)}</li>)}</ul></section>}
 <details className={surface}><summary className="min-h-[44px] cursor-pointer">{zh ? '本局还缺什么' : 'What remains unverified'}</summary><p>{zh ? '本页仅陈述字段支持的交战观察；记录不证明操作失误、BKB 开早或开晚，也不证明胜负原因。缺少血量、视野和队友实时位置，本页不询问这些信息。' : 'This page states only field-backed fight observations. Records do not establish mistakes, early or late BKB, or causes of winning or losing. HP, vision and live teammate positions are absent and are not asked about.'}</p></details>
 </>;
}
