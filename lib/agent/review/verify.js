/**
 * The check: what a review states about the game must be in what the tools returned during the run
 * (verifyReview), and how its text is worded (wordingProblems, sightClaims).
 */
import { TRACE_TOOLS } from '../../../packages/review-engine/src/trace/index.js';
import { KNOWLEDGE_TOOLS } from '../knowledgeTools.js';
import { KNOWN_ZH_NAMES } from '../evidence.js';
import {
  BIG,
  CHAPTER_TOPICS,
  CLOCK_TOLERANCE,
  MAX_CHAPTERS,
  MAX_CHAPTER_EVIDENCE,
  MAX_FINDINGS,
  MAX_HIGHLIGHTS,
  MAX_HIGHLIGHT_EVIDENCE,
  MAX_PLAN_EVIDENCE,
  MAX_REFS,
  MIN_CHAPTERS,
  PLAN_REASONS,
  PLAN_TEXTS,
  TRIVIAL,
} from './schema.js';

/** A non-empty string, trimmed; else null. */
export const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

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
  /** @type {{ times: Set<number>, numbers: Set<number>, summary: Set<number>, moments: { from: number, to: number, numbers: Set<number> }[], refs: Map<string, { at: number | null, times: Set<number>, numbers: Set<number>, scope: 'summary' | 'record', children: Set<string> }> }} */
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
  // When walking a summary tool result (`ref_scope: 'summary'`), track the child refs nested inside
  // that same tool result object so repair hints can point directly to the exact child ref without
  // ever loosening summary-ref verification.
  const cite = (value, summaryParent = null) => {
    if (Array.isArray(value)) { for (const v of value) cite(v, summaryParent); return; }
    if (!value || typeof value !== 'object') return;
    let nextParent = summaryParent;
    if (typeof value.ref === 'string') {
      const isSummary = value.ref_scope === 'summary';
      // A summary ref covers the tool's own counts and totals, not the records nested below it.
      const inner = isSummary ? summaryFactsOf(value) : collectFactsOf(value);
      const at = typeof value.t === 'number' ? value.t : typeof value.from === 'number' ? value.from : typeof value.first_held?.t === 'number' ? value.first_held.t : null;
      const r = out.refs.get(value.ref) ?? { at, times: new Set(), numbers: new Set(), scope: isSummary ? 'summary' : 'record', children: new Set() };
      for (const t of inner.times) r.times.add(t);
      for (const n of inner.numbers) r.numbers.add(n);
      if (r.at == null) r.at = at;
      if (!isSummary && r.scope === 'summary') r.scope = 'record';
      out.refs.set(value.ref, r);
      if (summaryParent && summaryParent !== value.ref) out.refs.get(summaryParent)?.children.add(value.ref);
      // Only direct child records belong to a summary ref; stop propagating into grandchildren (e.g. death.nearby_fight).
      nextParent = isSummary ? value.ref : null;
    }
    for (const v of Object.values(value)) cite(v, nextParent);
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

/** The counts a tool states about its whole answer: top-level numbers, one level of maps, list lengths. */
function summaryFactsOf(value) {
  const times = new Set(); const numbers = new Set();
  const top = (v, depth) => {
    if (typeof v === 'number') { if (Number.isFinite(v)) numbers.add(Math.abs(v)); } else if (typeof v === 'string') addText(v, times, numbers);
    // A list is its length, and the game times it names (deaths_where lists deaths by their clock): not the records it may hold.
    else if (Array.isArray(v)) { numbers.add(v.length); for (const x of v) if (typeof x === 'string') addText(x, times, numbers); }
    // A field's name can state a measure (observers_within_1600): its number is the record's,
    // as collectFactsOf reads it for a whole record.
    else if (v && typeof v === 'object' && depth < 2) for (const [k, x] of Object.entries(v)) { for (const m of k.matchAll(/\d+/g)) numbers.add(Number(m[0])); if ((k === 't' || k === 'from' || k === 'to') && typeof x === 'number') times.add(Math.round(x)); top(x, depth + 1); }
  };
  top(value, 0);
  return { times, numbers };
}

/** A number of seconds is a length of time, not a count of things: tools give it with a decimal and prose rounds it. */
const SECONDS_UNIT = /^\s*(秒|seconds?\b|secs?\b|s\b|сек(?:унд[ауы]?)?(?![а-яё])|с(?![а-яё]))/i;
const COUNT_UNIT = /^\s*(次|个|人|波|场|秒|座|times?\b|deaths?\b|kills?\b|casts?\b|fights?\b|seconds?\b|secs?\b|s\b|раз(?:а)?(?![а-яё])|смерт(?:ей|и|ь)?(?![а-яё])|убийств(?:а|о)?(?![а-яё])|каст(?:ов|а)?(?![а-яё])|драк(?:и|а)?(?![а-яё])|файт(?:ов|а)?(?![а-яё])|сек(?:унд[ауы]?)?(?![а-яё]))/i;

/** Words that mark a number as an approximation ("约 5200", "about 5,200", "5200 左右"): only such a number may be off the tool's. */
// A bare 约 is "about" — not the end of a word that has it (节约 "save", 预约, 合约 …: "节约 11000 金币" is exact).
const APPROX_BEFORE = /((?<![节预制合签条公简隐邀违履特婚赴誓契规爽失毁解续租])约|大约|大概|将近|about|around|roughly|nearly|approximately|около|примерно|приблизительно|почти|~|～|≈)\s*$/i;
// 左右/上下 may follow a unit: "11100 码左右", "5000 金左右".
const APPROX_AFTER = /^\s*(?:码|米|金币|金|经济|经验|点|秒|分钟|次|个|人|units?|gold)?\s*(左右|上下)/i;

/** Clock times and numbers a piece of review text states. `counted` = followed by a counting word ("7 次", "11 deaths", "9.3 seconds"). */
export function statedFacts(text) {
  const times = []; const numbers = [];
  const s = String(text ?? '');
  const rest = s.replace(CLOCK, (m) => { times.push(m); return ' '; });
  for (const m of rest.matchAll(/\d[\d,]*(?:\.\d+)?(\s*k\b)?/gi)) {
    const raw = m[0].replace(/\s*k$/i, '').replace(/,/g, '');
    const value = Number(raw) * (m[1] ? 1000 : 1);
    if (!Number.isFinite(value)) continue;
    const after = rest.slice(m.index + m[0].length);
    const percent = /^\s*[%％]/.test(after);
    const approx = Boolean(m[1]) || APPROX_BEFORE.test(rest.slice(Math.max(0, m.index - 16), m.index)) || APPROX_AFTER.test(after);
    numbers.push({ text: percent ? `${m[0].trim()}%` : m[0].trim(), value, approx, decimal: raw.includes('.') && !m[1], counted: COUNT_UNIT.test(after), ...(SECONDS_UNIT.test(after) ? { seconds: true } : {}), ...(percent ? { percent } : {}) });
  }
  return { times, numbers };
}

/**
 * Statements about who could see whom. A replay trace holds positions and
 * distances, never vision (fog of war, wards): such a statement cannot be
 * backed by any tool, however it is worded. A sentence that says the data
 * does not show it is not a claim.
 * @returns {string[]} the offending phrases
 */
const SIGHT = [
  /(?:在|进入|出现在|站在|走进|暴露在|离开|脱离)[^，。；！？\n]{0,12}视野|视野[里内中]|(?:没有?|有|丢了|失去)视野|看得[见到]|看不[见到]|(?:看见|看到|发现)了?你/g,
  /\b(?:in|within|into|out of|outside|had|has|have|no|without|lost|gave|gives)\s+(?:(?:your|their|his|her|its|the|enemy|enemy's|full|any)\s+){0,3}(?:vision|sight|line of sight)\b|\b(?:could(?:n't| not)?|can(?:'t|not)?)\s+see\b|\bsaw\s+you\b|\bvisible\s+to\b/gi,
  /(?:в поле зрения|в\s+(?:тво[её]м|вашем|их)\s+обзоре|под (?:вижном|обзором)|без (?:вижна|обзора)|не было (?:вижна|обзора)|(?:не\s+)?(?:у?видели?|заметили?)\s+(?:тебя|вас)|мог(?:ла|ли)?\s+(?:у?видеть|заметить))/gi,
];
const NOT_A_CLAIM = /录像|数据|记录|无法|不知道|看不出|查不到|\b(?:replay|data|record(?:ed|s)?|trace|unknown|not shown|cannot (?:tell|know|say)|can't (?:tell|know|say))\b|репле[ейя]|запис[иь]|данные|неизвестно|нельзя определить/i;
export function sightClaims(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const sentence of text.split(/(?<=[。！？!?\n])|(?<=\.)\s/)) {
    if (NOT_A_CLAIM.test(sentence)) continue;
    for (const re of SIGHT) for (const m of sentence.matchAll(re)) out.push(m[0].trim());
  }
  return [...new Set(out)];
}

/**
 * Record handles the model put into a sentence — "（lane:beastmaster）", "(audit:x:roar, cast:x:roar:6/9)",
 * "（overview、fight:3、fight:4）", "（4 换 3，timeline:2194-2233）". They belong in `refs`. A bracket holding
 * nothing else goes whole; a handle listed after or before other words in a bracket goes with its separator.
 * One standing inside a sentence ("fight:3 at 20:20") cannot be cut out without breaking it: wordingProblems names it.
 */
const HANDLE = '[a-z][a-z_]*:[A-Za-z0-9_/+-]+(?::[A-Za-z0-9_/+-]+)*';
const SOURCE = `(?:${HANDLE}|overview|${[...TRACE_TOOLS, ...KNOWLEDGE_TOOLS].map((t) => t.name).join('|')})`;
const SEP = '[,，、;；]';
const HANDLES = new RegExp(`\\s*[（(]\\s*${SOURCE}(?:\\s*${SEP}\\s*${SOURCE})*\\s*[)）]`, 'g');
const HANDLE_LISTED = new RegExp(`\\s*${SEP}\\s*${SOURCE}(?=\\s*(?:${SEP}|[)）]))|(?<=[（(])\\s*${SOURCE}\\s*${SEP}\\s*`, 'g');
export const stripHandles = (text) => text.replace(HANDLES, '').replace(HANDLE_LISTED, '');
/** A review as stored, with the handles taken out of its text: `refs` are untouched. */
export function withoutHandles(value) {
  if (typeof value === 'string') return stripHandles(value);
  if (Array.isArray(value)) return value.map(withoutHandles);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'refs' ? v : withoutHandles(v)]));
}
const BARE_HANDLE = new RegExp(`(?<![A-Za-z0-9_:/.])${HANDLE}`, 'g');
const KEY = /(?<![A-Za-z0-9_:/.-])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![A-Za-z0-9_:])/g;
const CJK_ONLY = /^[\u3400-\u9fff]+$/;
/** A bracket of clock times and nothing else, and a time picked out "of these" straight after it. */
const LISTED = /[（(]((?:\s*-?\d{1,3}:[0-5]\d\s*[,，、;；和]?(?:\s*and\b)?)+)[)）]\s*[,，;；]?\s*(?:其中|当中|of which|of these|of those|among them)[^，,。；;：:（(\d]{0,12}(-?\d{1,3}:[0-5]\d)(?![\d:])/gi;

/** A sentence with more times and numbers than this is dense: a reader keeps two, the rest belong in the evidence. */
export const NUMBERS_PER_SENTENCE = 2;
const SENTENCE = /(?<=[。！？!?；;\n])|(?<=\.)\s/;
/** English words, three letters or more. Abbreviations players use in any language (BKB, TP, GPM) are not counted. */
const ENGLISH_WORD = /[A-Za-z][A-Za-z'-]{2,}/g;
const ABBREVIATION = /^[A-Z]{2,5}$/;
/** Names that are written the same in Chinese. (Roshan is not one: the site's Chinese says 肉山.) */
const SAME_IN_CHINESE = new Set(['Valve', 'Dota', 'OpenDota', 'STRATZ']);

/**
 * Latin words that are part of a name as the site itself has it in Chinese — "Eul的神圣法杖", and the few items
 * whose Chinese name is still the English one. Written that way they are the name, not a leak.
 */
const NAME_WORDS = new Set([...KNOWN_ZH_NAMES].flatMap((n) => (typeof n === 'string' ? n.match(ENGLISH_WORD) ?? [] : [])));

/** The English words a text carries, for a text meant to be Chinese: what the eval counts and the repair round names. */
export function englishWords(text) {
  return typeof text === 'string' ? (text.match(ENGLISH_WORD) ?? []).filter((w) => !ABBREVIATION.test(w) && !SAME_IN_CHINESE.has(w) && !NAME_WORDS.has(w)) : [];
}

/** A text's sentences, and how many times and numbers each states. */
export function sentenceFacts(text) {
  return typeof text === 'string' ? text.split(SENTENCE).map((s) => s.trim()).filter(Boolean).map((sentence) => { const f = statedFacts(sentence); return { sentence, facts: f.times.length + f.numbers.length }; }) : [];
}

/**
 * How a piece of review text is worded, apart from whether its facts are backed:
 * - `key`: a tool's key or field name left in a sentence ("no_ally_within_1200", "audit:tidehunter:ravage").
 * - `name`: four or more Chinese characters one character away from a hero name of this match ("天赋法师" for 天怒法师).
 * - `list`: "…（18:31、19:29、25:33），其中 37:14 那次…" — a time picked out of a list it is not in.
 * Marked `soft`: asked about once in the repair round, never a reason to drop.
 * @param {{ hero_names?: Record<string, string>, place_names?: Record<string, string> }} [names]
 * @returns {{ kind: 'key' | 'name' | 'list', text: string }[]}
 */
export function wordingProblems(text, names = {}) {
  if (typeof text !== 'string' || !text) return [];
  const out = new Map();
  const add = (kind, t) => out.set(`${kind}|${t}`, { kind, text: t });
  const body = stripHandles(text);
  const replaced = { ...names.place_names, ...names.hero_names };
  for (const m of body.matchAll(BARE_HANDLE)) if (!m[0].includes('://')) add('key', m[0]);
  for (const m of body.replace(BARE_HANDLE, ' ').matchAll(KEY)) if (!Object.hasOwn(replaced, m[0])) add('key', m[0]);
  for (const name of new Set(Object.values(names.hero_names ?? {}))) {
    if (typeof name !== 'string' || name.length < 4 || !CJK_ONLY.test(name)) continue;
    for (let i = 0; i + name.length <= body.length; i += 1) {
      const w = body.slice(i, i + name.length);
      if (w === name || !CJK_ONLY.test(w) || KNOWN_ZH_NAMES.has(w)) continue;
      let off = 0;
      for (let k = 0; k < name.length && off < 2; k += 1) if (w[k] !== name[k]) off += 1;
      if (off === 1) add('name', `${w} (${name}?)`);
    }
  }
  for (const m of body.matchAll(LISTED)) {
    const listed = (m[1].match(CLOCK) ?? []).map(clockToSeconds);
    if (listed.length >= 2 && !listed.includes(clockToSeconds(m[2]))) add('list', `${m[2]} (not among ${m[1].trim()})`);
  }
  return [...out.values()];
}

const has = (set, n, slack) => { for (const x of set) if (Math.abs(x - n) <= slack) return true; return false; };
/**
 * A percentage is checked as what it says: "71%" is backed by a tool's share
 * of 0.71 (or by a tool's own 71), and "0.71%" is not backed by 0.71.
 */
const percentOk = (set, n) => has(set, n.value / 100, 0.006) || (n.value >= 1 && has(set, n.value, 0.5));
const bigOk = (n, set) => has(set, n.value, n.approx ? n.value * 0.06 : 1);
const timeInSet = (times, clock) => { const t = clockToSeconds(clock); if (t == null) return false; for (let d = -CLOCK_TOLERANCE; d <= CLOCK_TOLERANCE; d += 1) if (times.has(t + d)) return true; return false; };
const numberInEvidence = (local, n) => (
  n.percent ? percentOk(local, n)
    : n.value >= BIG ? bigOk(n, local)
      : (n.value > TRIVIAL || n.decimal) ? has(local, n.value, n.decimal ? 0.05 : 0.5)
        : false
);

const MOMENT_PROBLEM = /^(.+?)\s+\(not in ([^)]+)\)$/;

/**
 * Pure repair helper: when a `moment` problem fails because the model cited a `ref_scope: 'summary'`
 * record (e.g. `audit:beastmaster:primal_roar`) for an individual event's clock or number (e.g. `27:27` or `3.4`),
 * find up to 3 exact child `ref`s nested inside THAT summary's own tool result object that hold the value.
 * Never relaxes `verifyReview` and never suggests unrelated records from other tools.
 *
 * @param {{ kind?: string, text?: string }} problem
 * @param {any[]} [sources]
 * @param {Map<string, { at: number | null, times?: Set<number>, numbers?: Set<number>, scope?: 'summary' | 'record', children?: Set<string> }>} [knownRefs]
 * @returns {string[]}
 */
export function suggestChildRefs(problem, sources = [], knownRefs = null) {
  if (!problem || problem.kind !== 'moment' || typeof problem.text !== 'string') return [];
  const m = MOMENT_PROBLEM.exec(problem.text);
  if (!m) return [];
  const rawVal = m[1].trim();
  const citedRefs = m[2].split(',').map((s) => s.trim()).filter(Boolean);
  if (!rawVal || !citedRefs.length) return [];

  const isClock = clockToSeconds(rawVal) != null;
  const num = isClock ? null : statedFacts(rawVal).numbers[0] ?? null;
  if (!isClock && !num) return [];

  const hasMeta = knownRefs instanceof Map && citedRefs.some((r) => knownRefs.get(r)?.children instanceof Set);
  const refsMap = hasMeta ? knownRefs : collectFacts(sources).refs;
  const citedSet = new Set(citedRefs);
  const out = [];
  const seen = new Set();
  for (const ref of citedRefs) {
    const entry = refsMap.get(ref);
    if (!entry || entry.scope !== 'summary' || !(entry.children instanceof Set) || !entry.children.size) continue;
    for (const childRef of entry.children) {
      if (seen.has(childRef) || citedSet.has(childRef)) continue;
      const child = refsMap.get(childRef);
      if (!child || child.scope === 'summary') continue;
      const matches = isClock ? timeInSet(child.times, rawVal) : numberInEvidence(child.numbers, num);
      if (matches) {
        seen.add(childRef);
        out.push(childRef);
        if (out.length >= 3) return out;
      }
    }
  }
  return out;
}

/**
 * Check a submitted review against what the tools returned.
 *
 * Checked: every clock time; every number of 100 or more; every decimal;
 * every small count ("7 times") against the tools' own counts; a whole
 * number of seconds may instead be a tool's number rounded ("8 s" for 7.6). An evidence
 * item cites tool records by `ref`: the refs must exist, and every time and
 * every number above 3 in its fact must be inside those records. A statement about who could
 * see whom is never backed (sightClaims). Wording (wordingProblems) is checked everywhere and marked
 * `soft`: it sends the review back once and never removes anything. Not checked: `fix` (advice),
 * `game_plan.main_reason` (a judgment), and `blind_spots`.
 *
 * @param {any} review  the submit_review arguments
 * @param {any[]} sources  tool results (and the context the model was given) of this run
 * @param {string[]} [accepted]  text already checked (a verified review, clean earlier answers): the counts it states may be repeated
 * @param {{ requireStructure?: boolean }} [options]  when `requireStructure` is true (used by `runDeepReview`), enforces `findings.length <= MAX_FINDINGS` and at least `MIN_CHAPTERS` surviving chapters
 * @returns {{ ok: boolean, problems: { where: 'verdict' | 'whole_review' | 'blind_spots' | 'highlight' | 'highlight_evidence' | 'chapter' | 'chapter_evidence' | 'chapters' | 'findings' | 'finding' | 'title' | 'plan' | 'plan_evidence' | 'game_plan', index: number, item?: number, kind: 'time' | 'number' | 'count' | 'moment' | 'ref' | 'sight' | 'missing' | 'language' | 'key' | 'name' | 'list' | 'unnamed' | 'english' | 'plan' | 'structure', text: string, soft?: true }[], unsupported: { findings: Set<number>, evidence: Map<number, Set<number>> }, refs: Map<string, { at: number | null }> }}
 */
export function verifyReview(review, sources, accepted = [], options = {}) {
  const requireStructure = options?.requireStructure === true;
  const listOf = (v) => (Array.isArray(v) ? v : []);
  const known = collectFacts(sources);
  for (const text of listOf(accepted)) for (const n of statedFacts(text).numbers) if (n.counted && !n.decimal) known.summary.add(n.value);
  const timeOk = (clock) => timeInSet(known.times, clock);
  const problems = [];
  const notes = [];
  const named = [].concat(sources ?? []).filter((s) => s && typeof s === 'object' && !Array.isArray(s) && s.hero_names);
  const names = named.find((s) => s.player_hero) ?? named[0] ?? {};
  const wording = (where, index, ...texts) => { for (const t of texts) for (const w of wordingProblems(t, names)) if (!notes.some((n) => n.where === where && n.index === index && n.kind === w.kind && n.text === w.text)) notes.push({ where, index, ...w, soft: true }); };
  const prose = (where, index, text) => {
    if (typeof text !== 'string') return;
    wording(where, index, text);
    const { times, numbers } = statedFacts(text);
    for (const s of sightClaims(text)) problems.push({ where, index, kind: 'sight', text: s });
    for (const c of new Set(times)) if (!timeOk(c)) problems.push({ where, index, kind: 'time', text: c });
    for (const n of numbers) {
      if (n.percent) { if (!percentOk(known.numbers, n)) problems.push({ where, index, kind: 'number', text: n.text }); } else if (n.value >= BIG) { if (!bigOk(n, known.numbers)) problems.push({ where, index, kind: 'number', text: n.text }); } else if (n.decimal) { if (!has(known.numbers, n.value, 0.05)) problems.push({ where, index, kind: 'number', text: n.text }); } else if (n.counted && n.value > TRIVIAL && !known.summary.has(n.value) && !(n.seconds && has(known.numbers, n.value, 0.95))) problems.push({ where, index, kind: 'count', text: n.text });
    }
  };
  const rawFindings = listOf(review?.findings);
  const rawBlindSpots = listOf(review?.blind_spots);
  const highlights = listOf(review?.highlights).slice(0, MAX_HIGHLIGHTS);
  const chapters = listOf(review?.chapters).slice(0, MAX_CHAPTERS);
  const plan = review?.game_plan && typeof review.game_plan === 'object' && !Array.isArray(review.game_plan) ? review.game_plan : null;

  const CJK = /[\u3400-\u9fff]/;
  const chinese = CJK.test([
    review?.verdict,
    ...rawFindings.map((f) => f?.claim),
    ...highlights.map((h) => h?.detail),
    ...chapters.map((c) => c?.analysis),
  ].filter((v) => typeof v === 'string').join(''));
  const tongue = (where, index, text) => {
    if (chinese && typeof text === 'string' && /[A-Za-z]{3}/.test(text) && !CJK.test(text)) problems.push({ where, index, kind: 'language', text: text.slice(0, 80) });
  };

  const badItems = new Map();
  const claimBad = new Set();
  const evidence = (index, e, where = 'finding') => {
    const refs = Array.isArray(e?.refs) ? e.refs.filter((r) => typeof r === 'string').slice(0, MAX_REFS) : [];
    const cited = refs.map((r) => known.refs.get(r));
    if (!refs.length) { problems.push({ where, index, kind: 'ref', text: '(no ref)' }); return; }
    refs.forEach((r, i) => { if (!cited[i]) problems.push({ where, index, kind: 'ref', text: r }); });
    if (cited.some((c) => !c)) return;
    const times = new Set(); const local = new Set();
    for (const c of cited) { for (const t of c.times) times.add(t); for (const n of c.numbers) local.add(n); }
    const inRecord = (clock) => timeInSet(times, clock);
    const fact = typeof e?.fact === 'string' ? e.fact : '';
    const stated = statedFacts(fact);
    wording(where, index, fact);
    for (const s of sightClaims(fact)) problems.push({ where, index, kind: 'sight', text: s });
    for (const c of new Set(stated.times)) if (!inRecord(c)) problems.push({ where, index, kind: 'moment', text: `${c} (not in ${refs.join(', ')})` });
    for (const n of stated.numbers) {
      if ((n.percent || n.value >= BIG || n.value > TRIVIAL || n.decimal) && !numberInEvidence(local, n)) problems.push({ where, index, kind: 'moment', text: `${n.text} (not in ${refs.join(', ')})` });
    }
  };

  prose('verdict', 0, review?.verdict);
  rawFindings.forEach((f, i) => {
    const before = problems.length;
    prose('finding', i, [f?.title, f?.claim].filter((v) => typeof v === 'string' && v).join('\n'));
    if (problems.length > before) claimBad.add(i);
    if (!(typeof f?.title === 'string' && f.title.trim())) problems.push({ where: 'title', index: i, kind: 'missing', text: 'title' });
    wording('finding', i, f?.fix);
    const items = Array.isArray(f?.evidence) ? f.evidence : [];
    if (!items.length) { problems.push({ where: 'finding', index: i, kind: 'ref', text: '(no evidence)' }); claimBad.add(i); }
    items.forEach((e, j) => { const n = problems.length; evidence(i, e); if (problems.length > n) badItems.set(i, (badItems.get(i) ?? new Set()).add(j)); });
    if (items.length && (badItems.get(i)?.size ?? 0) === items.length) claimBad.add(i);
  });
  rawBlindSpots.forEach((line, i) => wording('blind_spots', i, line));

  const style = (where, index, kind, text) => { if (!notes.some((n) => n.where === where && n.index === index && n.kind === kind && n.text === text)) notes.push({ where, index, kind, text, soft: true }); };
  const replacedKeys = Object.keys({ ...names.place_names, ...names.hero_names }).filter((k) => /^[a-z][a-z_]*$/.test(k)).sort((a, b) => b.length - a.length);
  const keyWords = replacedKeys.length ? new RegExp(`(?<![A-Za-z_])(?:${replacedKeys.join('|')})(?![A-Za-z_])`, 'g') : null;
  const proseOf = (t) => { const body = stripHandles(typeof t === 'string' ? t : '').replace(BARE_HANDLE, ' ').replace(KEY, ' '); return keyWords ? body.replace(keyWords, ' ') : body; };
  const LINE_CHECKED = new Set(['highlight', 'highlight_evidence', 'chapter', 'chapter_evidence', 'plan', 'plan_evidence']);
  const english = (where, index, ...texts) => {
    if (!chinese) return;
    const words = [...new Set(texts.filter((t) => typeof t === 'string' && (!LINE_CHECKED.has(where) || CJK.test(t))).flatMap((t) => englishWords(proseOf(t))))];
    if (words.length) style(where, index, 'english', words.slice(0, 8).join(', '));
  };

  english('verdict', 0, review?.verdict);
  highlights.forEach((h, i) => {
    for (const k of ['title', 'detail']) {
      if (typeof h?.[k] === 'string') { prose('highlight', i, h[k]); tongue('highlight', i, h[k]); english('highlight', i, h[k]); }
    }
    (Array.isArray(h?.evidence) ? h.evidence.slice(0, MAX_HIGHLIGHT_EVIDENCE) : []).forEach((e, j) => {
      const n = problems.length;
      evidence(i, e, 'highlight_evidence'); tongue('highlight_evidence', i, e?.fact);
      for (let k = n; k < problems.length; k += 1) problems[k].item = j;
      english('highlight_evidence', i, e?.fact);
    });
  });
  chapters.forEach((c, i) => {
    for (const k of ['title', 'analysis']) {
      if (typeof c?.[k] === 'string') { prose('chapter', i, c[k]); tongue('chapter', i, c[k]); english('chapter', i, c[k]); }
    }
    const items = Array.isArray(c?.evidence) ? c.evidence.slice(0, MAX_CHAPTER_EVIDENCE) : [];
    if (c && typeof c === 'object' && !Array.isArray(c) && !items.length) {
      problems.push({ where: 'chapter_evidence', index: i, item: 0, kind: 'ref', text: '(no evidence)' });
    }
    items.forEach((e, j) => {
      const n = problems.length;
      evidence(i, e, 'chapter_evidence'); tongue('chapter_evidence', i, e?.fact);
      for (let k = n; k < problems.length; k += 1) problems[k].item = j;
      english('chapter_evidence', i, e?.fact);
    });
  });
  rawBlindSpots.forEach((line, i) => english('blind_spots', i, line));
  rawFindings.forEach((f, i) => {
    english('finding', i, f?.title, f?.claim, f?.fix, ...(Array.isArray(f?.evidence) ? f.evidence.map((e) => e?.fact) : []));
  });
  if (plan) {
    PLAN_TEXTS.forEach((k, i) => {
      if (typeof plan[k] === 'string') { prose('plan', i, plan[k]); tongue('plan', i, plan[k]); english('plan', i, plan[k]); }
    });
    (Array.isArray(plan.evidence) ? plan.evidence : []).forEach((e, j) => {
      evidence(j, e, 'plan_evidence'); tongue('plan_evidence', j, e?.fact);
    });
    english('plan_evidence', 0, ...(Array.isArray(plan.evidence) ? plan.evidence.map((e) => e?.fact) : []));
  }
  for (const u of unnamedHeroes(review, sources, names)) style('whole_review', 0, 'unnamed', u);
  const planGap = plan ? planGapOf(plan, [...problems, ...notes], known.refs) : null;
  if (planGap) notes.push({ where: 'game_plan', index: 0, kind: 'plan', text: planGap, soft: true });
  if (requireStructure) {
    if (rawFindings.length > MAX_FINDINGS) {
      problems.push({ where: 'findings', index: MAX_FINDINGS, kind: 'structure', text: `too_many_findings (${rawFindings.length} > ${MAX_FINDINGS})` });
    }
    const survivingChapters = chaptersOf(chapters, problems, known.refs);
    if (chapters.length < MIN_CHAPTERS) {
      problems.push({ where: 'chapters', index: 0, kind: 'structure', text: `too_few_chapters (${chapters.length} < ${MIN_CHAPTERS})` });
    } else if (survivingChapters.length < MIN_CHAPTERS) {
      problems.push({ where: 'chapters', index: 0, kind: 'structure', text: `chapters_dropped_below_min (${survivingChapters.length} < ${MIN_CHAPTERS})` });
    }
  }
  problems.push(...notes);
  return { ok: problems.length === 0, problems, refs: known.refs, unsupported: { findings: claimBad, evidence: badItems } };
}

/** A hero who killed the player this many times or more is one a review of the game speaks of. */
const UNNAMED_MIN_KILLS = 3;
/** Every string the review shows a reader, refs/enums aside. */
function reviewText(review) {
  const out = [];
  const walk = (v, key) => {
    if (typeof v === 'string') { if (key !== 'refs' && key !== 'topic' && key !== 'main_reason') out.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, key); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(review, null);
  return out.join('\n');
}
/**
 * The heroes who killed the player most (`killed_by` in a tool's answer about the player, 3 kills or more) whose name (hero_names) is nowhere
 * in the review: "熊战士 (ursa)".
 */
export function unnamedHeroes(review, sources, names = {}) {
  const heroNames = names?.hero_names ?? {};
  const kills = new Map();
  const walk = (v, about) => {
    if (Array.isArray(v)) { for (const x of v) walk(x, about); return; }
    if (!v || typeof v !== 'object') return;
    const self = typeof v.hero === 'string' ? v.hero : about;
    for (const [k, x] of Object.entries(v)) {
      if (k === 'killed_by' && x && typeof x === 'object' && !Array.isArray(x)) {
        if (self === names?.player_hero) for (const [h, n] of Object.entries(x)) if (Number.isFinite(n)) kills.set(h, Math.max(kills.get(h) ?? 0, n));
      } else walk(x, self);
    }
  };
  for (const s of [].concat(sources ?? [])) walk(s, null);
  const text = reviewText(review);
  const named = (k) => text.includes(heroNames[k]) || new RegExp(`(?<![A-Za-z0-9_])${k}(?![A-Za-z0-9_])`).test(text);
  return [...kills].filter(([k, n]) => n >= UNNAMED_MIN_KILLS && k !== names?.player_hero && typeof heroNames[k] === 'string' && CJK_ONLY.test(heroNames[k]) && !named(k))
    .sort((a, b) => b[1] - a[1]).map(([k]) => `${heroNames[k]} (${k})`);
}

/**
 * Why a review would ship without a game plan, or null when it would ship one:
 * 'not_submitted', 'no_reason', or 'no_evidence_that_holds'.
 */
export function planGapOf(plan, problems, refs, o = {}) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return 'not_submitted';
  if (planOf(plan, problems, refs, o)) return null;
  const bad = new Set((Array.isArray(problems) ? problems : []).filter((p) => p?.where === 'plan' && !p.soft).map((p) => p.index));
  const holds = (k) => !bad.has(PLAN_TEXTS.indexOf(k)) && str(plan[k]);
  const hasReason = Boolean(holds('why') && PLAN_REASONS.includes(plan.main_reason));
  const hasAnyText = Boolean(hasReason || (o.stated && holds('against_your_plan')));
  return hasAnyText ? 'no_evidence_that_holds' : 'no_reason';
}

/**
 * Concise whole-game attribution as it ships: `main_reason` + `why` (and `against_your_plan` when the player stated
 * a plan), plus any optional `evidence` items that hold. If `plan.evidence` is supplied non-empty (or malformed),
 * at least one item must hold.
 */
export function planOf(plan, problems, refs, { stated = false } = {}) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
  const plist = Array.isArray(problems) ? problems : [];
  const bad = (where) => new Set(plist.filter((p) => p?.where === where && !p.soft).map((p) => p.index));
  const badText = bad('plan'); const badItems = bad('plan_evidence');
  const text = (k) => (badText.has(PLAN_TEXTS.indexOf(k)) ? null : str(plan[k]));
  const why = text('why');
  const against = stated ? text('against_your_plan') : null;
  const fmt = (t) => `${t < 0 ? '-' : ''}${Math.floor(Math.abs(Math.trunc(t)) / 60)}:${String(Math.abs(Math.trunc(t)) % 60).padStart(2, '0')}`;
  const hasSubmittedEvidence = plan.evidence != null && (!Array.isArray(plan.evidence) || plan.evidence.length > 0);
  const rawEvidence = Array.isArray(plan.evidence) ? plan.evidence : [];
  const evidence = rawEvidence.slice(0, MAX_PLAN_EVIDENCE)
    .map((e, j) => (badItems.has(j) || !str(e?.fact) || !Array.isArray(e?.refs) ? null : { fact: e.fact, refs: e.refs.filter((r) => typeof r === 'string').slice(0, MAX_REFS) })).filter((e) => e?.refs.length)
    .map((e) => { const at = refs?.get?.(e.refs[0])?.at; return { refs: e.refs, ...(at == null ? {} : { clock: fmt(at) }), fact: e.fact }; });
  const hasReason = Boolean(why && PLAN_REASONS.includes(plan.main_reason));
  if (!hasReason && !against) return null;
  if (hasSubmittedEvidence && !evidence.length) return null;
  return {
    ...(against ? { against_your_plan: against } : {}),
    ...(hasReason ? { main_reason: plan.main_reason, why } : {}),
    evidence,
  };
}

