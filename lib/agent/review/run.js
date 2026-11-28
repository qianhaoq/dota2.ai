/**
 * Running a deep review: the investigation, the check, one repair round, and what ships.
 */
import { AGENT_DEFAULTS, runAgent, toolContent } from '../loop.js';
import { planByKey, planKey } from '../plans.js';
import { mergeUsages, normalizeStepUsage } from '../usage.js';
import { DEEP_REVIEW_PROMPT_VERSION, DEEP_REVIEW_SCHEMA, MAX_FINDINGS, PLAN_TEXTS, SUBMIT_REVIEW } from './schema.js';
import { deepReviewSystem } from './prompt.js';
import { chaptersOf, highlightsOf, planGapOf, planOf, str, suggestChildRefs, verifyReview } from './verify.js';
import { nameHeroes, reviewToolkit } from './toolkit.js';
import { translateReview } from './translate.js';
import { WEB_SEARCH_TOOL, isWebSearchResult } from '../webSearch.js';

/** A heading for a finding that still has none after the repair round: the opening sentence of its own (checked) claim, never new words. */
export function headingOf(f) {
  if (str(f?.title)) return f.title;
  const first = (str(f?.claim) ?? '').split(/(?<=[。；！？!?;])|(?<=\.)\s/)[0].replace(/[。；;.]$/, '');
  return first.length > 60 ? `${first.slice(0, 59)}…` : first;
}

const REPAIR_HELP = {
  time: 'this time is not in any tool result',
  number: 'this number is not in any tool result',
  count: 'no tool gave this count; use the count a tool states (killed_by, by_target, *_total)',
  moment: 'the cited record does not hold this (summary refs only cover top-level totals, not individual events); if suggested_refs are listed, verify and cite the specific child ref(s), or remove the unsupported detail',
  ref: 'no tool record with this ref was returned in this conversation; copy a ref exactly',
  missing: 'this finding has no title: give it a heading of a few words',
  language: 'write this in the language of the rest of the review',
  key: 'this is a tool\'s key or field name, not words for the reader: say what it means in the language of the review (a hero or item by its name)',
  name: 'this is not a hero\'s name. If the hero in brackets is meant, write the name exactly as hero_names gives it; otherwise leave it',
  list: 'this time is picked out of a list it is not in: make the sentence agree with itself, using what the tools returned',
  unnamed: 'this hero killed the player again and again, but the review never calls it by this name. If the review calls it something else (a name of your own for its key), use exactly the name in brackets everywhere (hero_names); a name the reader does not know is not that hero. If the review does not speak of this hero, leave it',
  sight: 'the replay data has no vision: no tool can say who saw whom. State the distance or position a tool gave, or remove it',
  english: 'these English words stand in a Chinese review: write each in Chinese. A hero, item or ability by the name the tools gave (hero_names, hero_abilities, the item names); Roshan is 肉山 and the Aegis 不朽盾; a tool\'s value such as "typical", "lost" or "even" said in words; an ability\'s English description said in your own Chinese, not quoted',
  plan: 'this game_plan would be left out of the review: in brackets, no_reason (required judgment or rationale failed) or no_evidence_that_holds (submitted evidence items failed verification). Keep main_reason + why grounded in tool facts; if attaching game_plan.evidence, cite records returned in this conversation that hold each stated fact',
  structure: 'the review structure broke the submit_review schema limits: keep at most 3 highest-leverage player mistakes in findings (move stage-by-stage walkthrough analysis into chapters), and always include 2–7 chronological chapters (draft, game_plan, laning, midgame, vision_and_macro, skills_and_items), each with at least 1 verified evidence item',
};

export const REVIEW_CHECKPOINT_VERSION = 1;
/** The submitted review in an assistant message, or null: what a finished first pass ended on. */
function submittedIn(message) {
  const call = message?.tool_calls?.find((c) => c?.function?.name === SUBMIT_REVIEW.name);
  if (!call) return null;
  try { const args = JSON.parse(call.function.arguments); return args && typeof args === 'object' && !Array.isArray(args) ? args : null; } catch { return null; }
}
/**
 * A saved checkpoint, if it is well formed and for this hero, language and opening message.
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
 * What the lookups in a saved conversation answered, in order, as the model read it.
 */
