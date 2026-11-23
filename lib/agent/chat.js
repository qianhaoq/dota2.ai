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
import { deepseekLanguageLock } from '../aiLanguage.js';
import { reviewToolkit, verifyText, nameHeroes } from './deepReview.js';
import { runAgent } from './loop.js';

export const CHAT_MAX_QUESTION = 500;
export const CHAT_MAX_HISTORY = 6;
const HISTORY_ANSWER_CHARS = 1500;
export const CHAT_BUDGET = { maxSteps: 8, maxToolCalls: 6 };

/**
 * The part of a saved review that was checked against the replay when it was
 * built (verifyReview): verdict, mainline, what went well, and each finding's
 * title, claim, evidence and what its rule says happened this game. `fix`, a
 * rule's `when` and `do`, `next_game` and `blind_spots` are advice
 * and were not checked, so they back nothing in a later answer.
 */
export function checkedPart(review) {
  if (!review || typeof review !== 'object') return null;
  return {
    verdict: review.verdict, mainline: review.mainline, did_well: review.did_well,
    findings: (review.findings ?? []).map((f) => ({ title: f?.title, claim: f?.claim, ...(typeof f?.rule?.this_game === 'string' ? { rule_this_game: f.rule.this_game } : {}), evidence: (f?.evidence ?? []).map((e) => ({ clock: e?.clock, fact: e?.fact })) })),
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
- What the tools list under "gaps" is unknown, not false. If the data cannot answer the question (vision, creeps, Roshan, what teammates said), say so plainly instead of guessing.
- Asked which death was the most avoidable, the worst, or the one that should not have happened: call death_context for the player's hero without an index and answer with the first entry of "most_left_unused". That order is fixed by a stated rule so the same question gets the same answer every time. Explain it with that record's facts. You may add that another death cost more for a reason the rule does not weigh (the state of the game), but do not replace the first entry with it. Never state that a hero was or was not in anyone's vision, or what anyone could see: give the distance a tool returned instead.
- When you advise, give a rule the player can use in their next game: the situation as they would see it on their own screen (their health and mana, who is next to them, what an enemy just used, the clock), then one action. "Be more careful" or "position better" is not advice.
- "It was ready and not pressed" is not a reason on its own: advise using an ability or item only for an effect the tools show. An ability under off_cooldown_without_the_mana could not be cast. For what the deaths have in common, quote death_context's counts (deaths_where, damage_share_in_death_windows).
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
  return { question, hero, lang: body?.lang === 'zh' ? 'zh' : 'en', history };
}

/**
 * @param {{ complete: Function, trace: any, hero: string, lang?: string, match?: any, review?: any, question: string, history?: { q: string, a: string, clean?: boolean }[], signal?: AbortSignal, onEvent?: (e: object) => void }} o
 * @returns {Promise<{ status: 'ok' | 'unknown_hero' | 'no_answer', text?: string, unverified?: { kind: string, text: string }[], tool_calls?: object[], usage?: object }>}
 */
export async function runChat({ complete, trace, hero, lang, match = null, review = null, question, history = [], signal, onEvent }) {
  const kit = reviewToolkit({ trace, hero, lang, match });
  if (!kit) return { status: 'unknown_hero' };
  const first = `${JSON.stringify(kit.context)}\n\nReview of this game: ${review ? JSON.stringify(review) : 'none yet'}`;
  const messages = [{ role: 'user', content: first }, { role: 'assistant', content: 'Understood.' }];
  for (const h of history) messages.push({ role: 'user', content: h.q }, { role: 'assistant', content: h.a });
  messages.push({ role: 'user', content: question });
  const base = { complete, system: chatSystem(kit.language), tools: kit.tools, runTool: kit.runTool, signal, onEvent, ...CHAT_BUDGET };
  const usage = { input: 0, output: 0 };
  let run = await runAgent({ ...base, messages });
  usage.input += run.usage.input; usage.output += run.usage.output;
  if (run.status !== 'answered' || !run.text.trim()) return { status: 'no_answer', usage };
  let transcript = run.transcript;
  // The review was verified when it was built. An earlier answer backs this one only if it came back
  // clean: one returned with unsupported facts must not turn them into evidence a turn later.
  // The whole review is context for the model (above); only its checked part is evidence here.
  const checked = checkedPart(review);
  const sources = () => [kit.context, checked, history.filter((h) => h.clean).map((h) => h.a), ...transcript.map((t) => t.result)];
  // Counts the review or a clean earlier answer already stated may be repeated without looking them up again.
  const accepted = [...(checked ? [JSON.stringify(checked)] : []), ...history.filter((h) => h.clean).map((h) => h.a)];
  let check = verifyText(run.text, sources(), accepted);
  if (!check.ok) {
    // The repair runs on what is left of the turn's budget, not on a fresh one.
    const left = { maxToolCalls: Math.max(0, CHAT_BUDGET.maxToolCalls - transcript.length), maxSteps: Math.max(1, CHAT_BUDGET.maxSteps - run.steps) };
    const again = await runAgent({ ...base, ...left, messages: [...run.messages, { role: 'user', content: `These are not in any tool result or in the review: ${check.problems.map((p) => p.text).join(', ')}. Look them up with a tool or rewrite the answer without them.${check.problems.some((p) => p.kind === 'sight') ? ' The replay data has no vision: never say who could see whom; give the distance or position a tool returned instead.' : ''} Reply with the full corrected answer only.` }] });
    usage.input += again.usage.input; usage.output += again.usage.output;
    if (again.status === 'answered' && again.text.trim()) { run = again; transcript = [...transcript, ...again.transcript]; check = verifyText(run.text, sources(), accepted); }
  }
  return {
    status: 'ok',
    text: nameHeroes({ verdict: run.text }, kit.context.hero_names, kit.context.place_names).verdict,
    unverified: check.problems,
    tool_calls: transcript.map((t) => ({ name: t.name, args: t.args })),
    usage,
  };
}
