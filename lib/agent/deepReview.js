/**
 * The deep review: an agent investigates one player's game with the replay
 * tools and submits a structured review (`dota2.ai/deep-review@1`).
 *
 * The prompt teaches a method, not conclusions. The review is then checked
 * by code, not by trust: every clock time and every large number a finding
 * states must appear in what the tools returned during this run
 * (verifyReview). The model gets one chance to repair what fails; a finding
 * that still states something the tools never said is dropped.
 */
import { TRACE_TOOLS, runTraceTool } from '../../packages/review-engine/src/trace/index.js';
import { STATIC_HEROES } from '../../packages/review-engine/src/staticHeroes.js';
import { deepseekLanguageLock, normalizeUiLang } from '../aiLanguage.js';
import { runAgent } from './loop.js';

export const DEEP_REVIEW_SCHEMA = 'dota2.ai/deep-review@1';
export const DEEP_REVIEW_PROMPT_VERSION = 1;
const MAX_FINDINGS = 3;
/** A stated time may be this far from a tool's time (rounding to the second, "about 30:10"). */
const CLOCK_TOLERANCE = 3;
/** Numbers below this are counts and small sums the model derives ("4 of 10"); they are not checked. */
const NUMBER_FLOOR = 100;

const STR = { type: 'string' };
export const SUBMIT_REVIEW = {
  name: 'submit_review',
  description: 'Hand in the finished review. Call it once, after you have investigated with the other tools. Every time and number you write must come from a tool result of this conversation.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'mainline', 'findings', 'next_game', 'blind_spots'],
    properties: {
      verdict: { ...STR, description: 'One sentence: the main reason this game went the way it did for this player.' },
      mainline: { type: 'array', items: STR, maxItems: 5, description: 'The story of the game in phases, each with its times.' },
      findings: {
        type: 'array', minItems: 1, maxItems: MAX_FINDINGS,
        description: 'The problems that mattered most, most important first.',
        items: {
          type: 'object', additionalProperties: false, required: ['title', 'claim', 'evidence', 'fix'],
          properties: {
            title: STR,
            claim: { ...STR, description: 'What went wrong and why it mattered.' },
            evidence: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['clock', 'fact'], properties: { clock: { ...STR, description: 'Game time m:ss of the moment, from a tool result.' }, fact: STR } } },
            fix: { ...STR, description: 'What to do differently, concretely.' },
          },
        },
      },
      did_well: { type: 'array', items: STR, maxItems: 3 },
      next_game: { type: 'array', items: STR, minItems: 1, maxItems: 3, description: 'At most three things to change next game.' },
      blind_spots: { type: 'array', items: STR, description: 'What the replay data could not show for this review (from the tools\' gaps).' },
    },
  },
};

export function deepReviewSystem(lang) {
  return `${deepseekLanguageLock(lang)}

You are a Dota 2 coach reviewing one player's game from its replay. You teach judgment: the player should finish reading knowing what to do differently next game.

You have tools that query the parsed replay. They return facts; the judgment is yours.

METHOD
1. match_overview first: line-ups, result, the fights and which side lost fewer heroes, when buildings fell. Find where the game turned.
2. Find how the enemy won (or what threatened the player most): which enemy hero dealt the damage and got the kills. Check that hero's spell-immunity windows.
3. Audit the player's deaths with death_context: alone or with allies, what was ready and not used, which disables landed, who dealt the damage. Look for a pattern across deaths, not eleven separate stories.
4. Audit the player's most important ability (usually the ultimate) with ability_audit: who it was spent on, what followed, deaths with it ready. Cross it with the enemy's immunity windows (immunity_windows with watch_hero/watch_ability).
5. Read the turning fights with fight_timeline before you describe them.
6. Then write. At most ${MAX_FINDINGS} findings. Each needs a pattern, the moments that show it, and a concrete fix.

RULES
- Every time (m:ss) and every number you state must come from a tool result in this conversation. Do not round a time by more than a couple of seconds. If you did not look it up, do not state it.
- Do not state hero, ability, item or patch facts from memory (cooldowns, damage, what pierces spell immunity). If a tool result shows it happened in this game, you may say that it happened.
- What the tools list under "gaps" is unknown, not false: never claim what the enemy could or could not see, creep positions, or Roshan timings. Put what you could not check under blind_spots.
- Judge decisions, not outcomes, and be direct. No filler, no praise that is not earned by a fact.
- Call heroes by the names in hero_names (the tools use engine keys).
- Finish by calling submit_review exactly once. Do not write the review as plain text.`;
}

