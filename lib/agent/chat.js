/**
 * The coach chat: one question about one player's game, answered by the
 * agent with the same lookup tools as the deep review. Unlike the old
 * follow-up ("answer only from the report"), it can go and look.
 *
 * The answer is checked like a review's prose (verifyText): times and
 * numbers must be in what the tools returned this turn, in the review, or in
 * the earlier answers of this conversation that came back clean. One repair round; what is still
 * unsupported is reported with the answer, never hidden.
 */
import { deepseekLanguageLock, normalizeUiLang } from '../aiLanguage.js';
import { reviewToolkit, verifyText, nameHeroes } from './deepReview.js';
import { runAgent } from './loop.js';
import { planByKey, planKey } from './plans.js';
import { mergeUsages } from './usage.js';
import { isWebSearchResult } from './webSearch.js';

export const CHAT_MAX_QUESTION = 500;
export const CHAT_MAX_HISTORY = 6;
const HISTORY_ANSWER_CHARS = 1500;
export const CHAT_BUDGET = { maxSteps: 8, maxToolCalls: 6 };

/**
 * The part of a saved review that was checked against the replay when it was
 * built (verifyReview): verdict, mainline, what went well, each finding's
 * title, claim, evidence and what its rule says happened this game, and the
 * game plan's sentences and evidence. `fix`, a
 * rule's `when` and `do`, `next_game` and `blind_spots` are advice
 * and were not checked, so they back nothing in a later answer.
 */
export function checkedPart(review) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) return null;
  const list = (v) => (Array.isArray(v) ? v : []);
  const mapEv = (ev) => list(ev).map((e) => ({ clock: e?.clock, fact: e?.fact }));
  const highlights = list(review.highlights).filter((h) => h && typeof h === 'object');
  const chapters = list(review.chapters).filter((c) => c && typeof c === 'object');
  const gp = review.game_plan && typeof review.game_plan === 'object' && !Array.isArray(review.game_plan) ? review.game_plan : null;
  return {
    verdict: review.verdict,
    ...(typeof review.opening_note === 'string' && review.opening_note.trim() ? { opening_note: review.opening_note } : {}),
    ...(highlights.length ? {
      highlights: highlights.map((h) => ({
        title: h.title, detail: h.detail,
        ...(Array.isArray(h.evidence) && h.evidence.length ? { evidence: mapEv(h.evidence) } : {}),
      })),
    } : {}),
    ...(chapters.length ? {
      chapters: chapters.map((c) => ({
        topic: c.topic, title: c.title, analysis: c.analysis,
        ...(typeof c.takeaway === 'string' && c.takeaway.trim() ? { takeaway: c.takeaway } : {}),
        evidence: mapEv(c.evidence),
      })),
    } : {}),
    mainline: review.mainline, did_well: review.did_well,
    findings: list(review.findings).map((f) => ({ title: f?.title, claim: f?.claim, ...(typeof f?.rule?.this_game === 'string' ? { rule_this_game: f.rule.this_game } : {}), evidence: mapEv(f?.evidence) })),
    ...(typeof review.encouragement === 'string' && review.encouragement.trim() ? { encouragement: review.encouragement } : {}),
    // The game plan's sentences and evidence were checked too; which reason it names is a judgment and backs nothing.
    ...(gp ? { game_plan: { against_your_plan: gp.against_your_plan, window: gp.window, strengths: gp.strengths, line_ups: gp.line_ups, course: gp.course, your_part: gp.your_part, why: gp.why, evidence: mapEv(gp.evidence) } } : {}),
  };
}

