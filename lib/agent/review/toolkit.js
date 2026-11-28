/**
 * The lookup tools for one player's game, shared by the deep review and the chat, and the names the
 * reader is given for the engine's keys.
 */
import { TRACE_TOOLS, runTraceTool } from '../../../packages/review-engine/src/trace/index.js';
import { createRequire } from 'node:module';
import { heroByKey } from '../../../packages/review-engine/src/staticHeroes.js';
import { normalizeUiLang } from '../../aiLanguage.js';
import { KNOWLEDGE_TOOLS } from '../knowledgeTools.js';
import { RELEASES, patchForGame } from '../patchData.js';
import { placeNames } from '../places.js';
import { ultimateOf, ultimatesOf } from '../ultimates.js';
import { PLAN_TEXTS } from './schema.js';
import { stripHandles } from './verify.js';
import { WEB_SEARCH_TOOL, webSearchFromEnv } from '../webSearch.js';

const ABILITY_DATA = createRequire(import.meta.url)('../../coach/data/abilities.json');

/**
 * The lookup tools for one player's game: their schemas, how to run them
 * (told from that player's side), and the context the model starts from.
 * Shared by the deep review and the chat. Null when the hero is not in the trace.
 * `webSearch` runs web_search (webSearch.js); by default DeepSeek Search with the server's key, a count of its own
 * for this toolkit. web_search is always offered, so the model is told the same tools whatever the environment:
 * without a key it answers web_search_not_configured.
 */