const clockToSeconds = (s) => { const m = String(s).match(/^(-)?(\d{1,3}):([0-5]\d)$/); return m ? (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : null; };

/** Every clock time (as seconds) and every number found in a value, recursively. */
export function collectFacts(value, into = { times: new Set(), numbers: new Set() }) {
  if (typeof value === 'number') { if (Number.isFinite(value)) into.numbers.add(Math.abs(value)); return into; }
  if (typeof value === 'string') {
    for (const m of value.matchAll(/(?<![\d:])-?\d{1,3}:[0-5]\d(?![\d:])/g)) { const t = clockToSeconds(m[0]); if (t != null) into.times.add(t); }
    for (const m of value.matchAll(/\d+(?:\.\d+)?/g)) into.numbers.add(Number(m[0]));
    return into;
  }
  if (Array.isArray(value)) { for (const v of value) collectFacts(v, into); return into; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      // A tool's `t` is a game time in seconds: it backs a stated clock too.
      if ((k === 't' || k === 'from' || k === 'to') && typeof v === 'number') into.times.add(Math.round(v));
      collectFacts(v, into);
    }
  }
  return into;
}

/** Clock times and checkable numbers a piece of review text states. */
export function statedFacts(text) {
  const times = []; const numbers = [];
  const s = String(text ?? '');
  const rest = s.replace(/(?<![\d:])-?\d{1,3}:[0-5]\d(?![\d:])/g, (m) => { times.push(m); return ' '; });
  for (const m of rest.matchAll(/\d[\d,]*(?:\.\d+)?\s*(k\b)?/gi)) {
    const n = Number(m[0].replace(/[,\sk]/gi, '')) * (m[1] ? 1000 : 1);
    if (Number.isFinite(n) && n >= NUMBER_FLOOR) numbers.push({ text: m[0].trim(), value: n, approx: Boolean(m[1]) });
  }
  return { times, numbers };
}

/**
 * Check a submitted review against what the tools returned.
 * @param {any} review  the submit_review arguments
 * @param {any[]} sources  tool results (and any context the model was given) of this run
 * `where` is 'verdict', 'mainline' or 'finding'; `index` the line or finding it is in.
 * @returns {{ ok: boolean, problems: { where: string, index: number, kind: 'time' | 'number', text: string }[] }}
 */
export function verifyReview(review, sources) {
  const known = collectFacts(sources);
  const timeOk = (clock) => { const t = clockToSeconds(clock); if (t == null) return false; for (let d = -CLOCK_TOLERANCE; d <= CLOCK_TOLERANCE; d += 1) if (known.times.has(t + d)) return true; return false; };
  const numberOk = ({ value, approx }) => { for (const n of known.numbers) if (Math.abs(n - value) <= (approx ? value * 0.06 : Math.max(1, value * 0.005))) return true; return false; };
  const problems = [];
  const check = (where, index, text) => {
    const { times, numbers } = statedFacts(text);
    for (const c of new Set(times)) if (!timeOk(c)) problems.push({ where, index, kind: 'time', text: c });
    for (const n of numbers) if (!numberOk(n)) problems.push({ where, index, kind: 'number', text: n.text });
  };
  check('verdict', 0, review?.verdict);
  (review?.mainline ?? []).forEach((line, i) => check('mainline', i, line));
  (review?.did_well ?? []).forEach((line, i) => check('did_well', i, line));
  (review?.findings ?? []).forEach((f, i) => check('finding', i, [f?.title, f?.claim, f?.fix, ...(f?.evidence ?? []).flatMap((e) => [e?.clock, e?.fact])].filter(Boolean).join('\n')));
  return { ok: problems.length === 0, problems };
}

/** The scoreboard facts the model starts from, when the match JSON is at hand. Names and account ids never go in. */
function scoreboard(match, heroKey) {
  const p = (match?.players ?? []).find((x) => x && STATIC_HEROES[x.hero_id]?.internalSlug === heroKey);
  return p ? { kills: p.kills, deaths: p.deaths, assists: p.assists, net_worth: p.net_worth, gold_per_min: p.gold_per_min, last_hits: p.last_hits } : null;
}

