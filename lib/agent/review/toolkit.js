/**
 * The lookup tools for one player's game, shared by the deep review and the chat, and the names the
 * reader is given for the engine's keys.
 */
import { TRACE_TOOLS, runTraceTool } from '../../../packages/review-engine/src/trace/index.js';
import { heroByKey } from '../../../packages/review-engine/src/staticHeroes.js';
import { normalizeUiLang } from '../../aiLanguage.js';
import { KNOWLEDGE_TOOLS } from '../knowledgeTools.js';
import { patchForGame } from '../patchData.js';
import { placeNames } from '../places.js';
import { ultimateOf, ultimatesOf } from '../ultimates.js';
import { PLAN_TEXTS } from './schema.js';
import { stripHandles } from './verify.js';

/**
 * The lookup tools for one player's game: their schemas, how to run them
 * (told from that player's side), and the context the model starts from.
 * Shared by the deep review and the chat. Null when the hero is not in the trace.
 */
export function reviewToolkit({ trace, hero, lang, match = null }) {
  const language = normalizeUiLang(lang);
  const seat = trace.heroes.find((h) => h.key === String(hero).trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_'));
  if (!seat) return null;
  const lookups = [...TRACE_TOOLS, ...KNOWLEDGE_TOOLS];
  const ctx = { match, perspective: seat.key, lang: language, ultimateOf, ultimatesOf };
  const knowledge = new Map(KNOWLEDGE_TOOLS.map((t) => [t.name, t]));
  return {
    seat, language,
    tools: lookups.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
    runTool: (name, args) => roshanGapPointsToTool(knowledge.has(name) ? { tool: name, ...knowledge.get(name).run(trace, args, ctx) } : runTraceTool(trace, name, args, ctx), trace),
    patch: (({ name, hotfix, exact, how, reason }) => ({ name, ...(hotfix ? { hotfix } : {}), exact, ...(how ? { known_from: how } : {}), ...(exact ? {} : { reason }) }))(patchForGame(trace.match_id, match)),
    context: { match_id: trace.match_id, player_hero: seat.key, hero_names: heroNames(trace, language), place_names: placeNames(language), ...(scoreboard(match, seat.key) ? { scoreboard: scoreboard(match, seat.key) } : {}) },
  };
}

/**
 * A trace says Roshan is a gap (it has no Roshan kill event), and every tool passes that on. roshan_report reads the
 * Roshans from the Aegis pickups: the gap now says so, or the model reads "no reliable Roshan event" as "unknown"
 * and puts a Roshan it could have looked up among the blind spots.
 */
const ROSHAN_GAP = 'no Roshan kill event in the trace: roshan_report reads each Roshan from the Aegis pickup (a Roshan whose Aegis nobody picked up is not seen)';
/** The same, for a trace that kept Roshan's kills: there the gap is only what even those do not show. */
const ROSHAN_GAP_WITH_KILLS = 'roshan_report reads each Roshan from its kill and its Aegis pickup; not seen: a Roshan whose last hit was not a hero\'s and whose Aegis nobody picked up, and who could see an attempt';
function roshanGapPointsToTool(result, trace) {
  if (!Array.isArray(result?.gaps) || result.tool === 'roshan_report') return result;
  const reason = Array.isArray(trace?.roshan_kills) ? ROSHAN_GAP_WITH_KILLS : ROSHAN_GAP;
  return { ...result, gaps: result.gaps.map((g) => (g?.topic === 'roshan' ? { ...g, reason } : g)) };
}

/** The scoreboard facts the model starts from, when the match JSON is at hand. Names and account ids never go in. */
function scoreboard(match, heroKey) {
  const id = heroByKey(heroKey)?.id;
  const p = id == null ? null : (match?.players ?? []).find((x) => x && x.hero_id === id);
  return p ? { kills: p.kills, deaths: p.deaths, assists: p.assists, net_worth: p.net_worth, gold_per_min: p.gold_per_min, last_hits: p.last_hits } : null;
}

/** What to call each hero of this match in the reader's language (the tools use engine keys such as "necrolyte"). */
export function heroNames(trace, lang) {
  // By the replay's own key for each hero ("queen_of_pain"), resolved to the hero it means.
  return Object.fromEntries(trace.heroes.map((h) => { const hero = heroByKey(h.key); return [h.key, (hero ? (lang === 'zh' ? hero.nameZh : hero.nameEn) : null) ?? h.key]; }));
}

/**
 * Replace engine hero keys the model let through ("skywrath_mage", "sven")
 * with the reader's names. Whole identifiers only, longest first; `refs` are
 * handles and are never touched.
 */
export function nameHeroes(review, names, places = {}) {
  names = { ...places, ...names };
  const keys = Object.keys(names).filter((k) => names[k] && names[k] !== k).sort((a, b) => b.length - a.length);
  if (!keys.length) return review;
  const re = new RegExp(`(?<![A-Za-z0-9_:])(${keys.join('|')})(?![A-Za-z0-9_:])`, 'g');
  // Only place names are closed up: hero names keep the spacing the text had.
  const cjkNames = [...new Set(Object.values(places).filter((n) => /^[\u3400-\u9fff]+$/.test(n)))].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const C = '[\\u3400-\\u9fff\\uff00-\\uffef\\u3000-\\u303f]';
  const tight = cjkNames.length ? new RegExp(`(?:(${C}) +)?(${cjkNames.join('|')})(?: +(?=${C}))?`, 'g') : /$^/g;
  // A Chinese name put where a key stood between Chinese text ("在 dire 上路") takes the spaces around the key with it.
  const fix = (v) => (typeof v === 'string' ? stripHandles(v).replace(re, (k) => names[k]).replace(tight, (m, before, name) => `${before ?? ''}${name}`) : v);
  return {
    ...review,
    verdict: fix(review.verdict), ...(Array.isArray(review.story) ? { story: review.story.map((l) => ({ ...l, phase: fix(l.phase), what_changed: fix(l.what_changed), because: fix(l.because), evidence: (l.evidence ?? []).map((e) => ({ ...e, fact: fix(e.fact) })) })) } : {}), mainline: (review.mainline ?? []).map(fix), did_well: (review.did_well ?? []).map(fix), next_game: (review.next_game ?? []).map(fix), blind_spots: (review.blind_spots ?? []).map(fix),
    findings: (review.findings ?? []).map((f) => ({ ...f, title: fix(f.title), claim: fix(f.claim), fix: fix(f.fix), ...(f.rule ? { rule: { ...f.rule, when: fix(f.rule.when), do: fix(f.rule.do), this_game: fix(f.rule.this_game) } } : {}), evidence: (f.evidence ?? []).map((e) => ({ ...e, fact: fix(e.fact) })) })),
    ...(review.game_plan ? { game_plan: { ...Object.fromEntries(Object.entries(review.game_plan).map(([k, v]) => [k, PLAN_TEXTS.includes(k) ? fix(v) : v])), evidence: (review.game_plan.evidence ?? []).map((e) => ({ ...e, fact: fix(e.fact) })) } } : {}),
  };
}
