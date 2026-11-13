import { STATIC_HEROES } from '../staticHeroes.js';
import { renderTemplate } from './templates.js';
/** Presets are opt-in until the API v1 rollout; legacy followup lists stay stable. */
export function buildPresetFollowups(result, player, lang, gaps) {
  const { facts, deaths } = result;
  const zh = lang === 'zh';
  gaps.push({ topic: 'laning_baseline', reason: 'no_same_bracket_baseline' });
  const deathIds = ['deaths.total', ...deaths.map(d => d.fact_id)].filter(id => facts[id]);
  // OpenDota death summaries require complete timelines and gold. Verified dem
  // events can answer an individual-event list with unknown gold shown explicitly.
  const replayDeaths = deaths.length > 0 && deaths.every(d => facts[d.fact_id]?.citation === 'r1');
  const deathReady = replayDeaths || (!!facts['deaths.total'] && deaths.every(d => d.killer && d.team_gold_diff_at_t != null));
  for (const d of deaths) {
    const hero = Object.values(STATIC_HEROES).find(h => h.internalSlug === d.killer);
    const g = d.team_gold_diff_at_t;
    const gold = g == null ? (zh ? '未知' : 'unknown') : `${g < 0 ? '−' : g > 0 ? '+' : ''}${Math.abs(g).toLocaleString('en-US')}`;
    const en = `killed by ${hero?.nameEn ?? d.killer ?? 'unknown'}; team gold difference: ${gold}`;
    const chinese = `击杀者：${hero?.nameZh ?? d.killer ?? '未知'}；团队经济差：${gold}`;
    facts[d.fact_id] = {
      ...facts[d.fact_id],
      display: { ...facts[d.fact_id].display, en, zh: chinese },
    };
  }
  if (player && Number.isInteger(player.lane) && player.lane >= 1 && player.lane <= 3 && Number.isInteger(player.player_slot)) {
    // OpenDota `lane` is geographic (1=bot, 2=mid, 3=top) for both teams; only `lane_role` is team-relative.
    const laneIndex = player.lane - 1;
    const lane = { en: ['bottom', 'middle', 'top'][laneIndex], zh: ['下路', '中路', '上路'][laneIndex] };
    facts.lane = { id: 'lane', kind: 'entity', value: player.lane, display: lane, citation: 's1', source_path: `players[${player.index}].lane` };
  }
  const laneIds = ['lh_at_10', 'gold.at.10', 'lane', 'deaths.phase.lane'];
  const laneReady = laneIds.every(id => facts[id]);
  if (!laneReady) gaps.push({ topic: 'laning_0_10', reason: 'missing_laning_fields' });
  // Earned gold and net worth have separate ids and labels.
  const farmIds = [];
  for (const [field, nameEn, nameZh] of [['lh_t', 'last hits', '补刀'], ['gold_t', 'cumulative gold', '累计经济'], ['xp_t', 'experience', '经验'], ['net_worth_t', 'net worth', '净资产']]) {
    const samples = player?.[field];
    if (![samples?.[10], samples?.[20]].every(v => Number.isFinite(v) && v >= 0) || samples[20] < samples[10]) continue;
    const id = `farm.10_20.${field}`;
    facts[id] = { id, kind: 'scalar', value: samples[20] - samples[10],
      display: { en: `${nameEn}: ${samples[10]} → ${samples[20]} (+${samples[20] - samples[10]})`, zh: `${nameZh}：${samples[10]} → ${samples[20]}（+${samples[20] - samples[10]}）` },
      citation: player.metadata_source_path && ['lh_t','net_worth_t'].includes(field) ? 'r1' : 's1',
      source_path: player.metadata_source_path && ['lh_t','net_worth_t'].includes(field)
        ? `${player.metadata_source_path}.${field === 'net_worth_t' ? 'graph_net_worth[10,20]' : 'inventory_snapshots[game_time=600,1200].last_hits'}`
        : `players[${player.index}].${field}[10]; players[${player.index}].${field}[20]`,
      ...(field === 'net_worth_t' ? {unit:'gold (net worth)',derivation:player.net_worth_derivation} : {}) };
    farmIds.push(id);
  }
  const itemIds = Object.keys(facts).filter(id => id.startsWith('item.first.'));
  return [
    ...(farmIds.length ? [{ id: 'farm_progress', label: zh ? '10–20分钟个人发育记录' : 'Personal farm at 10–20 minutes', answerable: true, fact_ids: farmIds }] : []),
    ...(itemIds.length ? [{ id: 'item_timings', label: zh ? '关键装备时间' : 'Key item timings', answerable: true, fact_ids: itemIds }] : []),
    { id: 'death_list', label: zh ? '查看死亡记录' : 'Death list', answerable: deathReady, fact_ids: deathIds, ...(deathReady ? {} : { gap: 'deaths' }) },
    { id: 'laning_0_10', label: zh ? '查看对线记录' : 'Laning evidence', answerable: laneReady, fact_ids: laneIds.filter(id => facts[id]), ...(laneReady ? {} : { gap: 'laning_0_10' }) },
  ];
}
/** Baseline comparisons and death location questions use their separate gap presets. */
export const answerPresetFollowup = (followup, facts, lang) => renderTemplate(followup, facts, lang);