export function chatSystem(lang) {
  return `${deepseekLanguageLock(lang)}

You are a Dota 2 coach answering a player's question about one of their games. You teach judgment: say what happened, why it mattered, and what to do instead.

You have tools that query the parsed replay and the site's data on heroes and items. The review of this game (if one exists) is in the first message. Look things up before you answer; do not answer from the review alone when the question is about a moment the tools can show.

READING THE TOOLS
- Everything is told from the player's side: "me" is the player, "ally"/"my_team" their team, "enemy" the other. my_team_gold_lead is negative when the player's team is behind.
- Call heroes by the names in hero_names and places by the names in place_names. Never leave an engine key such as "dire_top_lane", or half of one, in the answer.

RULES
- Every time (m:ss) and every number you state about the game must be one a tool returned in this conversation or one in the review. Quote; do not compute new numbers. For a count, use the count a tool gives.
- Never state what an ability or item does from memory: hero_abilities says what Valve lists; ability_audit says what happened in this game.
- Asked about the lane or the first ten minutes: lane_report first (last hits, gold and XP at 10:00, deaths before 10:00, how the matchup usually goes). A lane behind by what the matchup usually gives is the draft's, not the player's.
- Asked about the game plan, the strategy, tempo, objectives, or whether an approach was right against this line-up: window_report for the player first (the team's gold lead over the game, and each window one side was ahead with what it took in it and the big items each side finished in it and just before it ended), then tempo_report (in each ten-minute stretch the buildings each side took, the fights and whether a building followed, where the player spent their living time, which fights they were at) and lineup_timing (which heroes of each side win more in shorter or in longer public games, and which length this game had). In tempo_report "team" is the team of the hero asked about and "opponents" the other.
- When the player says what they were trying to do ("my plan was to take towers early"), take that as their plan — it is theirs to say, the replay cannot show it — and answer three things in this order. One: did what they did fit it, from their own numbers — their items (build_for_plan with that plan: the first item for it and when, the gold in other items before it), where they were, the fights they were at, the buildings they damaged. Two: does the public data on these ten heroes support it (lineup_timing); when it shows no lean, say the data does not settle it. Three: where it broke — their own play, the team's (they were there and the team still took nothing, or had a window and took little in it), or what the enemy did (their fights turned into buildings; what they had finished by the time the window ended, from window_report; who on their side got richest while the team was ahead, and whether they stood by the buildings the team took, from farm_report). An item finished before a window ended is listed beside it, not proven to have ended it: say when it came, not that it closed the window. Name the one the numbers point to, and say so plainly when it was not the player's doing. Never tell the player what they "intended" when they have not said it.
- tempo_report has no creeps: where the player stood is not what they were doing there. Say "pushing" only with their damage to buildings, never "farming". lineup_timing measures each hero alone: say "public games", name the heroes, and do not call a mean of five heroes the line-up's win rate.
- Asked about a fight, why it was lost, or where everyone was at a moment: fight_report for the player (how many heroes each side brought, which ultimates and Black King Bars were ready, what each hero not in it was doing and whether their TP was ready), or game_state at that second. A hero not in a fight dealt and took no damage from enemy heroes in it: say so and what the replay shows them doing, never that they refused or were farming.
- Asked about a death (including which death mattered most or was most avoidable): call death_context for the player and inspect both sides — not only the player's own health, mana and unused spells, but enemy status and kill threat (enemy_context_at_window_start ready/cooldown abilities and key items, attackers_arrived_after_window_start, enemy_active_buffs_in_window, disables landed, enemy ultimates absorbed, nearby fights/objectives, and whether it was traded). A death not traded bought nothing; that is the cost to name.
- Asked about skill build, ability leveling order, or ultimate timings: call skill_build for that hero.
- Asked about wards or vision: death_context (observers_within_1600 at each death) and fight_report (each side's observers near each fight). A ward near a spot is not proof the spot was seen; null means the replay of this game has no ward list.
- Asked why fights were won but the game was not, or what to do after a won fight: decision_points for the player (after each won fight, the enemies still dead and for how long, whether their richest hero was one of them, and whether the winners took a building, Roshan, pushed for nothing, or took nothing; and after each tier 1–3 tower, what its takers did next, what they lost meanwhile, and where the player was). Asked why a tower was lost: the same tool's after_a_tower_fell points. Asked whether a fight was taken into an enemy's fresh item (BKB, Blink…): its fight_after_a_big_item points.
- Asked about Roshan, the Aegis or a Tormentor: roshan_report for the player (each Roshan: who took it, who was there, used or expired, what each side took in the 300 s after; and when the replay kept the kill, who hit it, for how long, and where each hero of the other side stood when it began — where they stood, not what they saw). With read_from "aegis_pickups_only", no Aegis in it is not proof no Roshan died.
- Asked why a tower fell, why a push failed, or about objectives: siege_report for the player (every push on a building: who hit it, which owners were near, whether it fell, where everyone else was when the push began). Being near a building is not defending it. The places it lists are from the push's start: never give them as where a hero was when the building fell. For that second, me_when_it_fell says where the player was, and game_state at fell_at where anyone else was.
- What the tools list under "gaps" is unknown, not false. If the data cannot answer the question (vision, creeps, a Roshan whose Aegis nobody picked up, what teammates said), say so plainly instead of guessing; Roshan is known from roshan_report.
- Never state that a hero was or was not in anyone's vision, or what anyone could see: give the distance a tool returned instead.
- When you advise, give a rule the player can use in their next game: the situation as they would see it on their own screen (their health and mana, who is next to them, what an enemy just used or holds, the clock), then one action. "Be more careful" or "position better" is not advice.
- "It was ready and not pressed" is not a reason on its own: check enemy kill threat, disables landed, and whether the spell or item could actually change the outcome before advising its use. An ability under off_cooldown_without_the_mana could not be cast. For what the deaths have in common, quote death_context's counts (deaths_where, damage_share_in_death_windows).
- Write for a player, not a programmer: never show tool or field names (ready_not_cast, controls_on_me) or engine keys (item_magic_wand, beastmaster_summon_thunderhide). Use the game's names for heroes, abilities and items.
- Speak to the player as "you" throughout, never "he" or "the player".
- Only Dota and this game. For anything else, say you can only help with this review.
- Answer the question first, in a few short paragraphs or a short list. No preamble, no recap of the question.`;
}

