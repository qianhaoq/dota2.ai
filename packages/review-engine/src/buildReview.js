import { isVerifiedReplay, replayStatusPayload } from './replay.js';
import { availableSummary } from './availableSummary.js';
import { buildFacts, heroSlug, teamOf, KEY_ITEMS } from './facts/index.js';
import { sanitizePlayerNameForPrompt } from './matchFacts.js';
import { buildInsights } from './insights/index.js';
import { buildGaps } from './gaps/index.js';
import { buildPresetFollowups } from './phrasing/followups.js';
import { isMatchParsed } from './matchParse.js';
import { attachSiteKnowledge } from './siteKnowledge.js';

export const ENGINE_VERSION = '2.1.0-replay1';

const insightLabels = { turning_point: '转折点', fix_this: '本场要改', next_game: '下局重点' };
const gapLabels = {
  laning_baseline: { zh: '同段位对线基准', en: 'Same-bracket laning baseline' },
  laning_0_10: { zh: '对线记录', en: 'Laning evidence' },
  gold_fed: { zh: '死亡送出金钱', en: 'Gold fed' },
  time_dead: { zh: '死亡总时长', en: 'Time dead' },
  lh_at_10: { zh: '十分钟补刀', en: 'Last hits at 10 minutes' },
  death_locations: { zh: '死亡位置', en: 'Death locations' },
  build_vs_lineup: { zh: '针对阵容的出装', en: 'Build versus lineup' },
  deaths: { zh: '死亡时间线', en: 'Death timeline' },
  'deaths.behind_1k': { zh: '经济落后千金时的死亡', en: 'Deaths while behind by 1,000 gold' },
  patch: { zh: '游戏版本', en: 'Patch' },
  player: { zh: '玩家英雄', en: 'Player hero' },
  parsed_evidence: { zh: '解析数据证据', en: 'Parsed evidence' },
  radiant_gold_adv: { zh: '天辉经济优势曲线', en: 'Radiant gold advantage' },
};

/**
 * @param {any} raw OpenDota match, supplied by an adapter (never fetched here).
 * @param {{heroId?: number, lang: 'en'|'zh', fetchedAt: string, patch?: any, kb?: any[], kbContextIds?: string[], presetFollowups?: boolean}} opts
 */
