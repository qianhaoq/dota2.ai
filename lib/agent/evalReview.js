/**
 * Scoring a finished deep review without a model.
 *
 * verifyReview (deepReview.js) checks that a review states only what the tools returned. It does not say
 * whether the review is about the right things, whether a reader can take it in, or whether two runs on the
 * same game agree. This module measures those, from the stored review alone:
 *
 * - style: how many times and numbers a sentence carries, English words left in a review written in Chinese,
 *   how long the verdict is;
 * - logic: whether each rule rests on more than one moment of this game, and whether the review calls the
 *   same matchup both favoured and unfavoured;
 * - rubric (when a person has written one for the game, evals/reviews/): whether the findings say what the
 *   rubric says they must, say nothing it rules out, look at the fight the game turned on, and put the
 *   course of the game down to a reason the rubric accepts;
 * - stability: over several reviews of one game, how often they agree on that reason and on what the first
 *   finding rests on.
 *
 * Pure: no IO, no clock, no model. A rubric is a judgment written down; everything else is counting.
 */
import { NUMBERS_PER_SENTENCE, englishWords, sentenceFacts, statedFacts } from './deepReview.js';

export const RUBRIC_SCHEMA = 'dota2.ai/review-rubric@1';
/** A sentence with more times and numbers than this is counted as dense: the check's own number, so the eval and the repair round count alike. */
export { NUMBERS_PER_SENTENCE };
/** A stated time counts as a rubric's time when it is within this many seconds of it. */
const CLOCK_SLACK = 20;
const CJK = /[㐀-鿿]/;
const PLAN_TEXTS = ['against_your_plan', 'window', 'strengths', 'line_ups', 'course', 'your_part', 'why'];

