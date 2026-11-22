/**
 * The deep review: an agent investigates one player's game with the replay
 * and knowledge tools and submits a structured review
 * (`dota2.ai/deep-review@1`).
 *
 * The prompt teaches a method, not conclusions. The review is then checked
 * by code, not by trust (verifyReview): what it states about the game must
 * be in what the tools returned during this run. The model gets one chance
 * to repair what fails; whatever still states something the tools never
 * said is dropped.
 */
import { TRACE_TOOLS, runTraceTool } from '../../packages/review-engine/src/trace/index.js';
import { STATIC_HEROES } from '../../packages/review-engine/src/staticHeroes.js';
import { deepseekLanguageLock, normalizeUiLang } from '../aiLanguage.js';
import { KNOWLEDGE_TOOLS } from './knowledgeTools.js';
import { runAgent } from './loop.js';

export const DEEP_REVIEW_SCHEMA = 'dota2.ai/deep-review@1';
export const DEEP_REVIEW_PROMPT_VERSION = 3;
const MAX_REFS = 3;
const MAX_FINDINGS = 3;
/** A stated time may be this far from a tool's time (rounding to the second, "about 30:10"). */
const CLOCK_TOLERANCE = 3;
/** From here up a number is checked wherever it stands; below, only decimals, counts and evidence. */
const BIG = 100;
/** Integers up to this are too common to check by matching ("two fights", "level 3"). */
const TRIVIAL = 3;

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
            evidence: {
              type: 'array', minItems: 1, maxItems: 8,
              items: {
                type: 'object', additionalProperties: false, required: ['refs', 'fact'],
                properties: {
                  refs: { type: 'array', minItems: 1, maxItems: MAX_REFS, items: STR, description: 'The `ref` of each tool record this fact is read from, copied exactly, e.g. "cast:beastmaster:primal_roar:6", "death:beastmaster:9", "immune:phantom_assassin:3".' },
                  fact: { ...STR, description: 'What those records show. Every time and number here must be in the cited records.' },
                },
              },
            },
            fix: { ...STR, description: 'What to do differently, concretely. Advice, not game facts.' },
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

You have tools that query the parsed replay and the site's data on heroes and items. They return facts; the judgment is yours.

READING THE TOOLS
- Everything is told from the player's side: "me" is the player, "ally"/"my_team" their team, "enemy" the other. my_team_gold_lead is negative when the player's team is behind. Never translate this into Radiant/Dire yourself.
- Call heroes by the names in hero_names (the tools use engine keys).

METHOD
1. match_overview: result, the fights and which side lost fewer heroes, the gold lead around them, when buildings fell. Find where the game turned.
2. Find how the enemy won: which enemy hero killed the player and dealt the damage (death_context gives killed_by). Check that hero's key items with item_timeline and their spell-immunity windows.
3. Audit the player's deaths with death_context: alone or with allies, what was ready and not used, which disables landed, who dealt the damage. Look for a pattern across deaths, not one story per death.
4. Audit the player's ultimate: hero_abilities first (which ability it is, whether it goes through spell immunity), then ability_audit (who it was spent on, whether the stun landed, what followed, deaths with it ready), then immunity_windows with watch_hero/watch_ability: when the enemy carry became immune, where was the ultimate? Spending it on a lesser target seconds before is a decision worth naming.
5. Judge the build: item_timeline for the player, pro_item_choices for what professionals build on this hero and against these enemies. Name what was missing only when the deaths show the need for it.
6. Read the turning fights with fight_timeline before you describe them.
7. Then write. At most ${MAX_FINDINGS} findings. Each needs a pattern, the moments that show it, and a concrete fix.