function lookupAnswers(messages) {
  const submitted = new Set(); const out = [];
  for (const m of messages) {
    if (m?.role === 'assistant') for (const c of m.tool_calls ?? []) if (c?.function?.name === SUBMIT_REVIEW.name) submitted.add(c.id);
    if (m?.role === 'tool' && !submitted.has(m.tool_call_id)
      && !/^\{"error":"(tool_budget_spent|invalid_arguments|unknown_tool|not_run|unsupported_facts)"/.test(String(m.content))
      && !/^\{"duplicate_of":[^,]+,"tool":/.test(String(m.content))) out.push(String(m.content));
  }
  return out;
}

/**
 * Run the investigation and return a verified review.
 * @param {{ complete: Function, trace: any, hero: string, lang?: string, plan?: string | null, match?: any, signal?: AbortSignal, onEvent?: (e: object) => void, maxSteps?: number, maxToolCalls?: number, checkpoint?: any, onCheckpoint?: (c: object) => void, translate?: boolean, webSearch?: (args: any) => Promise<object> }} o
 */
export async function runDeepReview({ complete, trace, hero, lang, plan = null, match = null, signal, onEvent, maxSteps, maxToolCalls, checkpoint = null, onCheckpoint = null, translate = false, webSearch }) {
  const kit = reviewToolkit({ trace, hero, lang, match, webSearch });
  if (!kit) return { status: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
  const { seat, language, context } = kit;
  const maxToolChars = AGENT_DEFAULTS.maxToolChars;
  const base = {
    complete, system: deepReviewSystem(language), tools: [...kit.tools, SUBMIT_REVIEW], signal, onEvent, maxSteps, maxToolCalls, maxToolChars,
    runTool: kit.runTool,
    isFinal: (call) => call.name === SUBMIT_REVIEW.name,
    finalTools: [SUBMIT_REVIEW.name],
  };
  let steps = 0;
  const stageUsages = [];
  const stages = {};
  const stageEntry = (u, s, tc, tr) => ({ ...u, steps: s, tool_calls: tc, truncation_retries: tr });

  const stated = planByKey(planKey(plan));
  const opening = `Review this game for the player on ${seat.key}.${stated ? `\nThe player says their plan this game was to ${stated.for_the_model} (in their words: "${stated.said.en}"). Read the game against it in game_plan.against_your_plan.` : ''}\n${JSON.stringify(context)}`;
  let from = usableCheckpoint(checkpoint, opening, seat.key, language);
  const again = async (calls) => { const out = []; for (const c of calls) { let result; if (c.name === WEB_SEARCH_TOOL.name) { out.push({ name: c.name, args: c.args ?? {}, result: { tool: 'web_search', not_asked_again: true } }); continue; } try { result = await kit.runTool(c.name, c.args ?? {}); } catch { result = { error: 'tool_failed' }; } out.push({ name: c.name, args: c.args ?? {}, result }); } return out; };
  const pack = (s) => ({
    messages: s.messages,
    calls: s.transcript.map((t) => ({ name: t.name, args: t.args })),
    steps: s.steps,
    truncation_retries: s.truncation_retries ?? 0,
    duplicate_tool_calls: s.duplicate_tool_calls ?? 0,
    usage: s.usage,
  });
  const save = (first, run) => onCheckpoint?.({ v: REVIEW_CHECKPOINT_VERSION, hero: seat.key, lang: language, opening, first, run });
  let firstAgain = null; let runAgain = null;
  if (from) {
    firstAgain = from.first ? await again(from.first.calls) : null;
    runAgain = from.run ? await again(from.run.calls) : null;
    const same = (t, answers) => t.length === answers.length && t.every((x, i) => x.name === WEB_SEARCH_TOOL.name || toolContent(x.result, maxToolChars) === answers[i]);
    const firstAnswers = from.first ? lookupAnswers(from.first.messages) : [];
    if ((from.first && !same(firstAgain, firstAnswers)) || (from.run && !same(runAgain, lookupAnswers(from.run.messages).slice(firstAnswers.length)))) from = null;
  }
  if (from) kit.spendSearches([...(from.first?.calls ?? []), ...(from.run?.calls ?? [])].filter((c) => c.name === WEB_SEARCH_TOOL.name).length);
  const resumed = (s) => ({
    steps: s.steps,
    calls: s.tool_count,
    truncation_retries: s.truncation_retries ?? 0,
    duplicate_tool_calls: s.duplicate_tool_calls ?? 0,
    usage: s.usage,
    transcript: runAgain,
  });
  if (from) onEvent?.({ type: 'resumed', tools: [...(from.first?.calls ?? []), ...(from.run?.calls ?? [])] });

  let first;
  if (from?.first) {
    first = {
      status: 'final',
      final: submittedIn(from.first.messages.at(-1)),
      messages: from.first.messages,
      transcript: firstAgain,
      steps: from.first.steps,
      truncation_retries: from.first.truncation_retries ?? 0,
      duplicate_tool_calls: from.first.duplicate_tool_calls ?? 0,
      usage: normalizeStepUsage(from.first.usage),
    };
  } else {
    first = await runAgent({
      ...base,
      messages: from?.run ? from.run.messages : [{ role: 'user', content: opening }],
      ...(from?.run ? { resume: resumed(from.run) } : {}),
      onCheckpoint: (s) => save(null, { ...pack(s), tool_count: s.calls }),
    });
  }
  const firstUsage = normalizeStepUsage(first.usage);
  steps += first.steps;
  stageUsages.push(firstUsage);
  stages.first = stageEntry(firstUsage, first.steps, first.transcript.length, first.truncation_retries ?? 0);
  if (first.status !== 'final') {
    const status = first.status === 'budget' ? 'budget' : first.status === 'truncated' ? 'output_cap' : 'no_review';
    const detail = typeof first.text === 'string' && first.text.trim() ? first.text.trim().slice(0, 400) : null;
    const total = mergeUsages(stageUsages);
    return {
      status,
      steps,
      repair_rounds: 0,
      truncation_retries: first.truncation_retries ?? 0,
      duplicate_tool_calls: first.duplicate_tool_calls ?? 0,
      usage_source: total.source,
      usage: { ...total, stages },
      transcript: first.transcript,
      ...(detail ? { detail } : {}),
    };
  }
  const asReviewObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  let review = asReviewObj(first.final); let transcript = first.transcript;
  const sources = () => [context, ...transcript.map((t) => t.result).filter((r) => !isWebSearchResult(r))];
  let check = verifyReview(review, sources(), [], { requireStructure: true });
  const firstProblems = check.problems;
  let repaired = false;
  let second = null;
  if (!check.ok) {
    repaired = true;
    const lastCall = first.messages.at(-1).tool_calls.find((c) => c.function.name === SUBMIT_REVIEW.name);
    const done = pack(first);
    const midRepair = from?.first && from.run ? from.run : null;
    if (!midRepair) save(done, null);
    const placeOf = (p) => (
      p.where === 'findings' ? 'findings'
        : p.where === 'chapters' ? 'chapters'
          : p.where === 'game_plan' ? 'game_plan'
            : p.where === 'plan' ? `game_plan.${PLAN_TEXTS[p.index]}`
              : p.where === 'plan_evidence' ? `game_plan.evidence ${p.index + 1}`
                : p.where === 'highlight' ? `highlight ${p.index + 1}`
                  : p.where === 'highlight_evidence' ? `highlight ${p.index + 1}, evidence ${(p.item ?? 0) + 1}`
                    : p.where === 'chapter' ? `chapter ${p.index + 1}`
                      : p.where === 'chapter_evidence' ? `chapter ${p.index + 1}, evidence ${(p.item ?? 0) + 1}`
                        : p.where === 'finding' ? `finding ${p.index + 1}`
                          : p.where === 'title' ? `finding ${p.index + 1}, title`
                            : `${p.where}${p.where === 'verdict' || p.where === 'whole_review' ? '' : ` ${p.index + 1}`}`
    );
    const repairSources = sources();
    const formatProblem = (p) => {
      const suggested = p.kind === 'moment' ? suggestChildRefs(p, repairSources, check.refs) : [];
      return {
        in: placeOf(p),
        text: p.text,
        why: REPAIR_HELP[p.kind],
        ...(suggested.length ? { suggested_refs: suggested } : {}),
      };
    };
    second = await runAgent({
      ...base,
      ...(midRepair ? { resume: resumed(midRepair) } : {}),
      onCheckpoint: (s) => save(done, { ...pack(s), tool_count: s.calls }),
      messages: midRepair ? midRepair.messages : [...first.messages, ...first.messages.at(-1).tool_calls.map((c) => ({
        role: 'tool', tool_call_id: c.id,
        content: c === lastCall ? JSON.stringify({ error: 'unsupported_facts', detail: 'Look each one up with a tool, or rewrite the sentence without it, then call submit_review again with the whole review.', problems: check.problems.map(formatProblem) }) : JSON.stringify({ error: 'not_run' }),
      }))],
    });
    const secondUsage = normalizeStepUsage(second.usage);
    steps += second.steps;
    stageUsages.push(secondUsage);
    stages.repair = stageEntry(secondUsage, second.steps, second.transcript.length, second.truncation_retries ?? 0);
    if (second.status === 'final') { review = asReviewObj(second.final); transcript = [...transcript, ...second.transcript]; check = verifyReview(review, sources(), [], { requireStructure: true }); }
  }

  const bad = (where) => (where === 'finding' ? check.unsupported.findings : new Set(check.problems.filter((p) => p.where === where && !p.soft).map((p) => p.index)));
  const holds = (f, i) => (f && typeof f === 'object' && Array.isArray(f.evidence) ? { ...f, evidence: f.evidence.filter((_, j) => !check.unsupported.evidence.get(i)?.has(j)) } : f);
  const fmtClock = (t) => `${t < 0 ? '-' : ''}${Math.floor(Math.abs(Math.trunc(t)) / 60)}:${String(Math.abs(Math.trunc(t)) % 60).padStart(2, '0')}`;
  const rawFindings = Array.isArray(review.findings) ? review.findings : [];
  const findings = rawFindings
    .map(holds)
    .filter((f, i) => f && typeof f === 'object' && !bad('finding').has(i))
    .slice(0, MAX_FINDINGS)
    .map((f) => ({
      title: headingOf(f),
      claim: typeof f.claim === 'string' ? f.claim : '',
      evidence: (Array.isArray(f.evidence) ? f.evidence : [])
        .filter((e) => e && typeof e === 'object')
        .map((e) => {
          const at = check.refs.get(e.refs?.[0])?.at;
          return { refs: Array.isArray(e.refs) ? e.refs : [], ...(at == null ? {} : { clock: fmtClock(at) }), fact: typeof e.fact === 'string' ? e.fact : '' };
        }),
      fix: typeof f.fix === 'string' ? f.fix : '',
    }));
  const highlights = highlightsOf(review.highlights, check.problems, check.refs);
  const chapters = chaptersOf(review.chapters, check.problems, check.refs);
  const verdict = bad('verdict').size ? findings[0]?.title ?? highlights[0]?.title ?? chapters[0]?.title ?? '' : (typeof review.verdict === 'string' ? review.verdict : '');
  const gamePlan = planOf(review.game_plan, check.problems, check.refs, { stated: Boolean(stated) });
  const primary = nameHeroes({
    schema: DEEP_REVIEW_SCHEMA,
    prompt_version: DEEP_REVIEW_PROMPT_VERSION,
    match_id: trace.match_id,
    hero: seat.key,
    lang: language,
    ...(stated ? { plan: stated.key } : {}),
    data_patch: kit.patch,
    verdict,
    highlights,
    findings,
    chapters,
    blind_spots: Array.isArray(review.blind_spots) ? review.blind_spots.filter((s) => typeof s === 'string') : [],
    ...(gamePlan ? { game_plan: gamePlan } : {}),
  }, context.hero_names, context.place_names);
  const ok = findings.length > 0 || chapters.length > 0;
  const reviews = { [language]: primary };
  if (translate && ok && !signal?.aborted) {
    const tr = await translateReview({ complete, review: primary, sourceLang: language, trace, sources: sources(), signal, onEvent });
    Object.assign(reviews, tr.reviews);
    if ((tr.steps ?? 0) > 0) {
      const trUsage = normalizeStepUsage(tr.usage);
      stageUsages.push(trUsage);
      stages.translate = stageEntry(trUsage, tr.steps, 0, 0);
    }
  }
  const total = mergeUsages(stageUsages);
  return {
    status: ok ? 'ok' : 'unverified',
    review: primary,
    reviews,
    verification: {
      repaired,
      first_pass_problems: firstProblems.length,
      dropped: rawFindings.length - findings.length,
      problems: check.problems,
      ...(gamePlan ? {} : { game_plan_missing: planGapOf(review.game_plan, check.problems, check.refs, { stated: Boolean(stated) }) ?? 'dropped' }),
    },
    dropped_findings: rawFindings.filter((_, i) => bad('finding').has(i)),
    tool_calls: transcript.map((t) => ({ name: t.name, args: t.args })),
    steps,
    repair_rounds: repaired ? 1 : 0,
    truncation_retries: (first.truncation_retries ?? 0) + (second?.truncation_retries ?? 0),
    duplicate_tool_calls: (first.duplicate_tool_calls ?? 0) + (second?.duplicate_tool_calls ?? 0),
    usage_source: total.source,
    usage: { ...total, stages },
  };
}