/**
 * Verified highlights as they ship: any highlight whose title or detail failed hard verification is dropped;
 * optional evidence items that fail are dropped cleanly while keeping the highlight when its prose holds.
 */
export function highlightsOf(highlights, problems, refs) {
  const list = Array.isArray(highlights) ? highlights.slice(0, MAX_HIGHLIGHTS) : [];
  const hard = (Array.isArray(problems) ? problems : []).filter((p) => p && !p.soft);
  const badHighlight = new Set(hard.filter((p) => p.where === 'highlight').map((p) => p.index));
  const badItem = (i, j) => hard.some((p) => p.where === 'highlight_evidence' && p.index === i && p.item === j);
  const fmt = (t) => `${t < 0 ? '-' : ''}${Math.floor(Math.abs(Math.trunc(t)) / 60)}:${String(Math.abs(Math.trunc(t)) % 60).padStart(2, '0')}`;
  const out = [];
  list.forEach((h, i) => {
    if (!h || typeof h !== 'object' || Array.isArray(h) || badHighlight.has(i)) return;
    const title = str(h.title); const detail = str(h.detail);
    if (!title || !detail) return;
    const evidence = (Array.isArray(h.evidence) ? h.evidence.slice(0, MAX_HIGHLIGHT_EVIDENCE) : [])
      .map((e, j) => (badItem(i, j) || !str(e?.fact) || !Array.isArray(e?.refs) ? null : { fact: e.fact.trim(), refs: e.refs.filter((r) => typeof r === 'string').slice(0, MAX_REFS) }))
      .filter((e) => e?.refs.length)
      .map((e) => { const at = refs?.get?.(e.refs[0])?.at; return { refs: e.refs, ...(at == null ? {} : { clock: fmt(at) }), fact: e.fact }; });
    out.push({ title, detail, ...(evidence.length ? { evidence } : {}) });
  });
  return out;
}

