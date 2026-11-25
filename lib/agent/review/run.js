/**
 * Running a deep review: the investigation, the check, one repair round, and what ships.
 */
import { deathContext, abilityAudit } from '../../../packages/review-engine/src/trace/index.js';
import { heroByKey } from '../../../packages/review-engine/src/staticHeroes.js';
import { goalFromReview } from '../goal.js';
import { HABITS, habitGoal } from '../../coach/goals.js';
import { abilityName } from '../evidence.js';
import { AGENT_DEFAULTS, runAgent, toolContent } from '../loop.js';
import { planByKey, planKey } from '../plans.js';
import { DEEP_REVIEW_PROMPT_VERSION, DEEP_REVIEW_SCHEMA, PLAN_TEXTS, SUBMIT_REVIEW } from './schema.js';
import { deepReviewSystem } from './prompt.js';
import { planOf, str, verifyReview } from './verify.js';
import { nameHeroes, reviewToolkit } from './toolkit.js';

/** A heading for a finding that still has none after the repair round: the opening sentence of its own (checked) claim, never new words. */
export function headingOf(f) {
  if (str(f?.title)) return f.title;
  const first = (str(f?.claim) ?? '').split(/(?<=[。；！？!?;])|(?<=\.)\s/)[0].replace(/[。；;.]$/, '');
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}
/** A finding's rule when it is whole (a situation and an action), else none: half a rule is not shown as one. */
function ruleOf(f, counts = null) {
  const when = str(f?.rule?.when); const act = str(f?.rule?.do); const seen = str(f?.rule?.this_game);
  // The model only says which count the rule is about; the numbers and the wording of the check are made from the replay.
  const check = when && act && counts ? counts(f.rule.counted_by, f.rule.counted_ability) : null;
  return { rule: when && act ? { when, do: act, ...(seen ? { this_game: seen } : {}), ...(check ? { check } : {}) } : undefined };
}
/**
 * What to change next game is the findings' rules, in their order — not a
 * second list written beside them that can drift from what was found. A
 * finding without a whole rule gives its fix.
 */
export function nextGame(findings, lang) {
  return (findings ?? []).map((f) => (f?.rule?.when && f.rule.do ? `${f.rule.when}${lang === 'zh' ? '：' : ': '}${f.rule.do}` : str(f?.fix))).filter(Boolean);
}

const REPAIR_HELP = {
  time: 'this time is not in any tool result',
  number: 'this number is not in any tool result',
  count: 'no tool gave this count; use the count a tool states (killed_by, by_target, *_total)',
  moment: 'the cited record does not hold this; cite the record that does, or remove it',
  ref: 'no tool record with this ref was returned in this conversation; copy a ref exactly',
  missing: 'this finding has no title: give it a heading of a few words',
  language: 'write this in the language of the rest of the review',
  key: 'this is a tool\'s key or field name, not words for the reader: say what it means in the language of the review (a hero or item by its name)',
  name: 'this is not a hero\'s name. If the hero in brackets is meant, write the name exactly as hero_names gives it; otherwise leave it',
  list: 'this time is picked out of a list it is not in: make the sentence agree with itself, using what the tools returned',
  approach: 'a rule cannot start from seeing an enemy come: the replay does not know what was on the player\'s screen. Rewrite the situation from what the player always has: their own health, which allies are near, which enemy heroes are missing from the minimap, the clock, their items',
  vague: 'an amount nobody counted: replace the word with the count a tool states ("4 of the 12 deaths"), or take the claim out',
  sight: 'the replay data has no vision: no tool can say who saw whom. State the distance or position a tool gave, or remove it',
  english: 'these English words stand in a Chinese review: write each in Chinese. A hero, item or ability by the name the tools gave (hero_names, hero_abilities, the item names); Roshan is 肉山 and the Aegis 不朽盾; a tool\'s value such as "typical", "lost" or "even" said in words; an ability\'s English description said in your own Chinese, not quoted',
  dense: 'this sentence states more than two times and numbers (the count is in brackets). A reader keeps two: leave the two that make the point here and let the evidence items and this_game carry the rest. Do not drop a fact from the review, move it',
  turn: 'no finding looks at the fight the game turned on (match_overview\'s turning_fight, at this time). If the player took part in it, make one finding about what they did in it — read it with fight_report, fight_timeline, ability_audit and immunity_windows, and cite those records. If they did not, say in game_plan.your_part where they were, and leave the findings as they are',
};