RULES
- Every time (m:ss) and every number you state about the game must be one a tool returned in this conversation. Quote; do not add, subtract or average to make new numbers. For a count ("7 of 11 deaths"), use the count a tool gives (killed_by, by_target, *_total). If you did not look it up, do not state it.
- Evidence cites records: each evidence item names the "ref" of the tool record(s) it is read from (at most 3) and states only what those records show. A time or number from another record needs that record's ref too. Never join a fact from one record to a different moment.
- Never state what an ability or item does from memory. hero_abilities says what Valve lists; ability_audit says what happened in this game (target_stunned_seconds). If they show an ability worked through spell immunity, say so; never assume it did not.
- Item advice must come from pro_item_choices or from what the replay shows; say "professional games" when you quote a share.
- What the tools list under "gaps" is unknown, not false: never claim what the enemy could or could not see, creep positions, or Roshan timings. Put what you could not check under blind_spots.
- Judge decisions, not outcomes, and be direct. No filler, no praise that is not earned by a fact.
- Finish by calling submit_review exactly once. Do not write the review as plain text.`;
}

const CLOCK = /(?<![\d:])-?\d{1,3}:[0-5]\d(?![\d:])/g;
const clockToSeconds = (s) => { const m = String(s).match(/^(-)?(\d{1,3}):([0-5]\d)$/); return m ? (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : null; };

function addText(text, times, numbers) {
  for (const m of text.matchAll(CLOCK)) { const t = clockToSeconds(m[0]); if (t != null) times.add(t); }
  for (const m of text.replace(CLOCK, ' ').matchAll(/\d+(?:\.\d+)?/g)) numbers.add(Number(m[0]));
}

/**
 * Everything checkable in the tool results of a run:
 * - `times`: every game time (seconds), `numbers`: every number, anywhere;
 * - `summary`: the counts and totals a tool states at its top level (and one
 *   level down: by_target, killed_by, the scoreboard), plus list lengths;
 * - `moments`: for every record that has a time or a time span, the numbers
 *   inside that record — what the tools said about that moment;
 * - `refs`: for every record with a `ref`, its own time and every time and
 *   number inside it — what a sentence citing that ref may state.
 */
export function collectFacts(sources) {
  /** @type {{ times: Set<number>, numbers: Set<number>, summary: Set<number>, moments: { from: number, to: number, numbers: Set<number> }[], refs: Map<string, { at: number | null, times: Set<number>, numbers: Set<number> }> }} */
  const out = { times: new Set(), numbers: new Set(), summary: new Set(), moments: [], refs: new Map() };
  const walk = (value, bucket) => {
    if (typeof value === 'number') { if (Number.isFinite(value)) { out.numbers.add(Math.abs(value)); bucket?.add(Math.abs(value)); } return; }
    if (typeof value === 'string') { addText(value, out.times, out.numbers); if (bucket) addText(value, new Set(), bucket); return; }
    if (Array.isArray(value)) { for (const v of value) walk(v, bucket); return; }
    if (!value || typeof value !== 'object') return;
    let span = null;
    if (typeof value.t === 'number') span = [value.t, value.t];
    else if (typeof value.from === 'number') span = [value.from, typeof value.to === 'number' ? value.to : value.from];
    else if (typeof value.clock === 'string' && clockToSeconds(value.clock) != null) span = [clockToSeconds(value.clock), clockToSeconds(value.clock)];
    const own = span ? new Set() : null;
    const add = (n) => { out.numbers.add(n); bucket?.add(n); own?.add(n); };
    for (const [k, v] of Object.entries(value)) {
      // A field name can carry a number the reader will repeat ("deaths_within_12s").
      for (const m of k.matchAll(/\d+/g)) add(Number(m[0]));
      if ((k === 't' || k === 'from' || k === 'to') && typeof v === 'number') out.times.add(Math.round(v));
      if (own) { const both = { add: (n) => { own.add(n); bucket?.add(n); } }; walk(v, both); } else walk(v, bucket);
    }
    if (span && own) out.moments.push({ from: span[0], to: span[1], numbers: own });
  };
  // Records by ref: a second, self-contained pass so a record's set holds its whole subtree.
  const cite = (value) => {
    if (Array.isArray(value)) { for (const v of value) cite(v); return; }
    if (!value || typeof value !== 'object') return;
    if (typeof value.ref === 'string') {
      const inner = collectFactsOf(value);
      const at = typeof value.t === 'number' ? value.t : typeof value.from === 'number' ? value.from : typeof value.first_held?.t === 'number' ? value.first_held.t : null;
      const r = out.refs.get(value.ref) ?? { at, times: new Set(), numbers: new Set() };
      for (const t of inner.times) r.times.add(t);
      for (const n of inner.numbers) r.numbers.add(n);
      if (r.at == null) r.at = at;
      out.refs.set(value.ref, r);
    }
    for (const v of Object.values(value)) cite(v);
  };
  for (const src of [].concat(sources ?? [])) {
    walk(src, null);
    cite(src);
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      const top = (v, depth) => {
        if (typeof v === 'number') out.summary.add(Math.abs(v));
        else if (Array.isArray(v)) out.summary.add(v.length);
        else if (v && typeof v === 'object' && depth < 2) for (const x of Object.values(v)) top(x, depth + 1);
      };
      top(src, 0);
    }
  }
  return out;
}

/** Times and numbers anywhere inside one value (no summary, no moments). */
function collectFactsOf(value) {
  const times = new Set(); const numbers = new Set();
  const walk = (v) => {
    if (typeof v === 'number') { if (Number.isFinite(v)) numbers.add(Math.abs(v)); return; }
    if (typeof v === 'string') { addText(v, times, numbers); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      for (const m of k.matchAll(/\d+/g)) numbers.add(Number(m[0]));
      if ((k === 't' || k === 'from' || k === 'to') && typeof x === 'number') times.add(Math.round(x));
      walk(x);
    }
  };
  walk(value);
  return { times, numbers };
}

const COUNT_UNIT = /^\s*(次|个|人|波|场|秒|座|times?\b|deaths?\b|kills?\b|casts?\b|fights?\b|seconds?\b|secs?\b|s\b)/i;

/** Clock times and numbers a piece of review text states. `counted` = followed by a counting word ("7 次", "11 deaths", "9.3 seconds"). */
export function statedFacts(text) {
  const times = []; const numbers = [];
  const s = String(text ?? '');
  const rest = s.replace(CLOCK, (m) => { times.push(m); return ' '; });
  for (const m of rest.matchAll(/\d[\d,]*(?:\.\d+)?(\s*k\b)?/gi)) {
    const raw = m[0].replace(/\s*k$/i, '').replace(/,/g, '');
    const value = Number(raw) * (m[1] ? 1000 : 1);
    if (!Number.isFinite(value)) continue;
    numbers.push({ text: m[0].trim(), value, approx: Boolean(m[1]), decimal: raw.includes('.') && !m[1], counted: COUNT_UNIT.test(rest.slice(m.index + m[0].length)) });
  }
  return { times, numbers };
}

const has = (set, n, slack) => { for (const x of set) if (Math.abs(x - n) <= slack) return true; return false; };

/**
 * Check a submitted review against what the tools returned.
 *
 * Checked: every clock time; every number of 100 or more; every decimal;
 * every small count ("7 times") against the tools' own counts. An evidence
 * item cites tool records by `ref`: the refs must exist, and every time and
 * every number above 3 in its fact must be inside those records (a whole
 * number may be a tool's decimal rounded: "11 s" for 10.8). So a fact cannot
 * be attached to a moment it does not belong to. Not checked: `fix`, `next_game` (advice) and `blind_spots`.
 *
 * @param {any} review  the submit_review arguments
 * @param {any[]} sources  tool results (and the context the model was given) of this run
 * @returns {{ ok: boolean, problems: { where: string, index: number, kind: 'time' | 'number' | 'count' | 'moment' | 'ref', text: string }[], refs: Map<string, { at: number | null }> }}
 */
export function verifyReview(review, sources) {
  const known = collectFacts(sources);
  const timeOk = (clock) => { const t = clockToSeconds(clock); if (t == null) return false; for (let d = -CLOCK_TOLERANCE; d <= CLOCK_TOLERANCE; d += 1) if (known.times.has(t + d)) return true; return false; };
  const bigOk = (n, set) => has(set, n.value, n.approx ? n.value * 0.06 : Math.max(1, n.value * 0.005));
  const problems = [];
  const prose = (where, index, text) => {
    const { times, numbers } = statedFacts(text);
    for (const c of new Set(times)) if (!timeOk(c)) problems.push({ where, index, kind: 'time', text: c });
    for (const n of numbers) {
      if (n.value >= BIG) { if (!bigOk(n, known.numbers)) problems.push({ where, index, kind: 'number', text: n.text }); } else if (n.decimal) { if (!has(known.numbers, n.value, 0.05)) problems.push({ where, index, kind: 'number', text: n.text }); } else if (n.counted && n.value > TRIVIAL && !known.summary.has(n.value)) problems.push({ where, index, kind: 'count', text: n.text });
    }
  };
  const evidence = (index, e) => {
    const refs = Array.isArray(e?.refs) ? e.refs.filter((r) => typeof r === 'string').slice(0, MAX_REFS) : [];
    const cited = refs.map((r) => known.refs.get(r));
    if (!refs.length) { problems.push({ where: 'finding', index, kind: 'ref', text: '(no ref)' }); return; }
    refs.forEach((r, i) => { if (!cited[i]) problems.push({ where: 'finding', index, kind: 'ref', text: r }); });
    if (cited.some((c) => !c)) return;
    // Only what the cited records hold — plus the tools' own counts — may be stated.
    const times = new Set(); const local = new Set(known.summary);
    for (const c of cited) { for (const t of c.times) times.add(t); for (const n of c.numbers) local.add(n); }
    const inRecord = (clock) => { const t = clockToSeconds(clock); if (t == null) return false; for (let d = -CLOCK_TOLERANCE; d <= CLOCK_TOLERANCE; d += 1) if (times.has(t + d)) return true; return false; };
    const stated = statedFacts(e?.fact);
    for (const c of new Set(stated.times)) if (!inRecord(c)) problems.push({ where: 'finding', index, kind: 'moment', text: `${c} (not in ${refs.join(', ')})` });
    for (const n of stated.numbers) {
      if (n.value >= BIG) { if (!bigOk(n, local)) problems.push({ where: 'finding', index, kind: 'moment', text: `${n.text} (not in ${refs.join(', ')})` }); } else if ((n.value > TRIVIAL || n.decimal) && !has(local, n.value, n.decimal ? 0.05 : 0.5)) problems.push({ where: 'finding', index, kind: 'moment', text: `${n.text} (not in ${refs.join(', ')})` });
    }
  };
  prose('verdict', 0, review?.verdict);
  (review?.mainline ?? []).forEach((line, i) => prose('mainline', i, line));
  (review?.did_well ?? []).forEach((line, i) => prose('did_well', i, line));
  (review?.findings ?? []).forEach((f, i) => { prose('finding', i, [f?.title, f?.claim].filter(Boolean).join('\n')); (f?.evidence ?? []).forEach((e) => evidence(i, e)); });
  return { ok: problems.length === 0, problems, refs: known.refs };
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
 * Replace engine hero keys the model let through ("skywrath_mage", "sven")
 * with the reader's names. Whole identifiers only, longest first; `refs` are
 * handles and are never touched.
 */
export function nameHeroes(review, names) {
  const keys = Object.keys(names).filter((k) => names[k] && names[k] !== k).sort((a, b) => b.length - a.length);
  if (!keys.length) return review;
  const re = new RegExp(`(?<![A-Za-z0-9_:])(${keys.join('|')})(?![A-Za-z0-9_:])`, 'g');
  const fix = (v) => (typeof v === 'string' ? v.replace(re, (k) => names[k]) : v);
  return {
    ...review,
    verdict: fix(review.verdict), mainline: (review.mainline ?? []).map(fix), did_well: (review.did_well ?? []).map(fix), next_game: (review.next_game ?? []).map(fix), blind_spots: (review.blind_spots ?? []).map(fix),
    findings: (review.findings ?? []).map((f) => ({ ...f, title: fix(f.title), claim: fix(f.claim), fix: fix(f.fix), evidence: (f.evidence ?? []).map((e) => ({ ...e, fact: fix(e.fact) })) })),
  };
}

const REPAIR_HELP = {
  time: 'this time is not in any tool result',
  number: 'this number is not in any tool result',
  count: 'no tool gave this count; use the count a tool states (killed_by, by_target, *_total)',
  moment: 'the cited record does not hold this; cite the record that does, or remove it',
  ref: 'no tool record with this ref was returned in this conversation; copy a ref exactly',
};

/**
 * Run the investigation and return a verified review.
 * @param {{ complete: Function, trace: any, hero: string, lang?: string, match?: any, signal?: AbortSignal, onEvent?: (e: object) => void, maxSteps?: number, maxToolCalls?: number }} o
 */
export async function runDeepReview({ complete, trace, hero, lang, match = null, signal, onEvent, maxSteps, maxToolCalls }) {
  const language = normalizeUiLang(lang);
  const seat = trace.heroes.find((h) => h.key === String(hero).trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_'));
  if (!seat) return { status: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
  const lookups = [...TRACE_TOOLS, ...KNOWLEDGE_TOOLS];
  const tools = [...lookups.map(({ name, description, input_schema }) => ({ name, description, input_schema })), SUBMIT_REVIEW];
  const ctx = { match, perspective: seat.key, lang: language };
  const knowledge = new Map(KNOWLEDGE_TOOLS.map((t) => [t.name, t]));
  const context = { match_id: trace.match_id, player_hero: seat.key, hero_names: heroNames(trace, language), ...(scoreboard(match, seat.key) ? { scoreboard: scoreboard(match, seat.key) } : {}) };
  const base = {
    complete, system: deepReviewSystem(language), tools, signal, onEvent, maxSteps, maxToolCalls,
    runTool: (name, args) => (knowledge.has(name) ? { tool: name, ...knowledge.get(name).run(trace, args, ctx) } : runTraceTool(trace, name, args, ctx)),
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
  const firstProblems = check.problems;
  let repaired = false;
  if (!check.ok) {
    // One repair round: name exactly what is unsupported; the model may look it up or take it out.
    repaired = true;
    const lastCall = first.messages.at(-1).tool_calls.find((c) => c.function.name === SUBMIT_REVIEW.name);
    const second = await runAgent({
      ...base,
      messages: [...first.messages, ...first.messages.at(-1).tool_calls.map((c) => ({
        role: 'tool', tool_call_id: c.id,
        content: c === lastCall ? JSON.stringify({ error: 'unsupported_facts', detail: 'Look each one up with a tool, or rewrite the sentence without it, then call submit_review again with the whole review.', problems: check.problems.map((p) => ({ in: p.where === 'finding' ? `finding ${p.index + 1}` : `${p.where}${p.where === 'verdict' ? '' : ` ${p.index + 1}`}`, text: p.text, why: REPAIR_HELP[p.kind] })) }) : JSON.stringify({ error: 'not_run' }),
      }))],
    });
    add(second);
    if (second.status === 'final') { review = second.final; transcript = [...transcript, ...second.transcript]; check = verifyReview(review, sources()); }
  }
  // Whatever still states something the tools never said does not ship.
  const bad = (where) => new Set(check.problems.filter((p) => p.where === where).map((p) => p.index));
  const keep = (list, where) => (list ?? []).filter((_, i) => !bad(where).has(i));
  const fmtClock = (t) => `${t < 0 ? '-' : ''}${Math.floor(Math.abs(Math.trunc(t)) / 60)}:${String(Math.abs(Math.trunc(t)) % 60).padStart(2, '0')}`;
  // Each evidence item gets the game time of the first record it cites, for the reader.
  const findings = keep(review.findings, 'finding').map((f) => ({ ...f, evidence: (f.evidence ?? []).map((e) => { const at = check.refs.get(e.refs?.[0])?.at; return { refs: e.refs, ...(at == null ? {} : { clock: fmtClock(at) }), fact: e.fact }; }) }));
  const verdict = bad('verdict').size ? findings[0]?.title ?? '' : review.verdict ?? '';
  return {
    status: findings.length ? 'ok' : 'unverified',
    review: nameHeroes({
      schema: DEEP_REVIEW_SCHEMA, prompt_version: DEEP_REVIEW_PROMPT_VERSION, match_id: trace.match_id, hero: seat.key, lang: language,
      verdict, mainline: keep(review.mainline, 'mainline'), findings, did_well: keep(review.did_well, 'did_well'), next_game: review.next_game ?? [], blind_spots: review.blind_spots ?? [],
    }, context.hero_names),
    verification: { repaired, first_pass_problems: firstProblems.length, dropped: (review.findings ?? []).length - findings.length, problems: check.problems },
    tool_calls: transcript.map((t) => ({ name: t.name, args: t.args })),
    steps, usage,
  };
}
