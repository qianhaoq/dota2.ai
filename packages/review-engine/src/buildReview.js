import { buildFacts, heroSlug, teamOf } from './facts/index.js';
import { buildInsights } from './insights/index.js';
import { buildGaps } from './gaps/index.js';
import { isMatchParsed } from './matchParse.js';

export const ENGINE_VERSION = '2.0.0-pr2';

/**
 * @param {any} raw OpenDota match, supplied by an adapter (never fetched here).
 * @param {{heroId?: number, lang: 'en'|'zh', fetchedAt: string, patch?: any, kb?: any[]}} opts
 */
export function buildReview(raw, opts) {
  raw = raw ?? {};
  const players = Array.isArray(raw.players) ? raw.players : [];
  const focus = opts.heroId == null ? null : players.find(p => p.hero_id === opts.heroId) ?? null;
  const roster = players.map(p => ({ hero: heroSlug(p.hero_id), hero_id: p.hero_id, team: teamOf(p), kda: [p.kills ?? null, p.deaths ?? null, p.assists ?? null] }));
  const winner = typeof raw.radiant_win === 'boolean' ? (raw.radiant_win ? 'radiant' : 'dire') : null;
  const parsed = isMatchParsed(raw);
  // Explicitly unparsed matches expose only basic facts, even if stale replay fields remain.
  const evidenceRaw = parsed ? { ...raw, players } : { ...raw, players: [], radiant_gold_adv: [], radiant_xp_adv: [] };
  const result = buildFacts(evidenceRaw, parsed ? focus : null);
  const patch = raw.patch ?? opts.patch ?? null;
  if (patch != null && !result.facts.patch) result.facts.patch = { id: 'patch', kind: 'entity', value: patch, display: { en: String(patch), zh: String(patch) }, source_path: 'opts.patch' };
  const gaps = buildGaps(focus, result.gaps);
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
  const insights = focus ? buildInsights(result, opts.lang, state) : [];
  if (state === 'parsed' && insights.length && insights.every(i => i.status === 'insufficient')) state = 'insufficient';
  const objectives = parsed ? (raw.objectives ?? []).map((o, i) => ({ o, i })).filter(({ o }) => Number.isFinite(o.time)).map(({ o, i }) => {
    const fact_id = `obj.${o.time}.${i}`;
    const objective = { t: o.time, type: o.type ?? 'unknown', key: o.key ?? null, team: o.team === 2 ? 'radiant' : o.team === 3 ? 'dire' : null, fact_id };
    result.facts[fact_id] = { id: fact_id, kind: 'entity', value: objective, t: o.time, display: { en: String(objective.key ?? objective.type), zh: String(objective.key ?? objective.type) }, citation: 's1', source_path: `objectives[${i}]` };
    return objective;
  }) : [];
  const url = `https://dota2.ai/m/${raw.match_id ?? ''}${focus ? `?hero=${heroSlug(focus.hero_id)}` : ''}`;
  return {
    schema: 'dota2.ai/review@1', engine_version: ENGINE_VERSION, state, lang: opts.lang,
    match: { id: raw.match_id ?? null, duration_s: raw.duration ?? null, winner, score: { radiant: raw.radiant_score ?? null, dire: raw.dire_score ?? null }, patch, parsed, parse_version: raw.version ?? null, start_time: raw.start_time ?? null },
    player: focus ? { ...roster[players.indexOf(focus)], result: winner && teamOf(focus) ? (winner === teamOf(focus) ? 'win' : 'loss') : null, account_id: focus.account_id ?? null } : null,
    roster, facts: result.facts,
    series: { radiant_gold_adv: parsed ? Array.from(raw.radiant_gold_adv ?? [], value => Number.isFinite(value) ? value : null) : [], radiant_xp_adv: parsed ? raw.radiant_xp_adv ?? [] : [], perspective: focus ? teamOf(focus) : 'radiant' },
    objectives, deaths: result.deaths,
    purchases: parsed && focus ? (focus.purchase_log ?? []).filter(p => Number.isFinite(p.time) && typeof p.key === 'string').map(p => ({ t: p.time, item: p.key, key_item: false })) : [],
    insights, data_gaps: gaps,
    followups: [...insights.filter(i => i.status === 'ok').map(i => ({ id: `why_${i.id}`, label: opts.lang === 'zh' ? `查看结论证据：${i.id}` : `Evidence: ${i.id}`, answerable: true, fact_ids: i.fact_ids })), ...gaps.map(g => ({ id: g.topic, label: g.topic, answerable: false, gap: g.topic }))],
    citations: [{ id: 's1', provider: 'opendota', url: `https://api.opendota.com/api/matches/${raw.match_id ?? ''}`, fetched_at: opts.fetchedAt, fields: [...new Set(Object.values(result.facts).filter(f => f.citation === 's1').map(f => f.source_path))] }],
    meta: { url, evidence_url: `${url}${focus ? '&' : '?'}view=evidence`, generated_at: opts.fetchedAt, cache: 'miss', phrasing: 'template', llm_provider: null },
  };
}
