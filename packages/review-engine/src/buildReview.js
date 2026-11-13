import { buildMoments } from './insights/moments.js';
import { isVerifiedReplay, replayStatusPayload } from './replay.js';
import { availableSummary } from './availableSummary.js';
import { buildFacts, heroSlug, teamOf, KEY_ITEMS } from './facts/index.js';
import { sanitizePlayerNameForPrompt } from './matchFacts.js';
import { buildInsights } from './insights/index.js';
import { buildGaps } from './gaps/index.js';
import { buildPresetFollowups } from './phrasing/followups.js';
import { isMatchParsed } from './matchParse.js';
import { attachSiteKnowledge } from './siteKnowledge.js';

export const ENGINE_VERSION = '2.3.0-replay-jobs';

const insightLabels = { turning_point: '转折点', fix_this: '本场要改', next_game: '下局重点' };

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
    // Net worth is deliberately excluded from earned-gold windows and death context.
    if (focus?.net_worth_t) for (const minute of [0,10,20]) {
      const value = focus.net_worth_t[minute];
      if (!Number.isFinite(value)) continue;
      const id = `net_worth.at.${minute}`;
      result.facts[id] = {id,kind:'scalar',value,unit:'gold (net worth)',t:minute*60,
        display:{en:`Net worth: ${value} gold`,zh:`净资产：${value} 金`},citation:'r1',
        source_path:`${focus.metadata_source_path}.graph_net_worth[${minute}]`,derivation:focus.net_worth_derivation};
    }
    for (const fact of Object.values(result.facts)) {
      if (/^(players\[|radiant_|objectives|trace\/)/.test(fact.source_path)) fact.citation = 'r1';
      if (fact.source_path?.startsWith('trace/metadata')) {
        fact.citation = 'r1';
        fact.derivation = fact.id.startsWith('net_worth.') ? focus.net_worth_derivation : fact.id === 'camps_stacked' ? 'demo metadata camps_stacked count; does not establish a pre-stack check' : 'demo_metadata_inventory_snapshot: exact game_time; approximately 30 second snapshot interval';
      }
    }
    for (const insight of insights) insight.citations = [...new Set(insight.fact_ids.map(id => result.facts[id]?.citation).filter(Boolean))];
  }
  if (replay && focus) {
    insights.splice(0, insights.length, ...buildMoments(result, focus, opts.lang));
    state = complete ? 'parsed' : 'insufficient';
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
    insights, data_gaps: gaps.filter((g,i)=>gaps.findIndex(other=>other.topic===g.topic)===i),
    followups: (replay
      ? insights.filter(i => i.prompt).slice(0,2).map(i => ({id:`why_${i.id}`,label:i.prompt,answerable:true,fact_ids:i.fact_ids})).concat(presets.filter(p=>p.answerable).sort((a,b)=>Number(b.id==='death_list')-Number(a.id==='death_list')))
      : [...presets.filter(p=>p.answerable).sort((a,b)=>Number(a.id==='farm_progress')-Number(b.id==='farm_progress')), ...insights.filter(i=>i.status==='ok').map(i=>({id:`why_${i.id}`,label:opts.lang==='zh'?`查看结论证据：${insightLabels[i.id] ?? i.id}`:`Evidence: ${i.id}`,answerable:true,fact_ids:i.fact_ids}))]
    ).slice(0,3),
    citations: [...(replay ? [{id:'r1',provider:'replay',url:replay.replay_url ?? '',fetched_at:replay.fetched_at,sha256:replay.demo_sha256,source_path:'trace/events.jsonl',fields:[...new Set(Object.values(result.facts).filter(f=>f.citation === 'r1').map(f=>f.source_path))]}] : []), { id: 's1', provider: 'opendota', url: `https://api.opendota.com/api/matches/${raw.match_id ?? ''}`, fetched_at: opts.fetchedAt, fields: [...new Set(Object.values(result.facts).filter(f => f.citation === 's1').map(f => f.source_path))] }],
    ...(raw.replay_ingest ? {parse:replayStatusPayload(raw.replay_ingest.status === 'replay_parsed' && !replay ? 'replay_failed' : raw.replay_ingest.status, opts.lang)} : {}),
    meta: { replay_generation:raw.replay_generation??0, ingest_available:raw.replay_ingest_available===true, replay_auto_enabled:raw.replay_auto_enabled===true, url, evidence_url: `${url}${focus ? '&' : '?'}view=evidence`, generated_at: opts.fetchedAt, cache: 'miss', phrasing: 'template', llm_provider: null },
  }, opts.kb, opts.kbContextIds);
}