export function reviewToolkit({ trace, hero, lang, match = null, webSearch = webSearchFromEnv() }) {
  const language = normalizeUiLang(lang);
  const seat = trace.heroes.find((h) => h.key === String(hero).trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_'));
  if (!seat) return null;
  const lookups = [...TRACE_TOOLS, ...KNOWLEDGE_TOOLS, WEB_SEARCH_TOOL];
  // This game's patch and when it went live: a web page is set against it (webSearch.js), and item_timeline reads this release's component recipes.
  const pd = patchForGame(trace.match_id, match);
  const ctx = { match, perspective: seat.key, lang: language, ultimateOf, ultimatesOf, patchItems: pd.items };
  const knowledge = new Map(KNOWLEDGE_TOOLS.map((t) => [t.name, t]));
  // The release is placed when the patch is exact, or when only the hotfix within it is not (patchData.js: those
  // reasons name the hotfix). Otherwise (an older game, an unknown letter, a game during a release's rollout) the
  // release patchForGame falls back to is not known to be this game's: the patch and its release stay unknown, and
  // no page is called older or newer than it.
  const gamePatch = pd.exact || /hotfix/.test(pd.reason ?? '')
    ? { name: pd.name, released: RELEASES.find((r) => r.name === pd.name)?.rollout_by ?? null }
    : { name: null, released: null, reason: pd.reason ?? 'patch_not_established' };
  const names = heroNames(trace, language);
  return {
    seat, language,
    tools: lookups.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
    /** Count n web searches already made (a resumed review's): the limit is per review, not per restart. */
    spendSearches: (n) => webSearch?.spend?.(n),
    runTool: (name, args) => (name === WEB_SEARCH_TOOL.name ? webSearch(args ?? {}, { patch: gamePatch }) : withHeroNames(roshanGapPointsToTool(knowledge.has(name) ? { tool: name, ...knowledge.get(name).run(trace, args, ctx) } : runTraceTool(trace, name, args, ctx), trace), names, language)),
    patch: (({ name, hotfix, exact, how, reason }) => ({ name, ...(hotfix ? { hotfix } : {}), exact, ...(how ? { known_from: how } : {}), ...(exact ? {} : { reason }) }))(pd),
    context: { match_id: trace.match_id, player_hero: seat.key, hero_names: names, place_names: placeNames(language), ...(scoreboard(match, seat.key) ? { scoreboard: scoreboard(match, seat.key) } : {}) },
  };
}

/**
 * Every tool answer says, beside the keys it speaks in, what to call the heroes it names: the reader's name of each
 * hero whose key stands in it as a value ("killer": "ursa" → hero_names.ursa = "熊战士"). An item already comes with
 * its name; a hero came only with its key, and the model, told the names once at the start, wrote Ursa as "厄萨"
 * twenty times over (#495). No hero named: the answer is left as it is.
 */
export function withHeroNames(result, names, lang = 'en') {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !names) return result;
  const seen = new Set(); const abilities = new Set();
  const note = (s) => { if (Object.hasOwn(names, s)) seen.add(s); else if (ABILITY_NAMES.has(s)) abilities.add(s); };
  const walk = (v) => {
    if (typeof v === 'string') { note(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'hero_names' || k === 'ability_names') continue; note(k); walk(x); }
  };
  walk(result);
  const named = [...seen].filter((k) => names[k] && names[k] !== k).sort();
  // The same for abilities: ability_audit and the casts speak of "tidehunter_dead_in_the_water", and an ability got
  // from Aghanim's Shard had no name anywhere, so the review called it "the single-target skill learned at 31:50".
  const abilityNamed = [...abilities].sort().map((k) => [k, ABILITY_NAMES.get(k)?.[lang] ?? ABILITY_NAMES.get(k)?.en]).filter(([, n]) => n);
  return named.length || abilityNamed.length ? {
    ...result,
    ...(named.length ? { hero_names: Object.fromEntries(named.map((k) => [k, names[k]])) } : {}),
    ...(abilityNamed.length ? { ability_names: Object.fromEntries(abilityNamed) } : {}),
  } : result;
}
/** Every ability's name by its key: each hero's own, then those from Aghanim's Shard or Scepter and the innate ones. */
const ABILITY_NAMES = new Map([
  ...Object.values(ABILITY_DATA.heroes ?? {}).flat().filter((a) => a?.id).map((a) => [a.id, { en: a.en, zh: a.zh, ru: a.en }]),
  ...Object.entries(ABILITY_DATA.granted ?? {}).map(([k, a]) => [k, { en: a.en, zh: a.zh, ru: a.en, by: a.by }]),
]);

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
  const list = (v) => (Array.isArray(v) ? v : []);
  const fixEv = (ev) => list(ev).map((e) => (e && typeof e === 'object' ? { ...e, fact: fix(e.fact) } : e));
  return {
    ...review,
    verdict: fix(review.verdict),
    ...(typeof review.opening_note === 'string' ? { opening_note: fix(review.opening_note) } : {}),
    ...(Array.isArray(review.highlights) ? { highlights: review.highlights.map((h) => (h && typeof h === 'object' ? { ...h, title: fix(h.title), detail: fix(h.detail), ...(Array.isArray(h.evidence) ? { evidence: fixEv(h.evidence) } : {}) } : h)) } : {}),
    ...(Array.isArray(review.chapters) ? { chapters: review.chapters.map((c) => (c && typeof c === 'object' ? { ...c, title: fix(c.title), analysis: fix(c.analysis), ...(typeof c.takeaway === 'string' ? { takeaway: fix(c.takeaway) } : {}), evidence: fixEv(c.evidence) } : c)) } : {}),
    ...(Array.isArray(review.story) ? { story: review.story.map((l) => (l && typeof l === 'object' ? { ...l, phase: fix(l.phase), what_changed: fix(l.what_changed), because: fix(l.because), evidence: fixEv(l.evidence) } : l)) } : {}),
    mainline: list(review.mainline).map(fix),
    did_well: list(review.did_well).map(fix),
    next_game: list(review.next_game).map(fix),
    ...(typeof review.encouragement === 'string' ? { encouragement: fix(review.encouragement) } : {}),
    blind_spots: list(review.blind_spots).map(fix),
    findings: list(review.findings).map((f) => (f && typeof f === 'object' ? { ...f, title: fix(f.title), claim: fix(f.claim), fix: fix(f.fix), ...(f.rule && typeof f.rule === 'object' ? { rule: { ...f.rule, when: fix(f.rule.when), do: fix(f.rule.do), this_game: fix(f.rule.this_game) } } : {}), evidence: fixEv(f.evidence) } : f)),
    ...(review.game_plan && typeof review.game_plan === 'object' && !Array.isArray(review.game_plan) ? { game_plan: { ...Object.fromEntries(Object.entries(review.game_plan).map(([k, v]) => [k, PLAN_TEXTS.includes(k) ? fix(v) : v])), evidence: fixEv(review.game_plan.evidence) } } : {}),
  };
}