/** What to call each hero of this match in the reader's language (the tools use engine keys such as "necrolyte"). */
function heroNames(trace, lang) {
  const bySlug = new Map(Object.values(STATIC_HEROES).map((h) => [h.internalSlug, lang === 'zh' ? h.nameZh : h.nameEn]));
  return Object.fromEntries(trace.heroes.map((h) => [h.key, bySlug.get(h.key) ?? h.key]));
}

/**
 * Run the investigation and return a verified review.
 * @param {{ complete: Function, trace: any, hero: string, lang?: string, match?: any, signal?: AbortSignal, onEvent?: (e: object) => void, maxSteps?: number, maxToolCalls?: number }} o
 */
export async function runDeepReview({ complete, trace, hero, lang, match = null, signal, onEvent, maxSteps, maxToolCalls }) {
  const language = normalizeUiLang(lang);
  const seat = trace.heroes.find((h) => h.key === String(hero).trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_'));
  if (!seat) return { status: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
  const tools = [...TRACE_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema })), SUBMIT_REVIEW];
  const ctx = { match };
  const context = { match_id: trace.match_id, player_hero: seat.key, player_team: seat.team === 2 ? 'radiant' : 'dire', hero_names: heroNames(trace, language), ...(scoreboard(match, seat.key) ? { scoreboard: scoreboard(match, seat.key) } : {}) };
  const base = {
    complete, system: deepReviewSystem(language), tools, signal, onEvent, maxSteps, maxToolCalls,
    runTool: (name, args) => runTraceTool(trace, name, args, ctx),
    isFinal: (call) => call.name === SUBMIT_REVIEW.name,
  };
  const usage = { input: 0, output: 0 }; let steps = 0;
  const add = (r) => { usage.input += r.usage.input; usage.output += r.usage.output; steps += r.steps; };

  const first = await runAgent({ ...base, messages: [{ role: 'user', content: `Review this game for the player on ${seat.key}.\n${JSON.stringify(context)}` }] });
  add(first);
  if (first.status !== 'final') return { status: first.status === 'budget' ? 'budget' : 'no_review', steps, usage, transcript: first.transcript };
  let review = first.final; let transcript = first.transcript;
  const sources = () => [context, ...transcript.map((t) => t.result)];
  let check = verifyReview(review, sources());
  let repaired = false;
  if (!check.ok) {
    // One repair round: name exactly what is unsupported; the model may look it up or take it out.
    repaired = true;
    const lastCall = first.messages.at(-1).tool_calls.find((c) => c.function.name === SUBMIT_REVIEW.name);
    const second = await runAgent({
      ...base,
      messages: [...first.messages, ...first.messages.at(-1).tool_calls.map((c) => ({
        role: 'tool', tool_call_id: c.id,
        content: c === lastCall ? JSON.stringify({ error: 'unsupported_facts', detail: 'These are not in any tool result of this conversation. Look each one up with a tool, or remove it, then call submit_review again.', problems: check.problems.map((p) => ({ in: p.where === 'finding' ? `finding ${p.index + 1}` : p.where, kind: p.kind, text: p.text })) }) : JSON.stringify({ error: 'not_run' }),
      }))],
    });
    add(second);
    if (second.status === 'final') { review = second.final; transcript = [...transcript, ...second.transcript]; check = verifyReview(review, sources()); }
  }
  // Whatever still states something the tools never said does not ship.
  const bad = (where) => new Set(check.problems.filter((p) => p.where === where).map((p) => p.index));
  const keep = (list, where) => (list ?? []).filter((_, i) => !bad(where).has(i));
  const findings = keep(review.findings, 'finding');
  const verdict = bad('verdict').size ? findings[0]?.title ?? '' : review.verdict ?? '';
  return {
    status: findings.length ? 'ok' : 'unverified',
    review: {
      schema: DEEP_REVIEW_SCHEMA, prompt_version: DEEP_REVIEW_PROMPT_VERSION, match_id: trace.match_id, hero: seat.key, lang: language,
      verdict, mainline: keep(review.mainline, 'mainline'), findings, did_well: keep(review.did_well, 'did_well'), next_game: review.next_game ?? [], blind_spots: review.blind_spots ?? [],
    },
    verification: { repaired, dropped: (review.findings ?? []).length - findings.length, problems: check.problems },
    tool_calls: transcript.map((t) => ({ name: t.name, args: t.args })),
    steps, usage,
  };
}