/** Validate a chat request body. */
export function parseChatBody(body) {
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (!question) return { error: 'empty_question' };
  if (question.length > CHAT_MAX_QUESTION) return { error: 'question_too_long' };
  const hero = typeof body?.hero === 'string' ? body.hero.trim().slice(0, 40) : '';
  if (!hero) return { error: 'invalid_hero' };
  const history = Array.isArray(body?.history) ? body.history.slice(-CHAT_MAX_HISTORY)
    .filter((h) => typeof h?.q === 'string' && typeof h?.a === 'string')
    // `clean`: that answer came back with nothing unsupported. Only such answers back a later one.
    .map((h) => ({ q: h.q.trim().slice(0, CHAT_MAX_QUESTION), a: h.a.trim().slice(0, HISTORY_ANSWER_CHARS), clean: h.clean === true }))
    .filter((h) => h.q && h.a) : [];
  // The plan the review on the page was made for, if the reader named one; anything else is no plan.
  const plan = planKey(body?.plan);
  // The model that wrote the review on the page, as the page names it: whether it is offered here is the router's to say.
  const model = body?.model == null || body.model === '' ? undefined : typeof body.model === 'string' ? body.model.slice(0, 64) : false;
  return { question, hero, lang: normalizeUiLang(body?.lang), history, plan: plan ?? undefined, model };
}

/**
 * @param {{ complete: Function, trace: any, hero: string, lang?: string, plan?: string | null, match?: any, review?: any, question: string, history?: { q: string, a: string, clean?: boolean }[], signal?: AbortSignal, onEvent?: (e: object) => void }} o
 * @returns {Promise<{ status: 'ok' | 'unknown_hero' | 'no_answer', text?: string, unverified?: { kind: string, text: string }[], tool_calls?: object[], usage?: object }>}
 */
