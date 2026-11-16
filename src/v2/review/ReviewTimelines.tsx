import React from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { heroDisplayName } from './heroDisplayName';
import { surface } from './ConversationCards';
import type { Review } from './types';
import { formatMatchClock } from '../evidence/labels';
import { evidenceName } from '../../../packages/review-engine/src/insights/moments.js';
import { itemDisplayName } from '../evidence/itemNames';
const clock = formatMatchClock;
/** Localized names for registered gap topics; unknown topics fall back to the key. */
const GAP_LABELS: Record<string, [string, string]> = {
  hero_states: ['Hero state samples (map position, HP, mana)', '英雄状态样本（地图位置、HP、魔法）'],
  death_locations: ['Death map positions', '阵亡地图位置'],
  radiant_gold_adv: ['Earned-gold advantage series', '赚金优势曲线'],
  radiant_xp_adv: ['XP advantage series', '经验优势曲线'],
  radiant_net_worth_adv: ['Net-worth advantage series', '净资产优势曲线'],
  gold_t: ['Earned-gold timeline', '赚金时间线'],
  xp_t: ['XP timeline', '经验时间线'],
  net_worth_t: ['Net-worth timeline', '净资产时间线'],
  playerstats: ['Player statistics fields', '选手统计字段'],
  deaths_behind_1k: ['Deaths while behind by 1000+ gold', '落后千金时的阵亡'],
  'deaths.behind_1k': ['Deaths while behind by 1000+ gold', '落后千金时的阵亡'],
  build_vs_lineup: ['Item benchmark vs this lineup', '对该阵容的出装基准'],
  laning_baseline: ['Laning baseline (same-bracket comparison)', '对线基线（同段位对比）'],
  laning_0_10: ['Laning detail (0–10 min)', '对线期明细（0–10 分钟）'],
  lh_at_10: ['Last hits at 10 minutes', '10 分钟补刀数'],
  gold_fed: ['Gold fed on deaths', '阵亡送出的金钱'],
  time_dead: ['Time spent dead', '阵亡停留时长'],
  patch: ['Patch version', '版本号'],
  parsed_evidence: ['OpenDota parsed evidence', 'OpenDota 解析证据'],
  player: ['Player roster mapping', '玩家名单映射'],
};
export default function ReviewTimelines({ review }: { review: Review }) {
 const { lang } = useI18n(); const zh = lang === 'zh';
 // Hero-state samples are the state facts that actually carry HP/position
 // (state.win.* / state.death.*). state.snapshot.* is an inventory-snapshot
 // level only — it must not flip the appendix into claiming HP/positions were
 // given. The HP/positions-absent note follows the real samples, not any
 // state-prefixed id.
 const hasHeroStates = (review.insights ?? []).some(i => (i.fact_ids ?? []).some(id => /^state\.(win|death)\./.test(id)));
 return <>
 {!!review.deaths?.length && <section className={surface}><h2>{zh ? '死亡记录' : 'Deaths'}</h2><ol className="space-y-[8px]">{review.deaths.map((d, i) => <li key={i}><time>{clock(d.t)}</time>{' · '}{d.killer ? heroDisplayName(d.killer, lang) : (zh ? '击杀者待核实' : 'Killer unverified')}{d.inflictor ? ` · ${evidenceName(d.inflictor, lang)}` : ''}</li>)}</ol></section>}
 {!!review.item_uses?.length && <section className={surface}><h2>{zh ? '使用记录' : 'Item uses'}</h2><ul>{review.item_uses.map((u,i)=><li key={i}>{clock(u.t)}{u.ended_at != null ? `–${clock(u.ended_at)}` : ''}{' · '}{itemDisplayName(u.item,lang)}</li>)}</ul></section>}
 {!!review.purchases?.length && <section className={surface}><h2>{zh ? '关键购买记录' : 'Key purchases'}</h2><p>{zh ? '购买不代表送达或使用。' : 'Purchases are not delivery or use times.'}</p><ul className="space-y-[8px]">{review.purchases.map((p,i) => <li key={i}>{clock(p.t)}{' · '}{itemDisplayName(p.item, lang)}</li>)}</ul></section>}
 <details className={surface}><summary className="min-h-[44px] cursor-pointer">{zh ? '本局还缺什么' : 'What remains unverified'}</summary><p>{zh ? '本页仅陈述字段支持的交战观察；记录不证明操作失误、BKB 开早或开晚，也不证明胜负原因。' : 'This page states only field-backed fight observations. Records do not establish mistakes, early or late BKB, or causes of winning or losing.'}</p>
 {!hasHeroStates && <p>{zh ? '缺少血量、视野和队友实时位置，本页不询问这些信息。' : 'HP, vision and live teammate positions are absent and are not asked about.'}</p>}
 {hasHeroStates && <p>{zh ? '血量与站位已随状态样本给出；视野与兵线实体不在本记录里，本页不询问这些信息。' : 'HP and positions ship with the state samples; vision and creep-lane entities are not in this record and are not asked about.'}</p>}
 {(!review.series.radiant_gold_adv?.length || !review.series.radiant_xp_adv?.length) && <p>{zh ? '没有可校准的经济或经验曲线，因此不画缺失的曲线。净资产不等于累计获得金钱。' : 'Missing calibrated gold or XP series are not plotted. Net worth is not earned gold.'}</p>}
 {!!review.data_gaps?.length && <ul className="mt-[8px] space-y-[4px]" data-testid="gap-list">{review.data_gaps.map((g, i) => { const label = GAP_LABELS[g.topic]?.[zh ? 1 : 0] ?? g.topic; return <li key={i} className="text-d2-13 text-d2-ink-3">{zh ? `缺：${label}` : `Missing: ${label}`}</li>; })}</ul>}
 </details>
 </>;
}