export const REVIEW_CHECKPOINT_VERSION = 1;
/** The submitted review in an assistant message, or null: what a finished first pass ended on. */
function submittedIn(message) {
  const call = message?.tool_calls?.find((c) => c?.function?.name === SUBMIT_REVIEW.name);
  if (!call) return null;
  try { const args = JSON.parse(call.function.arguments); return args && typeof args === 'object' && !Array.isArray(args) ? args : null; } catch { return null; }
}
/**
 * A saved checkpoint, if it is well formed and for this hero, language and opening message. Whether the
 * replay still says what the saved conversation heard is checked by the caller (lookupAnswers below).
 * Anything else is no checkpoint, and the review starts from the beginning.
 */
function usableCheckpoint(cp, opening, hero, lang) {
  const state = (s) => s && Array.isArray(s.messages) && s.messages.length > 0 && Array.isArray(s.calls) && s.calls.every((c) => typeof c?.name === 'string')
    && Number.isInteger(s.steps) && Number.isFinite(s.usage?.input) && Number.isFinite(s.usage?.output) && s.messages[0]?.content === opening;
  if (!cp || cp.v !== REVIEW_CHECKPOINT_VERSION || cp.opening !== opening || cp.hero !== hero || cp.lang !== lang) return null;
  if (cp.first != null && !(state(cp.first) && submittedIn(cp.first.messages.at(-1)))) return null;
  if (cp.run != null && !(state(cp.run) && Number.isInteger(cp.run.tool_count))) return null;
  return cp.first || cp.run ? cp : null;
}

/**
 * What the lookups in a saved conversation answered, in order, as the model read it: the tool messages, without
 * the loop's own refusals (no tool ran for those), without the answers to a handed-in review, and without the
 * "not run" given to a lookup the model asked for in the same turn as it handed the review in.
 */