export async function runChat({ complete, trace, hero, lang, plan = null, match = null, review = null, question, history = [], signal, onEvent }) {
  const kit = reviewToolkit({ trace, hero, lang, match });
  if (!kit) return { status: 'unknown_hero' };
  // The plan the player named for this game, if they did: theirs to say, and what their questions are about.
  const stated = planByKey(planKey(plan));
  const first = `${JSON.stringify(kit.context)}${stated ? `\n\nThe player says their plan this game was to ${stated.for_the_model} (in their words: "${stated.said.en}").` : ''}\n\nReview of this game: ${review ? JSON.stringify(review) : 'none yet'}`;
  const messages = [{ role: 'user', content: first }, { role: 'assistant', content: 'Understood.' }];
  for (const h of history) messages.push({ role: 'user', content: h.q }, { role: 'assistant', content: h.a });
  messages.push({ role: 'user', content: question });
  const base = { complete, system: chatSystem(kit.language), tools: kit.tools, runTool: kit.runTool, signal, onEvent, ...CHAT_BUDGET };
  let run = await runAgent({ ...base, messages });
  const stageUsages = [run.usage];
  let truncationRetries = run.truncation_retries ?? 0;
  let repairRounds = 0;
  if (run.status !== 'answered' || !run.text.trim()) {
    const usage = mergeUsages(stageUsages);
    return { status: 'no_answer', usage, usage_source: usage.source, repair_rounds: repairRounds, truncation_retries: truncationRetries };
  }
  let transcript = run.transcript;
  const firstUsedCalls = transcript.length + (run.duplicate_tool_calls ?? 0);
  // The review was verified when it was built. An earlier answer backs this one only if it came back
  // clean: one returned with unsupported facts must not turn them into evidence a turn later.
  // The whole review is context for the model (above); only its checked part is evidence here.
  const checked = checkedPart(review);
  // A web page is reading for the model, never a fact the answer may state (webSearch.js).
  const sources = () => [kit.context, checked, history.filter((h) => h.clean).map((h) => h.a), ...transcript.map((t) => t.result).filter((r) => !isWebSearchResult(r))];
  // Counts the review or a clean earlier answer already stated may be repeated without looking them up again.
  const accepted = [...(checked ? [JSON.stringify(checked)] : []), ...history.filter((h) => h.clean).map((h) => h.a)];
  let check = verifyText(run.text, sources(), accepted);
  if (!check.ok) {
    // The repair runs on what is left of the turn's budget, not on a fresh one.
    repairRounds = 1;
    const left = { maxToolCalls: Math.max(0, CHAT_BUDGET.maxToolCalls - firstUsedCalls), maxSteps: Math.max(1, CHAT_BUDGET.maxSteps - run.steps) };
    const again = await runAgent({ ...base, ...left, messages: [...run.messages, { role: 'user', content: `These are not in any tool result or in the review: ${check.problems.map((p) => p.text).join(', ')}. Look them up with a tool or rewrite the answer without them.${check.problems.some((p) => p.kind === 'sight') ? ' The replay data has no vision: never say who could see whom; give the distance or position a tool returned instead.' : ''} Reply with the full corrected answer only.` }] });
    stageUsages.push(again.usage);
    truncationRetries += again.truncation_retries ?? 0;
    if (again.status === 'answered' && again.text.trim()) { run = again; transcript = [...transcript, ...again.transcript]; check = verifyText(run.text, sources(), accepted); }
  }
  const usage = mergeUsages(stageUsages);
  return {
    status: 'ok',
    text: nameHeroes({ verdict: run.text }, kit.context.hero_names, kit.context.place_names).verdict,
    unverified: check.problems,
    tool_calls: transcript.map((t) => ({ name: t.name, args: t.args })),
    repair_rounds: repairRounds,
    truncation_retries: truncationRetries,
    usage_source: usage.source,
    usage,
  };
}
