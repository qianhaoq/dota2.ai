import { renderTemplate } from './templates.js';
/** Presets are opt-in until the API v1 rollout; legacy followup lists stay stable. */
export function buildPresetFollowups(result, player, lang, gaps) {
  const { facts, deaths } = result;
  const zh = lang === 'zh';
  gaps.push({ topic: 'laning_baseline', reason: 'no_same_bracket_baseline' });
  const deathIds = ['deaths.total', ...deaths.map(d => d.fact_id)].filter(id => facts[id]);
  // A death event is answerable only when its complete timeline and gold samples exist.
  const deathReady = !!facts['deaths.total'] && deaths.every(d => d.killer && d.team_gold_diff_at_t != null);
  for (const d of deaths) {
    const display = `${facts[d.fact_id].display.t}: ${d.killer ?? (zh ? '未知' : 'unknown')}; ${d.team_gold_diff_at_t ?? (zh ? '未知' : 'unknown')}`;
    facts[d.fact_id] = { ...facts[d.fact_id], display: { ...facts[d.fact_id].display, en: display, zh: display } };
  }
  if (player && Number.isInteger(player.lane) && player.lane >= 1 && player.lane <= 3) {
    const lane = { en: ['bottom', 'middle', 'top'][player.lane - 1], zh: ['下路', '中路', '上路'][player.lane - 1] };
    facts.lane = { id: 'lane', kind: 'entity', value: player.lane, display: lane, citation: 's1', source_path: `players[${player.index}].lane` };
  }
  const laneIds = ['lh_at_10', 'gold.at.10', 'lane', 'deaths.phase.lane'];
  const laneReady = laneIds.every(id => facts[id]);
  if (!laneReady) gaps.push({ topic: 'laning_0_10', reason: 'missing_laning_fields' });
  return [
    { id: 'death_list', label: zh ? '查看死亡记录' : 'Death list', answerable: deathReady, fact_ids: deathIds, ...(deathReady ? {} : { gap: 'deaths' }) },
    { id: 'laning_0_10', label: zh ? '查看对线记录' : 'Laning evidence', answerable: laneReady, fact_ids: laneIds.filter(id => facts[id]), ...(laneReady ? {} : { gap: 'laning_0_10' }) },
  ];
}
/** Baseline comparisons and death location questions use their separate gap presets. */
export const answerPresetFollowup = (followup, facts, lang) => renderTemplate(followup, facts, lang);
