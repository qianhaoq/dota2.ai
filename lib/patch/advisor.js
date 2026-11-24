/**
 * The patch advisor: one question about the current patch, answered by the
 * agent with the lookup tools of ./tools.js — what Valve's notes changed, and
 * how public win rates and pick rates moved since.
 *
 * Like the coach chat (lib/agent/chat.js) the answer is checked before it is
 * shown (verifyText): every time and number must be in what the tools
 * returned this turn, or in an earlier answer of the conversation that came
 * back clean. One repair round; what is still unsupported is returned with
 * the answer, never hidden.
 */
import { createRequire } from 'node:module';
import { deepseekLanguageLock, normalizeUiLang } from '../aiLanguage.js';
import { nameHeroes, verifyText } from '../agent/deepReview.js';
import { runAgent } from '../agent/loop.js';
import { META_SOURCE, PATCH } from './data.js';
import { PATCH_TOOLS, runPatchTool } from './tools.js';

const NAMES = createRequire(import.meta.url)('../coach/data/names.json');

export const ADVISOR_MAX_QUESTION = 500;
export const ADVISOR_MAX_HISTORY = 6;
const HISTORY_ANSWER_CHARS = 1500;
export const ADVISOR_BUDGET = { maxSteps: 8, maxToolCalls: 6 };

export function advisorSystem(lang) {
  return `${deepseekLanguageLock(lang)}

You are a Dota 2 analyst answering questions about patch ${PATCH.version}: what it changed, and how heroes are doing since. You help a player decide what to pick, what to expect and what to stop doing.

You have tools over two sources, and nothing else:
- Valve's patch notes for ${PATCH.version}, line by line (hero_patch, item_patch, general_changes, search_notes).
- Public win rates and pick rates of every hero in the days before the patch and since (STRATZ; patch_overview, hero_patch, meta_movers), over all brackets and per rank bracket.
Look things up before you answer. Do not answer from memory: what you remember of this game may be from another patch.

RULES
- A change you state must be a line the tools returned. Quote its numbers exactly ("600/725/850 to 570/685/800"); do not round them, add them up or turn them into percentages of your own.
- A win rate or pick rate must be one a tool returned. Say which days it covers when you first give one (the tools return the two windows), and that it is public matches. pick_rate is the share of matches the hero was in; pick_rate_times is how many times what it was (1.5 = half again as often).
- "rose", "fell" and "about_the_same" are the tools' verdicts by a stated rule. Do not call a change the rule calls "about_the_same" a rise or a fall, and say "too few games" when a rate is null.
- After is not because. A win rate that moved since the patch moved while every hero, the items and the map changed too. You may set the hero's own notes next to its numbers and say they point the same way, or do not; never state that one line caused the change. When a hero's numbers moved and the notes do not change the hero at all, say exactly that — it is the most useful thing to know.
- The numbers are few days of a new patch: say so when the answer rests on them, and that they will move.
- What the tools list under "gaps" is unknown, not false: no item win or purchase rates, no professional matches, no reasons. If the data cannot answer the question, say so plainly.
- Asked what to pick or who is strong: answer for the asker's bracket if they named one (meta_movers and hero_patch take a bracket), else over all brackets and say so. A high win rate with a tiny pick rate is a small sample of specialists: give both numbers.
- Call heroes, abilities and items by the names the tools give. Never show a tool or field name (win_rate_change_in_points) or an engine key (skeleton_king).
- Only Dota and this patch. For anything else, say you can only help with patch ${PATCH.version}. For a question about one of the asker's own games, say the match review on this site does that.
- Answer the question first, in a few short paragraphs or a short list. No preamble, no recap of the question.`;
}

