import { renderSlots } from './slots.js';
export const refusal = lang => lang === 'zh' ? '该问题需要的数据不在本局记录中。' : "The data needed for this question is not in this match's record.";
export const GAP_TOPICS = ['gold_fed', 'time_dead', 'lh_at_10', 'death_locations', 'build_vs_lineup', 'deaths', 'deaths.behind_1k', 'patch', 'player', 'parsed_evidence', 'radiant_gold_adv', 'laning_baseline', 'laning_0_10'];
export const gapTemplates = Object.fromEntries(GAP_TOPICS.map(topic => [topic, { en: refusal('en'), zh: refusal('zh') }]));
const labels = { en: { turning_point: 'Turning point', fix_this: 'Review these deaths', next_game: 'Next game, review your economy', death_list: 'Death timeline', laning_0_10: 'Laning evidence' }, zh: { turning_point: '转折点', fix_this: '复查这些死亡', next_game: '下局复查发育', death_list: '死亡时间线', laning_0_10: '对线证据' } };
/** Complete deterministic fallback; all supplied evidence remains referenced. */
export function renderTemplate(insight, facts, lang) {
  const ids = (insight.fact_ids ?? []).filter(id => facts[id]);
  const slots = insight.status === 'insufficient' || insight.answerable === false || !ids.length
    ? refusal(lang) : `${labels[lang]?.[insight.id] ?? (lang === 'zh' ? '比赛证据' : 'Match evidence')}: ${ids.map(id => `{${id}}`).join(' / ')}${lang === 'zh' ? '。' : '.'}`;
  return { text: renderSlots(slots, facts, lang), slots, phrasing: 'template' };
}