const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
const seconds = (clock) => { const m = String(clock).match(/^(-)?(\d{1,3}):([0-5]\d)$/); return m ? (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : null; };

/** A stored review ({ review, verification, … }) or the review itself. */
export const reviewOf = (stored) => (stored && typeof stored === 'object' && stored.review && typeof stored.review === 'object' ? stored.review : stored);

/**
 * Every piece of prose in a review, with where it stands. `layer` is 'top' for what the reader is meant to
 * take away (verdict, each finding's title, claim, rule and fix), 'evidence' for the cited facts, and 'story'
 * for the rest (mainline, game plan, what went well, blind spots).
 * @returns {{ where: string, index: number, layer: 'top' | 'evidence' | 'story', text: string }[]}
 */
export function reviewTexts(stored) {
  const r = reviewOf(stored) ?? {};
  const out = [];
  const add = (where, index, layer, text) => { if (str(text)) out.push({ where, index, layer, text }); };
  add('verdict', 0, 'top', r.verdict);
  (r.findings ?? []).forEach((f, i) => {
    add('title', i, 'top', f?.title); add('claim', i, 'top', f?.claim); add('fix', i, 'top', f?.fix);
    add('rule', i, 'top', f?.rule?.when); add('rule', i, 'top', f?.rule?.do); add('rule', i, 'top', f?.rule?.this_game);
    (f?.evidence ?? []).forEach((e) => add('evidence', i, 'evidence', e?.fact));
  });
  (r.mainline ?? []).forEach((t, i) => add('mainline', i, 'story', t));
  PLAN_TEXTS.forEach((k, i) => add('plan', i, 'story', r.game_plan?.[k]));
  (r.game_plan?.evidence ?? []).forEach((e, i) => add('plan_evidence', i, 'evidence', e?.fact));
  (r.did_well ?? []).forEach((t, i) => add('did_well', i, 'story', t));
  (r.blind_spots ?? []).forEach((t, i) => add('blind_spots', i, 'story', t));
  return out;
}

function density(texts) {
  const counts = texts.flatMap((t) => sentenceFacts(t.text)).map((s) => s.facts);
  const n = counts.length;
  return {
    sentences: n,
    dense: counts.filter((c) => c > NUMBERS_PER_SENTENCE).length,
    most: n ? Math.max(...counts) : 0,
    mean: n ? Math.round((counts.reduce((a, c) => a + c, 0) / n) * 10) / 10 : 0,
  };
}

/**
 * How the review reads: the verdict's length, the whole text's length, how dense the top layer and the whole
 * review are (sentences, how many are dense, the most in one sentence, the mean), and the English words left in.
 * `english` is null for a review that was not asked for in Chinese (`lang`): its words are not leaks.
 */
export function styleOf(stored) {
  const texts = reviewTexts(stored);
  const verdict = str(reviewOf(stored)?.verdict) ?? '';
  // The language the review was asked for decides: one asked for in Chinese that came back in English is all
  // leak, and an English one that quotes a Chinese name is not a Chinese review. Only a record without `lang`
  // (none is stored that way; a bare object in a test may be) is judged by what it is written in.
  const asked = reviewOf(stored)?.lang;
  const chinese = asked === 'zh' || (asked !== 'en' && CJK.test(verdict + texts.filter((t) => t.where === 'claim').map((t) => t.text).join('')));
  let english = null;
  if (chinese) {
    const found = []; let inTexts = 0;
    for (const t of texts) {
      const words = englishWords(t.text);
      if (words.length) inTexts += 1;
      found.push(...words);
    }
    english = { words: found.length, texts: inTexts, examples: [...new Set(found)].slice(0, 8) };
  }
  return {
    verdict_chars: [...verdict].length,
    chars: texts.reduce((a, t) => a + [...t.text].length, 0),
    top: density(texts.filter((t) => t.layer === 'top')),
    all: density(texts),
    english,
  };
}

const FAVOURED = /(?:对位|对线|matchup)[^。.；;\n]{0,24}(?:占优|优势|favou?red|favou?rable)|(?:占优|优势)[^。.；;\n]{0,6}对位/gi;
const UNFAVOURED = /劣势对位|(?:对位|matchup)[^。.；;\n]{0,24}(?:劣势|unfavou?red|unfavou?rable)/gi;
const ONLY_ONCE = /只有\s*(?:1|一)\s*次|仅\s*(?:1|一)\s*次|\bonly\s+(?:one|1|once)\b/i;

/**
 * What a rule rests on in this game: the count its check was made from (`check.baseline`), else the number of
 * moments its `this_game` names. A rule from one moment is a story, not a habit.
 */
function ruleSupport(f) {
  const rule = f?.rule;
  if (!str(rule?.when) || !str(rule?.do)) return { has_rule: false, support: 0, thin: true, says_only_once: false };
  const seen = str(rule.this_game) ?? '';
  const moments = new Set(statedFacts(seen).times).size;
  const support = Math.max(moments, Number.isInteger(rule.check?.baseline) ? rule.check.baseline : 0);
  return { has_rule: true, support, thin: support < 2, says_only_once: ONLY_ONCE.test(seen) };
}

/**
 * Whether the review holds together.
 * `matchup_both_ways` lists a sentence that calls a matchup favoured and one that calls a matchup unfavoured:
 * they may be about different enemies or different measures (the lane, the whole game), so it is something
 * to look at, not an error.
 */
export function logicOf(stored) {
  const r = reviewOf(stored) ?? {};
  const rules = (r.findings ?? []).map(ruleSupport);
  const texts = reviewTexts(stored).filter((t) => t.layer !== 'evidence');
  const pick = (re) => texts.flatMap((t) => sentenceFacts(t.text).map((x) => x.sentence)).filter((s) => { re.lastIndex = 0; return re.test(s) && !(re === FAVOURED && /劣势|unfavou?r/i.test(s)); });
  const favoured = pick(FAVOURED); const unfavoured = pick(UNFAVOURED);
  return {
    findings: (r.findings ?? []).length,
    rules,
    thin_rules: rules.filter((x) => x.thin).length,
    rules_that_say_only_once: rules.filter((x) => x.says_only_once).length,
    matchup_both_ways: favoured.length && unfavoured.length ? { favoured: favoured[0].slice(0, 120), unfavoured: unfavoured[0].slice(0, 120) } : null,
  };
}

/** Everything a finding says, as one text, and the game times it names (its evidence clocks and every time in its prose). */
function findingView(f) {
  const text = [f?.title, f?.claim, f?.fix, f?.rule?.when, f?.rule?.do, f?.rule?.this_game, ...(f?.evidence ?? []).map((e) => e?.fact)].filter(str).join('\n');
  const refs = (f?.evidence ?? []).flatMap((e) => (Array.isArray(e?.refs) ? e.refs : [])).filter((x) => typeof x === 'string');
  const times = [...(f?.evidence ?? []).map((e) => e?.clock), ...statedFacts(text).times].map(seconds).filter((t) => t != null);
  return { text, refs, times };
}

const anyTerm = (text, terms) => !Array.isArray(terms) || !terms.length || terms.some((t) => typeof t === 'string' && t && text.toLowerCase().includes(t.toLowerCase()));
const termsFor = (group, lang) => (group && typeof group === 'object' && !Array.isArray(group) ? group[lang] ?? group.en ?? null : group ?? null);

/**
 * Does `view` say what a rubric point asks for?
 * - `any.refs`: one of the view's evidence refs is one of these, or continues one of them past a colon
 *   ("death:tidehunter:1" is that record and "death:tidehunter:1:w20", never "death:tidehunter:10"; write
 *   "cast:beastmaster:primal_roar:" to mean every cast); `any.clocks`: one of its times is within `any.within` seconds (default 20)
 *   of one of these. With both given, either is enough. Without `any`, where it stands is not asked.
 * - `terms` and `and_terms`: the text names one word of each list (per language: { zh: […], en: […] }).
 */
function says(point, view, lang) {
  const any = point?.any;
  let anchored = true;
  if (any && (Array.isArray(any.refs) || Array.isArray(any.clocks))) {
    const byRef = (any.refs ?? []).filter((p) => typeof p === 'string' && p).some((p) => view.refs.some((r) => r === p || r.startsWith(p.endsWith(':') ? p : `${p}:`)));
    const slack = Number.isFinite(any.within) ? any.within : CLOCK_SLACK;
    const byClock = (any.clocks ?? []).map(seconds).filter((t) => t != null).some((t) => view.times.some((x) => Math.abs(x - t) <= slack));
    anchored = byRef || byClock;
  }
  return anchored && anyTerm(view.text, termsFor(point?.terms, lang)) && anyTerm(view.text, termsFor(point?.and_terms, lang));
}

/**
 * A review against the rubric of its game.
 * @param {any} stored
 * @param {any} rubric  { schema, match_id, hero, status, must_hit?: [{ id, says, weight?, where?, any?, terms?, and_terms? }], must_praise?: [{ id, says, weight?, where?, any?, terms?, and_terms? }], max_findings?: number, must_not?: [{ id, says, terms?, pattern? }], turning_fight?: { fight?, from, to }, main_reason?: string[] }
 */
export function rubricOf(stored, rubric) {
  const r = reviewOf(stored) ?? {};
  const lang = r.lang === 'zh' ? 'zh' : 'en';
  const views = (r.findings ?? []).map(findingView);
  const praiseViews = (r.did_well ?? []).filter(str).map((text) => ({ text, refs: [], times: statedFacts(text).times.map(seconds).filter((t) => t != null) }));
  const all = reviewTexts(stored);
  const whole = { text: all.map((t) => t.text).join('\n'), refs: [...views.flatMap((v) => v.refs), ...(r.game_plan?.evidence ?? []).flatMap((e) => e?.refs ?? [])], times: [...views.flatMap((v) => v.times), ...statedFacts(all.map((t) => t.text).join('\n')).times.map(seconds).filter((t) => t != null)] };
  const mustHit = (rubric?.must_hit ?? []).map((p) => {
    const i = views.findIndex((v) => says(p, v, lang));
    const hit = i >= 0 || (p.where === 'review' && says(p, whole, lang));
    return { id: p.id, hit, finding: i >= 0 ? i + 1 : null };
  });
  const weightOf = (list, id) => { const w = (list ?? []).find((p) => p.id === id)?.weight; return Number.isFinite(w) && w > 0 ? w : 1; };
  const weight = mustHit.reduce((a, p) => a + weightOf(rubric?.must_hit, p.id), 0);
  const hitWeight = mustHit.filter((p) => p.hit).reduce((a, p) => a + weightOf(rubric?.must_hit, p.id), 0);

  // One-sided wins (#361): what the player did well (`did_well`), and an upper bound on how many findings are made.
  const hasPraise = Array.isArray(rubric?.must_praise) && rubric.must_praise.length > 0;
  const mustPraise = hasPraise ? rubric.must_praise.map((p) => {
    const i = praiseViews.findIndex((v) => says(p, v, lang));
    const hit = i >= 0 || (p.where === 'review' && says(p, whole, lang));
    return { id: p.id, hit, item: i >= 0 ? i + 1 : null };
  }) : null;
  const praiseWeight = mustPraise ? mustPraise.reduce((a, p) => a + weightOf(rubric.must_praise, p.id), 0) : 0;
  const praiseHitWeight = mustPraise ? mustPraise.filter((p) => p.hit).reduce((a, p) => a + weightOf(rubric.must_praise, p.id), 0) : 0;
  const hasMaxFindings = Number.isInteger(rubric?.max_findings) && rubric.max_findings >= 0;

  const mustNot = [];
  for (const p of rubric?.must_not ?? []) {
    const terms = termsFor(p.terms, lang);
    let found = null;
    if (typeof p.pattern === 'string') { try { found = whole.text.match(new RegExp(p.pattern, 'i'))?.[0] ?? null; } catch { found = null; } }
    if (!found && Array.isArray(terms)) found = terms.find((t) => typeof t === 'string' && t && whole.text.toLowerCase().includes(t.toLowerCase())) ?? null;
    if (found) mustNot.push({ id: p.id, text: found.slice(0, 80) });
  }
  const turn = rubric?.turning_fight;
  const turning = turn && Number.isFinite(turn.from) && Number.isFinite(turn.to)
    ? views.some((v) => v.times.some((t) => t >= turn.from - CLOCK_SLACK && t <= turn.to + CLOCK_SLACK) || (Number.isInteger(turn.fight) && v.refs.some((x) => x === `fight:${turn.fight}` || new RegExp(`^fights:[a-z_]+:${turn.fight}$`).test(x))))
    : null;
  const reason = r.game_plan?.main_reason;
  // The first finding is what the page shows as the game's one lesson. `lead_any` lists the must_hit points the
  // rubric accepts there: a review can say the right things and still lead with the wrong one. null when the
  // rubric does not say; false also for a review with no finding at all.
  const leadIds = Array.isArray(rubric?.lead_any) ? rubric.lead_any.filter((id) => (rubric.must_hit ?? []).some((p) => p.id === id)) : [];
  const lead = leadIds.length && views.length ? leadIds.find((id) => says(rubric.must_hit.find((p) => p.id === id), views[0], lang)) ?? null : null;
  return {
    status: rubric?.status === 'approved' ? 'approved' : 'draft',
    must_hit: mustHit, hit_weight: hitWeight, weight, hit_rate: weight ? Math.round((hitWeight / weight) * 100) / 100 : null,
    ...(hasPraise ? { must_praise: mustPraise, praise_hit_weight: praiseHitWeight, praise_weight: praiseWeight, praise_rate: praiseWeight ? Math.round((praiseHitWeight / praiseWeight) * 100) / 100 : null } : {}),
    ...(hasMaxFindings ? { max_findings: rubric.max_findings, findings_within_max: views.length <= rubric.max_findings } : {}),
    must_not: mustNot,
    turning_fight_covered: turning,
    // Which accepted point the first finding makes, and whether it makes one (null: the rubric names none).
    lead, lead_ok: leadIds.length ? lead != null : null,
    main_reason_ok: Array.isArray(rubric?.main_reason) && rubric.main_reason.length && typeof reason === 'string' ? rubric.main_reason.includes(reason) : null,
  };
}

/**
 * One review's scores. `rubric` is null when the game has none.
 * @param {any} stored
 * @param {any} [rubric]
 */
export function scoreReview(stored, rubric = null) {
  const v = stored?.verification;
  return {
    style: styleOf(stored),
    logic: logicOf(stored),
    // A review with no game plan has no main reason to score (#388).
    has_game_plan: Boolean(reviewOf(stored)?.game_plan && typeof reviewOf(stored).game_plan === 'object'),
    rubric: rubric ? rubricOf(stored, rubric) : null,
    verification: v && typeof v === 'object' ? { repaired: v.repaired === true, dropped: Number.isInteger(v.dropped) ? v.dropped : null, first_pass_problems: Number.isInteger(v.first_pass_problems) ? v.first_pass_problems : null } : null,
  };
}

const jaccard = (a, b) => { const A = new Set(a); const B = new Set(b); if (!A.size && !B.size) return null; let both = 0; for (const x of A) if (B.has(x)) both += 1; return both / (A.size + B.size - both); };

/**
 * How far several reviews of one game (same hero and language) agree.
 * - `main_reason`: how many gave each reason, and the share of the commonest among those that gave one;
 * - `first_finding_overlap`: over every pair of reviews whose first finding cites something, how much of what
 *   it cites is the same (Jaccard over its evidence refs), averaged; null when fewer than two reviews cite anything.
 * A review of another prompt version is another run: this measures what a reader would get on another day,
 * not the noise of one prompt alone.
 */
export function stabilityOf(storedList) {
  const reviews = (storedList ?? []).map(reviewOf).filter((r) => r && typeof r === 'object');
  const reasons = {};
  for (const r of reviews) { const k = r.game_plan?.main_reason; if (typeof k === 'string') reasons[k] = (reasons[k] ?? 0) + 1; }
  const given = Object.values(reasons).reduce((a, n) => a + n, 0);
  // A review whose first finding cites nothing (or that has no finding) has nothing to compare: it is left out,
  // not counted as disagreeing with the ones that do cite.
  const firsts = reviews.map((r) => findingView(r.findings?.[0]).refs).filter((refs) => refs.length > 0);
  const pairs = [];
  for (let i = 0; i < firsts.length; i += 1) for (let j = i + 1; j < firsts.length; j += 1) { const s = jaccard(firsts[i], firsts[j]); if (s != null) pairs.push(s); }
  return {
    reviews: reviews.length,
    main_reason: reasons,
    main_reason_agreement: given >= 2 ? Math.round((Math.max(...Object.values(reasons)) / given) * 100) / 100 : null,
    first_finding_overlap: pairs.length ? Math.round((pairs.reduce((a, s) => a + s, 0) / pairs.length) * 100) / 100 : null,
  };
}

const mean = (list) => (list.length ? Math.round((list.reduce((a, n) => a + n, 0) / list.length) * 100) / 100 : null);
const share = (k, n) => (n ? Math.round((k / n) * 100) / 100 : null);

/**
 * The scores of many reviews as one row of numbers: what a baseline keeps and a later run is compared with.
 * Rubric numbers are over the reviews that have a rubric, and approved rubrics are counted apart from drafts.
 * @param {ReturnType<typeof scoreReview>[]} scores
 */
export function summarize(scores) {
  const zh = scores.filter((s) => s.style.english);
  const withRubric = (status) => scores.filter((s) => s.rubric && s.rubric.status === status);
  const rubricRow = (list) => (list.length ? {
    reviews: list.length,
    hit_rate: mean(list.map((s) => s.rubric.hit_rate).filter((x) => x != null)),
    ...(list.some((s) => s.rubric.praise_rate != null) ? { praise_rate: mean(list.map((s) => s.rubric.praise_rate).filter((x) => x != null)) } : {}),
    ...(list.some((s) => s.rubric.findings_within_max != null) ? { findings_within_max: share(list.filter((s) => s.rubric.findings_within_max === true).length, list.filter((s) => s.rubric.findings_within_max != null).length) } : {}),
    must_not_violations: list.reduce((a, s) => a + s.rubric.must_not.length, 0),
    turning_fight_covered: share(list.filter((s) => s.rubric.turning_fight_covered === true).length, list.filter((s) => s.rubric.turning_fight_covered != null).length),
    // Over the reviews whose rubric says which points may lead.
    lead_ok: share(list.filter((s) => s.rubric.lead_ok === true).length, list.filter((s) => s.rubric.lead_ok != null).length),
    main_reason_ok: share(list.filter((s) => s.rubric.main_reason_ok === true).length, list.filter((s) => s.rubric.main_reason_ok != null).length),
  } : null);
  const rules = scores.flatMap((s) => s.logic.rules);
  return {
    reviews: scores.length,
    verdict_chars: mean(scores.map((s) => s.style.verdict_chars)),
    verdict_chars_chinese: mean(zh.map((s) => s.style.verdict_chars)),
    chars: mean(scores.map((s) => s.style.chars)),
    top_dense_sentences: share(scores.reduce((a, s) => a + s.style.top.dense, 0), scores.reduce((a, s) => a + s.style.top.sentences, 0)),
    top_numbers_per_sentence: mean(scores.map((s) => s.style.top.mean)),
    chinese_reviews_with_english_words: share(zh.filter((s) => s.style.english.words > 0).length, zh.length),
    english_words_per_chinese_review: mean(zh.map((s) => s.style.english.words)),
    findings: mean(scores.map((s) => s.logic.findings)),
    thin_rules: share(rules.filter((x) => x.thin).length, rules.length),
    rules_that_say_only_once: share(rules.filter((x) => x.says_only_once).length, rules.length),
    matchup_both_ways: share(scores.filter((s) => s.logic.matchup_both_ways).length, scores.length),
    repaired: share(scores.filter((s) => s.verification?.repaired).length, scores.filter((s) => s.verification).length),
    without_game_plan: share(scores.filter((s) => !s.has_game_plan).length, scores.length),
    rubric_approved: rubricRow(withRubric('approved')),
    rubric_draft: rubricRow(withRubric('draft')),
  };
}

/** Which way is better for each summary number: +1 higher, -1 lower. Numbers not listed are not judged. */
export const BETTER = {
  top_dense_sentences: -1, chinese_reviews_with_english_words: -1, english_words_per_chinese_review: -1, thin_rules: -1, rules_that_say_only_once: -1, matchup_both_ways: -1, without_game_plan: -1,
  'rubric_approved.hit_rate': 1, 'rubric_approved.praise_rate': 1, 'rubric_approved.findings_within_max': 1, 'rubric_approved.must_not_violations': -1, 'rubric_approved.turning_fight_covered': 1, 'rubric_approved.lead_ok': 1, 'rubric_approved.main_reason_ok': 1,
  'rubric_draft.hit_rate': 1, 'rubric_draft.praise_rate': 1, 'rubric_draft.findings_within_max': 1, 'rubric_draft.must_not_violations': -1, 'rubric_draft.turning_fight_covered': 1, 'rubric_draft.lead_ok': 1, 'rubric_draft.main_reason_ok': 1,
  main_reason_agreement: 1, first_finding_overlap: 1,
};

/**
 * What got worse between two summaries (and what got better), for the numbers BETTER judges. A change smaller
 * than `tolerance` is not listed; a number missing on either side is not compared.
 * @returns {{ worse: { key: string, before: number, after: number }[], better: { key: string, before: number, after: number }[] }}
 */
export function compareSummaries(before, after, { tolerance = 0.02 } = {}) {
  const at = (o, key) => key.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), o);
  const worse = []; const better = [];
  for (const [key, dir] of Object.entries(BETTER)) {
    const a = at(before, key); const b = at(after, key);
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(b - a) <= tolerance) continue;
    ((b - a) * dir < 0 ? worse : better).push({ key, before: a, after: b });
  }
  return { worse, better };
}