export function buildReview(raw, opts) {
  raw = raw ?? {};
  const players = Array.isArray(raw.players) ? raw.players : [];
  const focus = opts.heroId == null ? null : players.find(p => p.hero_id === opts.heroId) ?? null;
  const roster = players.map(p => ({ hero: heroSlug(p.hero_id), hero_id: p.hero_id, team: teamOf(p), kda: [p.kills ?? null, p.deaths ?? null, p.assists ?? null], personaname: sanitizePlayerNameForPrompt(p.personaname) }));
  const winner = typeof raw.radiant_win === 'boolean' ? (raw.radiant_win ? 'radiant' : 'dire') : null;
  const parsed = isMatchParsed(raw);
  const replay = isVerifiedReplay(raw.replay_ingest, raw.match_id) ? raw.replay_ingest : null;
  // Explicitly unparsed matches expose only basic facts, even if stale replay fields remain.
  const evidenceRaw = parsed ? { ...raw, players } : { ...raw, players: [], radiant_gold_adv: [], radiant_xp_adv: [] };
  const result = buildFacts(evidenceRaw, parsed ? focus : null);
  const patch = raw.patch ?? opts.patch ?? null;
  if (patch != null && !result.facts.patch) result.facts.patch = { id: 'patch', kind: 'entity', value: patch, display: { en: String(patch), zh: String(patch) }, source_path: 'opts.patch' };
  const gaps = buildGaps(focus, result.gaps);
  if (!parsed) gaps.push({ topic: 'parsed_evidence', reason: raw.replay_ingest?.status ?? 'not_parsed_yet' });
  if (replay) {
    gaps.push(...(replay.data_gaps ?? []));
    for (const gap of gaps) if (gap.topic === 'death_locations') gap.reason = 'position_sample_missing';
  }
  if (patch == null) gaps.push({ topic: 'patch', reason: 'missing_match_patch' });
  if (focus) for (const topic of ['gold_fed', 'time_dead', 'lh_at_10']) {
    if (!result.facts[topic] && !gaps.some(g => g.topic === topic)) gaps.push({ topic, reason: 'missing_parsed_player_field' });
  }
  if (opts.heroId != null && !focus) gaps.push({ topic: 'player', reason: 'hero_not_in_roster' });
  const complete = players.length > 0 && players.every(p => heroSlug(p.hero_id) && teamOf(p));
  const goldComplete = Array.isArray(raw.radiant_gold_adv) && raw.radiant_gold_adv.length > 5 && Array.from(raw.radiant_gold_adv).every(Number.isFinite);
  let state = !parsed ? 'unparsed' : complete && (opts.heroId == null || focus) ? 'parsed' : 'insufficient';
  if (parsed && !complete) gaps.push({ topic: 'parsed_evidence', reason: 'missing_roster_mapping' });
  if (parsed && !goldComplete) gaps.push({ topic: 'radiant_gold_adv', reason: 'missing_or_incomplete_gold_series' });
  const insights = focus ? (!parsed ? availableSummary(raw, focus, result.facts, opts.lang) : buildInsights(result, opts.lang, state)) : [];
  if (state === 'parsed' && insights.length && insights.every(i => i.status === 'insufficient')) state = 'insufficient';
  const objectives = parsed ? (raw.objectives ?? []).map((o, i) => ({ o, i })).filter(({ o }) => Number.isFinite(o.time)).map(({ o, i }) => {
    const fact_id = `obj.${o.time}.${i}`;
    // Prefer explicit teams, then player slots, then the destroyed structure's opposing side.
    const team = o.team === 2 || o.team === 3 ? o.team : Number.isInteger(o.player_slot) ? (o.player_slot < 128 ? 2 : 3) : typeof o.key === 'string' ? (o.key.includes('goodguys') ? 3 : o.key.includes('badguys') ? 2 : null) : null;
    const objective = { t: o.time, type: o.type ?? 'unknown', key: o.key ?? null, team: team === 2 ? 'radiant' : team === 3 ? 'dire' : null, fact_id };
    result.facts[fact_id] = { id: fact_id, kind: 'entity', value: objective, t: o.time, display: { en: String(objective.key ?? objective.type), zh: String(objective.key ?? objective.type) }, citation: 's1', source_path: o.source_path ?? `objectives[${i}]` };
    return objective;
  }) : [];
  if (replay) {
    for (const fact of Object.values(result.facts)) {
      if (/^(players\[|radiant_|objectives|trace\/)/.test(fact.source_path)) fact.citation = 'r1';
      if (fact.source_path?.startsWith('trace/metadata') || (fact.source_path?.startsWith('radiant_gold') && replay.gold_source)) {
        fact.citation = 'r1';
        fact.derivation = fact.id === 'camps_stacked' ? 'demo metadata camps_stacked count; does not establish a pre-stack check' : fact.source_path.startsWith('radiant_gold') ? replay.gold_derivation : 'demo_metadata_inventory_snapshot: exact game_time; approximately 30 second snapshot interval';
      }
    }
    for (const insight of insights) insight.citations = [...new Set(insight.fact_ids.map(id => result.facts[id]?.citation).filter(Boolean))];
    // Partial timelines still prove individual events; never grade a decision from these alone.
    const deathIds = result.deaths.map(d => d.fact_id);
    const allItemIds = Object.keys(result.facts).filter(id=>id.startsWith('item.first.'));
    const keyIds = allItemIds.filter(id=>Object.hasOwn(KEY_ITEMS,id.slice(11)));
    const itemIds = keyIds.length ? keyIds : allItemIds;
    if (itemIds.length) {
      const i = insights.findIndex(i=>i.id === 'next_game');
      const times = itemIds.map(id=>result.facts[id].t);
      const slots = opts.lang === 'zh' ? '录像已核实购买记录；不代表送达或使用时间，不能据此判断出装优劣。' : 'The replay verifies purchase records. These are not delivery or use times and do not establish build quality.';
      insights[i] = {...insights[i],status:'ok',fact_ids:itemIds,metrics:itemIds.map(fact_id=>({fact_id,label_key:fact_id})),citations:['r1'],time:{from:Math.min(...times),to:Math.max(...times)},claim:{text:slots,slots,phrasing:'template'}};
      state = complete ? 'parsed' : 'insufficient';
    }
    if (deathIds.length) {
      const i = insights.findIndex(i => i.id === 'fix_this');
      insights[i] = { ...insights[i], status:'ok', fact_ids:deathIds, metrics:deathIds.map(fact_id => ({fact_id,label_key:fact_id})), citations:['r1'],
        time:{from:result.deaths[0].t,to:result.deaths.at(-1).t},
        claim:{slots:'',text:opts.lang === 'zh' ? '录像已核实以下死亡时刻；state_sample 位置是附近采样点（见 sample_t、dt），并非战斗日志精确死亡坐标。需结合兵线、视野和目标回看，不能仅凭死亡判定决策错误。' : 'The replay verifies these death times. Any state_sample position is a nearby sampled location, with sample_t and dt, not an exact combat-log death coordinate. Review waves, vision and objectives; a death alone does not prove a decision error.', phrasing:'template'} };
      state = complete ? 'parsed' : 'insufficient';
    }
  }
  const presets = opts.presetFollowups ? buildPresetFollowups(result, parsed && focus ? { ...focus, index: players.indexOf(focus) } : null, opts.lang, gaps) : [];
  const url = `https://dota2.ai/m/${raw.match_id ?? ''}${focus ? `?hero=${heroSlug(focus.hero_id)}` : ''}`;
  return attachSiteKnowledge({
    schema: 'dota2.ai/review@1', engine_version: ENGINE_VERSION, state, lang: opts.lang,
    match: { id: raw.match_id ?? null, duration_s: raw.duration ?? null, winner, score: { radiant: raw.radiant_score ?? null, dire: raw.dire_score ?? null }, patch, parsed, parse_version: raw.version ?? null, start_time: raw.start_time ?? null },
    player: focus ? { ...roster[players.indexOf(focus)], result: winner && teamOf(focus) ? (winner === teamOf(focus) ? 'win' : 'loss') : null, account_id: focus.account_id ?? null } : null,
    roster, facts: result.facts,
    series: { radiant_gold_adv: parsed ? Array.from(raw.radiant_gold_adv ?? [], value => Number.isFinite(value) ? value : null) : [], radiant_xp_adv: parsed ? raw.radiant_xp_adv ?? [] : [], perspective: focus ? teamOf(focus) : 'radiant' },
    objectives, deaths: result.deaths,
    purchases: parsed && focus ? (focus.purchase_log ?? []).filter(p => Number.isFinite(p.time) && typeof p.key === 'string').map(p => ({ t: p.time, item: p.key, key_item: Object.hasOwn(KEY_ITEMS, p.key) })) : [],
    insights, data_gaps: gaps,
    followups: [...presets, ...insights.filter(i => i.status === 'ok').map(i => ({ id: `why_${i.id}`, label: opts.lang === 'zh' ? `查看结论证据：${insightLabels[i.id] ?? i.id}` : `Evidence: ${i.id}`, answerable: true, fact_ids: i.fact_ids })), ...gaps.filter(g => !presets.some(p => p.id === g.topic)).map(g => ({ id: g.topic, label: gapLabels[g.topic]?.[opts.lang] ?? g.topic, answerable: false, gap: g.topic }))],
    citations: [...(replay ? [{id:'r1',provider:'replay',url:replay.replay_url ?? '',fetched_at:replay.fetched_at,sha256:replay.demo_sha256,source_path:'trace/events.jsonl',fields:[...new Set(Object.values(result.facts).filter(f=>f.citation === 'r1').map(f=>f.source_path))]}] : []), { id: 's1', provider: 'opendota', url: `https://api.opendota.com/api/matches/${raw.match_id ?? ''}`, fetched_at: opts.fetchedAt, fields: [...new Set(Object.values(result.facts).filter(f => f.citation === 's1').map(f => f.source_path))] }],
    ...(raw.replay_ingest ? {parse:replayStatusPayload(raw.replay_ingest.status === 'replay_parsed' && !replay ? 'replay_failed' : raw.replay_ingest.status, opts.lang)} : {}),
    meta: { url, evidence_url: `${url}${focus ? '&' : '?'}view=evidence`, generated_at: opts.fetchedAt, cache: 'miss', phrasing: 'template', llm_provider: null },
  }, opts.kb, opts.kbContextIds);
}