function lookupAnswers(messages) {
  const submitted = new Set(); const out = [];
  for (const m of messages) {
    if (m?.role === 'assistant') for (const c of m.tool_calls ?? []) if (c?.function?.name === SUBMIT_REVIEW.name) submitted.add(c.id);
    if (m?.role === 'tool' && !submitted.has(m.tool_call_id) && !/^\{"error":"(tool_budget_spent|invalid_arguments|unknown_tool|not_run|unsupported_facts)"/.test(String(m.content))) out.push(String(m.content));
  }
  return out;
}

/**
 * Run the investigation and return a verified review.
 *
 * `onCheckpoint` is handed, after every finished round of lookups, what is needed to continue this run
 * elsewhere: the conversation so far and which tools were asked (not their results: a tool's answer is a
 * pure function of the replay and is computed again). `checkpoint` is such an object from a run that was
 * cut off; the review then continues after its last finished round instead of starting over. One that does
 * not fit this hero and language is ignored, and so is one whose lookups answer differently now (the replay
 * was parsed again, or a tool changed): the saved conversation would be about another game.
 * @param {{ complete: Function, trace: any, hero: string, lang?: string, plan?: string | null, match?: any, signal?: AbortSignal, onEvent?: (e: object) => void, maxSteps?: number, maxToolCalls?: number, checkpoint?: any, onCheckpoint?: (c: object) => void }} o
 */
export async function runDeepReview({ complete, trace, hero, lang, plan = null, match = null, signal, onEvent, maxSteps, maxToolCalls, checkpoint = null, onCheckpoint = null }) {
  const kit = reviewToolkit({ trace, hero, lang, match });
  if (!kit) return { status: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
  const { seat, language, context } = kit;
  // The loop's own cut of a long tool answer: a checkpoint is compared against answers cut the same way.
  const maxToolChars = AGENT_DEFAULTS.maxToolChars;
  const base = {
    complete, system: deepReviewSystem(language), tools: [...kit.tools, SUBMIT_REVIEW], signal, onEvent, maxSteps, maxToolCalls, maxToolChars,
    runTool: kit.runTool,
    isFinal: (call) => call.name === SUBMIT_REVIEW.name,
    finalTools: [SUBMIT_REVIEW.name],
  };
  const usage = { input: 0, output: 0 }; let steps = 0;
  const add = (r) => { usage.input += r.usage.input; usage.output += r.usage.output; steps += r.steps; };

  // The plan the player says they went for, when they named one: part of what the review is asked, so a
  // checkpoint made for another plan (or none) is never continued from.
  const stated = planByKey(planKey(plan));
  const opening = `Review this game for the player on ${seat.key}.${stated ? `\nThe player says their plan this game was to ${stated.for_the_model} (in their words: "${stated.said.en}"). Read the game against it in game_plan.against_your_plan.` : ''}\n${JSON.stringify(context)}`;
  let from = usableCheckpoint(checkpoint, opening, seat.key, language);
  // What a tool answered is not kept in a checkpoint: asked again, it answers the same.
  const again = async (calls) => { const out = []; for (const c of calls) { let result; try { result = await kit.runTool(c.name, c.args ?? {}); } catch { result = { error: 'tool_failed' }; } out.push({ name: c.name, args: c.args ?? {}, result }); } return out; };
  const pack = (s) => ({ messages: s.messages, calls: s.transcript.map((t) => ({ name: t.name, args: t.args })), steps: s.steps, usage: s.usage });
  const save = (first, run) => onCheckpoint?.({ v: REVIEW_CHECKPOINT_VERSION, hero: seat.key, lang: language, opening, first, run });
  // Continue only if every saved lookup answers now what the model read then.
  let firstAgain = null; let runAgain = null;
  if (from) {
    firstAgain = from.first ? await again(from.first.calls) : null;
    runAgain = from.run ? await again(from.run.calls) : null;
    const same = (t, answers) => t.length === answers.length && t.every((x, i) => toolContent(x.result, maxToolChars) === answers[i]);
    const firstAnswers = from.first ? lookupAnswers(from.first.messages) : [];
    if ((from.first && !same(firstAgain, firstAnswers)) || (from.run && !same(runAgain, lookupAnswers(from.run.messages).slice(firstAnswers.length)))) from = null;
  }
  const resumed = (s) => ({ steps: s.steps, calls: s.tool_count, usage: s.usage, transcript: runAgain });
  if (from) onEvent?.({ type: 'resumed', tools: [...(from.first?.calls ?? []), ...(from.run?.calls ?? [])] });

  let first;
  if (from?.first) {
    // The first pass was finished when the run was cut off: its submitted review stands.
    first = { status: 'final', final: submittedIn(from.first.messages.at(-1)), messages: from.first.messages, transcript: firstAgain, steps: from.first.steps, usage: from.first.usage };
  } else {
    first = await runAgent({
      ...base,
      messages: from?.run ? from.run.messages : [{ role: 'user', content: opening }],
      ...(from?.run ? { resume: resumed(from.run) } : {}),
      onCheckpoint: (s) => save(null, { ...pack(s), tool_count: s.calls }),
    });
  }
  add(first);
  if (first.status !== 'final') return { status: first.status === 'budget' ? 'budget' : 'no_review', steps, usage, transcript: first.transcript };
  let review = first.final; let transcript = first.transcript;
  const sources = () => [context, ...transcript.map((t) => t.result)];
  let check = verifyReview(review, sources());
  const firstProblems = check.problems;
  let repaired = false;
  if (!check.ok) {
    // One repair round: name exactly what is unsupported; the model may look it up or take it out.
    repaired = true;
    const lastCall = first.messages.at(-1).tool_calls.find((c) => c.function.name === SUBMIT_REVIEW.name);
    const done = pack(first);
    const midRepair = from?.first && from.run ? from.run : null;
    if (!midRepair) save(done, null);
    const second = await runAgent({
      ...base,
      ...(midRepair ? { resume: resumed(midRepair) } : {}),
      // The repair round's own counts start at zero; what it had used when cut off comes back with `resume`.
      onCheckpoint: (s) => save(done, { ...pack(s), tool_count: s.calls }),
      messages: midRepair ? midRepair.messages : [...first.messages, ...first.messages.at(-1).tool_calls.map((c) => ({
        role: 'tool', tool_call_id: c.id,
        content: c === lastCall ? JSON.stringify({ error: 'unsupported_facts', detail: 'Look each one up with a tool, or rewrite the sentence without it, then call submit_review again with the whole review.', problems: check.problems.map((p) => ({ in: p.where === 'findings' ? 'findings' : p.where === 'plan' ? `game_plan.${PLAN_TEXTS[p.index]}` : p.where === 'plan_evidence' ? `game_plan.evidence ${p.index + 1}` : p.where === 'finding' ? `finding ${p.index + 1}` : p.where === 'title' ? `finding ${p.index + 1}, title` : p.where === 'rule' ? `finding ${p.index + 1}, rule.this_game` : `${p.where}${p.where === 'verdict' ? '' : ` ${p.index + 1}`}`, text: p.text, why: REPAIR_HELP[p.kind] })) }) : JSON.stringify({ error: 'not_run' }),
      }))],
    });
    add(second);
    if (second.status === 'final') { review = second.final; transcript = [...transcript, ...second.transcript]; check = verifyReview(review, sources()); }
  }
  // Whatever still states something the tools never said does not ship.
  // A finding goes when its own text is unsupported or none of its evidence holds; one bad evidence item alone
  // is left out and the finding stays on the rest.
  const bad = (where) => (where === 'finding' ? check.unsupported.findings : new Set(check.problems.filter((p) => p.where === where && !p.soft).map((p) => p.index)));
  // A model's arguments are not schema-checked: a finding may be null or carry evidence that is no list. Those are
  // dropped below (they cite nothing); here they are only passed through untouched.
  const holds = (f, i) => (Array.isArray(f?.evidence) ? { ...f, evidence: f.evidence.filter((_, j) => !check.unsupported.evidence.get(i)?.has(j)) } : f);
  const keep = (list, where) => (list ?? []).filter((_, i) => !bad(where).has(i));
  const fmtClock = (t) => `${t < 0 ? '-' : ''}${Math.floor(Math.abs(Math.trunc(t)) / 60)}:${String(Math.abs(Math.trunc(t)) % 60).padStart(2, '0')}`;
  // Each evidence item gets the game time of the first record it cites, for the reader.
  const keptIndex = (review.findings ?? []).map((_, i) => i).filter((i) => !bad('finding').has(i));
  const picked = goalFromReview(review.goal, { trace, hero: seat.key, findings: (review.findings ?? []).length, match });
  // The goal follows its finding; a goal whose finding was dropped goes with it.
  const goal = picked && keptIndex.includes(picked.finding - 1) ? { ...picked.spec, finding: keptIndex.indexOf(picked.finding - 1) + 1 } : null;
  // A rule whose "this game" states something the tools never said keeps its situation and action and loses that sentence.
  const unbacked = bad('rule');
  // The check for a count the model named: over the deaths, or over one of the hero's own abilities (by its
  // name in the ability data). Anything else — another hero's ability, an unknown key, a count of one — is no check.
  const counts = (habit, ability) => {
    if (HABITS[habit]?.from === 'deaths') { const d = deathContext(trace, { hero: seat.key }); return d.error ? null : habitGoal(habit, d); }
    if (HABITS[habit]?.from !== 'audit' || typeof ability !== 'string') return null;
    const a = abilityAudit(trace, { hero: seat.key, ability });
    const name = a.error ? null : abilityName(a.ability);
    const heroId = heroByKey(seat.key)?.id;
    // One of the hero's own abilities: they are named after the internal slug, which the replay's key may differ from.
    if (!name || heroId == null || !(a.ability.startsWith(`${seat.key}_`) || a.ability.startsWith(`${heroByKey(seat.key)?.internalSlug}_`))) return null;
    return habitGoal(habit, a, { hero: seat.key, hero_id: heroId, ability: a.ref.split(':')[2], name });
  };
  // One check per count: two rules about the same count would be judged as one thing twice.
  const counted = new Set();
  const once = (f) => { const h = f.rule?.check ? `${f.rule.check.habit}:${f.rule.check.ability ?? ''}` : null; if (!h) return f; if (counted.has(h)) { const { check, ...rule } = f.rule; return { ...f, rule }; } counted.add(h); return f; };
  const findings = (review.findings ?? []).map(holds).map((f, i) => (unbacked.has(i) && f?.rule ? { ...f, rule: { ...f.rule, this_game: undefined } } : f)).filter((_, i) => !bad('finding').has(i)).map((f) => once({ ...f, title: headingOf(f), ...ruleOf(f, counts) })).map((f) => ({ ...f, evidence: (f.evidence ?? []).map((e) => { const at = check.refs.get(e.refs?.[0])?.at; return { refs: e.refs, ...(at == null ? {} : { clock: fmtClock(at) }), fact: e.fact }; }) }));
  const verdict = bad('verdict').size ? findings[0]?.title ?? '' : review.verdict ?? '';
  const gamePlan = planOf(review.game_plan, check.problems, check.refs, { stated: Boolean(stated) });
  return {
    status: findings.length ? 'ok' : 'unverified',
    review: nameHeroes({
      schema: DEEP_REVIEW_SCHEMA, prompt_version: DEEP_REVIEW_PROMPT_VERSION, match_id: trace.match_id, hero: seat.key, lang: language, ...(stated ? { plan: stated.key } : {}),
      // Which patch's prices, item effects and cooldowns the review's numbers are from, and how that patch is known.
      data_patch: kit.patch,
      verdict, mainline: keep(review.mainline, 'mainline'), findings, did_well: keep(review.did_well, 'did_well'), next_game: nextGame(findings, language), blind_spots: review.blind_spots ?? [],
      ...(gamePlan ? { game_plan: gamePlan } : {}),
      ...(goal ? { goal } : {}),
    }, context.hero_names, context.place_names),
    verification: { repaired, first_pass_problems: firstProblems.length, dropped: (review.findings ?? []).length - findings.length, problems: check.problems },
    // What did not ship, as it was written: for whoever has to find out why (never shown to the reader).
    dropped_findings: (review.findings ?? []).filter((_, i) => bad('finding').has(i)),
    tool_calls: transcript.map((t) => ({ name: t.name, args: t.args })),
    steps, usage,
  };
}