/** Validate an advisor request body. */
export function parseAdvisorBody(body) {
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (!question) return { error: 'empty_question' };
  if (question.length > ADVISOR_MAX_QUESTION) return { error: 'question_too_long' };
  const history = Array.isArray(body?.history) ? body.history.slice(-ADVISOR_MAX_HISTORY)
    .filter((h) => typeof h?.q === 'string' && typeof h?.a === 'string')
    // `clean`: that answer came back with nothing unsupported. Only such answers back a later one.
    .map((h) => ({ q: h.q.trim().slice(0, ADVISOR_MAX_QUESTION), a: h.a.trim().slice(0, HISTORY_ANSWER_CHARS), clean: h.clean === true }))
    .filter((h) => h.q && h.a) : [];
  return { question, lang: body?.lang === 'zh' ? 'zh' : 'en', history };
}

/** What every answer may state without looking it up: the patch, its date and the days the numbers cover. */
export function advisorContext(lang) {
  const language = normalizeUiLang(lang);
  return {
    patch: PATCH.version, released: PATCH.released, notes: PATCH.url,
    numbers: { source: META_SOURCE.source, before_the_patch: META_SOURCE.before, since_the_patch: META_SOURCE.after, fetched: META_SOURCE.fetched },
    language,
  };
}

/**
 * @param {{ complete: Function, lang?: string, question: string, history?: { q: string, a: string, clean?: boolean }[], signal?: AbortSignal, onEvent?: (e: object) => void }} o
 * @returns {Promise<{ status: 'ok' | 'no_answer', text?: string, unverified?: { kind: string, text: string }[], tool_calls?: object[], usage?: object }>}
 */
export async function runAdvisor({ complete, lang, question, history = [], signal, onEvent }) {
  const context = advisorContext(lang);
  const ctx = { lang: context.language };
  const tools = PATCH_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  const messages = [{ role: 'user', content: JSON.stringify(context) }, { role: 'assistant', content: 'Understood.' }];
  for (const h of history) messages.push({ role: 'user', content: h.q }, { role: 'assistant', content: h.a });
  messages.push({ role: 'user', content: question });
  const base = { complete, system: advisorSystem(context.language), tools, runTool: (name, args) => runPatchTool(name, args, ctx), signal, onEvent, ...ADVISOR_BUDGET };
  const usage = { input: 0, output: 0 };
  let run = await runAgent({ ...base, messages });
  usage.input += run.usage.input; usage.output += run.usage.output;
  if (run.status !== 'answered' || !run.text.trim()) return { status: 'no_answer', usage };
  let transcript = run.transcript;
  const clean = history.filter((h) => h.clean).map((h) => h.a);
  const sources = () => [context, clean, ...transcript.map((t) => t.result)];
  let check = verifyText(run.text, sources(), clean);
  if (!check.ok) {
    // The repair runs on what is left of the turn's budget, not on a fresh one.
    const left = { maxToolCalls: Math.max(0, ADVISOR_BUDGET.maxToolCalls - transcript.length), maxSteps: Math.max(1, ADVISOR_BUDGET.maxSteps - run.steps) };
    const again = await runAgent({ ...base, ...left, messages: [...run.messages, { role: 'user', content: `These are not in any tool result: ${check.problems.map((p) => p.text).join(', ')}. Look them up with a tool or rewrite the answer without them. Quote numbers exactly as the tools give them. Reply with the full corrected answer only.` }] });
    usage.input += again.usage.input; usage.output += again.usage.output;
    if (again.status === 'answered' && again.text.trim()) { run = again; transcript = [...transcript, ...again.transcript]; check = verifyText(run.text, sources(), clean); }
  }
  // An engine key the model let through is replaced with the hero's name, as in a review.
  const names = Object.fromEntries(Object.values(NAMES.heroes).map((h) => [h.slug, h[context.language] ?? h.en]));
  return {
    status: 'ok',
    text: nameHeroes({ verdict: run.text }, names).verdict,
    unverified: check.problems,
    tool_calls: transcript.map((t) => ({ name: t.name, args: t.args })),
    usage,
  };
}