/**
 * Verified walkthrough chapters as they ship: a chapter ships only when its prose holds AND at least one
 * cited evidence item holds. Unknown topic values normalize to 'other'.
 */
export function chaptersOf(chapters, problems, refs) {
  const list = Array.isArray(chapters) ? chapters.slice(0, MAX_CHAPTERS) : [];
  const hard = (Array.isArray(problems) ? problems : []).filter((p) => p && !p.soft);
  const badChapter = new Set(hard.filter((p) => p.where === 'chapter').map((p) => p.index));
  const badItem = (i, j) => hard.some((p) => p.where === 'chapter_evidence' && p.index === i && p.item === j);
  const fmt = (t) => `${t < 0 ? '-' : ''}${Math.floor(Math.abs(Math.trunc(t)) / 60)}:${String(Math.abs(Math.trunc(t)) % 60).padStart(2, '0')}`;
  const out = [];
  list.forEach((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c) || badChapter.has(i)) return;
    const title = str(c.title); const analysis = str(c.analysis);
    if (!title || !analysis) return;
    const evidence = (Array.isArray(c.evidence) ? c.evidence.slice(0, MAX_CHAPTER_EVIDENCE) : [])
      .map((e, j) => (badItem(i, j) || !str(e?.fact) || !Array.isArray(e?.refs) ? null : { fact: e.fact.trim(), refs: e.refs.filter((r) => typeof r === 'string').slice(0, MAX_REFS) }))
      .filter((e) => e?.refs.length)
      .map((e) => { const at = refs?.get?.(e.refs[0])?.at; return { refs: e.refs, ...(at == null ? {} : { clock: fmt(at) }), fact: e.fact }; });
    if (!evidence.length) return;
    out.push({
      topic: CHAPTER_TOPICS.includes(c.topic) ? c.topic : 'other',
      title,
      analysis,
      evidence,
    });
  });
  return out;
}

/**
 * Check free text (a chat answer) the same way a review's prose is checked:
 * clock times, numbers of 100 or more, decimals, and small counts. `accepted`
 * is text that was already checked; a count it states ("7 times") may be repeated.
 * @returns {{ ok: boolean, problems: { kind: string, text: string }[] }}
 */
export function verifyText(text, sources, accepted = []) {
  const r = verifyReview({ verdict: text, findings: [] }, sources, accepted);
  const problems = r.problems.filter((p) => !p.soft);
  return { ok: problems.length === 0, problems: problems.map(({ kind, text: t }) => ({ kind, text: t })) };
}
