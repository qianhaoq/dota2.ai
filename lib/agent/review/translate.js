/**
 * Translate a verified deep review into the remaining site languages in one
 * tool-free completion, keeping every structural field (refs, clocks, goals,
 * habit checks, patch metadata, main_reason) intact.
 */
import { jsonrepair } from 'jsonrepair';
import { SUPPORTED_LANGS, normalizeUiLang } from '../../aiLanguage.js';
import { placeNames } from '../places.js';
import { PLAN_TEXTS } from './schema.js';
import { heroNames, nameHeroes } from './toolkit.js';
import { didWellOf, mainlineOf, sightClaims, statedFacts, str, verifyReview } from './verify.js';

const CLOCK_RE = /(?<!\d)-?\d{1,3}:[0-5]\d(?!\d)/g;
const clocksIn = (v) => {
  const out = new Set();
  const walk = (x) => {
    if (typeof x === 'string') { for (const m of x.match(CLOCK_RE) ?? []) out.add(m); return; }
    if (Array.isArray(x)) { for (const item of x) walk(item); return; }
    if (x && typeof x === 'object') for (const val of Object.values(x)) walk(val);
  };
  walk(v);
  return out;
};
const hasSightClaim = (v) => {
  if (typeof v === 'string') return sightClaims(v).length > 0;
  if (Array.isArray(v)) return v.some(hasSightClaim);
  if (v && typeof v === 'object') return Object.values(v).some(hasSightClaim);
  return false;
};
/** Every clock time and number stated in a translated fact field must match one in the verified source field. */
function factsMatchSource(baseText, trText) {
  const base = statedFacts(baseText);
  const cand = statedFacts(trText);
  const baseTimes = new Set(base.times);
  for (const t of cand.times) if (!baseTimes.has(t)) return false;
  for (const n of cand.numbers) {
    const ok = base.numbers.some((b) => Math.abs(n.value - b.value) <= 1e-6 && Boolean(n.percent) === Boolean(b.percent));
    if (!ok) return false;
  }
  return true;
}

const LANG_LABEL = {
  en: 'English',
  zh: 'Simplified Chinese (简体中文)',
  ru: 'Russian (русский язык)',
};

const listOf = (v) => (Array.isArray(v) ? v : []);

/** Extract only the translatable prose fields of a verified review. */
export function extractTranslatable(review) {
  if (!review || typeof review !== 'object') return { verdict: '', mainline: [], findings: [], did_well: [], blind_spots: [] };
  const highlights = listOf(review.highlights).filter((h) => h && typeof h === 'object');
  const chapters = listOf(review.chapters).filter((c) => c && typeof c === 'object');
  const story = listOf(review.story).filter((l) => l && typeof l === 'object');
  const findings = listOf(review.findings).filter((f) => f && typeof f === 'object');
  const hasHighlights = highlights.length > 0;
  const out = {
    verdict: typeof review.verdict === 'string' ? review.verdict : '',
    ...(typeof review.opening_note === 'string' && review.opening_note.trim() ? { opening_note: review.opening_note } : {}),
    ...(hasHighlights
      ? {
        highlights: highlights.map((h) => ({
          title: typeof h.title === 'string' ? h.title : '',
          detail: typeof h.detail === 'string' ? h.detail : '',
          ...(Array.isArray(h.evidence) && h.evidence.length ? { evidence: h.evidence.map((e) => (typeof e?.fact === 'string' ? e.fact : '')) } : {}),
        })),
      }
      : {}),
    ...(chapters.length
      ? {
        chapters: chapters.map((c) => ({
          title: typeof c.title === 'string' ? c.title : '',
          analysis: typeof c.analysis === 'string' ? c.analysis : '',
          ...(typeof c.takeaway === 'string' && c.takeaway.trim() ? { takeaway: c.takeaway } : {}),
          evidence: listOf(c.evidence).map((e) => (typeof e?.fact === 'string' ? e.fact : '')),
        })),
      }
      : {}),
    // With a story, the one-line phases are read off its translation (mainlineOf): they are not sent twice.
    ...(story.length
      ? { story: story.map((l) => ({ phase: typeof l.phase === 'string' ? l.phase : '', what_changed: typeof l.what_changed === 'string' ? l.what_changed : '', because: typeof l.because === 'string' ? l.because : '', evidence: listOf(l.evidence).map((e) => (typeof e?.fact === 'string' ? e.fact : '')) })) }
      : { mainline: listOf(review.mainline) }),
    findings: findings.map((f) => ({
      title: typeof f.title === 'string' ? f.title : '',
      claim: typeof f.claim === 'string' ? f.claim : '',
      evidence: listOf(f.evidence).map((e) => (typeof e?.fact === 'string' ? e.fact : '')),
      ...(f.rule && typeof f.rule === 'object' ? {
        rule: {
          when: f.rule.when,
          do: f.rule.do,
          ...(f.rule.this_game ? { this_game: f.rule.this_game } : {}),
        },
      } : {}),
      fix: typeof f.fix === 'string' ? f.fix : '',
    })),
    ...(hasHighlights ? {} : { did_well: listOf(review.did_well) }),
    ...(typeof review.encouragement === 'string' && review.encouragement.trim() ? { encouragement: review.encouragement } : {}),
    blind_spots: listOf(review.blind_spots),
  };
  if (review.game_plan && typeof review.game_plan === 'object' && !Array.isArray(review.game_plan)) {
    const gp = {};
    for (const k of PLAN_TEXTS) if (typeof review.game_plan[k] === 'string') gp[k] = review.game_plan[k];
    gp.evidence = listOf(review.game_plan.evidence).map((e) => (typeof e?.fact === 'string' ? e.fact : ''));
    out.game_plan = gp;
  }
  return out;
}

/**
 * Merge translated prose onto the base review's structural fields. Returns null if malformed.
 * @param {any} baseReview
 * @param {any} tr
 * @param {string} targetLang
 * @param {{ heroes?: Record<string, string>, places?: Record<string, string>, sources?: any[] | null }} [opts]
 */
export function applyTranslation(baseReview, tr, targetLang, { heroes = {}, places = {}, sources = null } = {}) {
  if (!baseReview || typeof baseReview !== 'object' || Array.isArray(baseReview)) return null;
  if (!tr || typeof tr !== 'object' || Array.isArray(tr)) return null;
  const lang = normalizeUiLang(targetLang);
  const verdict = str(tr.verdict);
  if (str(baseReview.verdict) && !verdict) return null;

  const opening_note = str(baseReview.opening_note) ? str(tr.opening_note) : null;
  if (str(baseReview.opening_note) && !opening_note) return null;
  const encouragement = str(baseReview.encouragement) ? str(tr.encouragement) : null;
  if (str(baseReview.encouragement) && !encouragement) return null;

  const strList = (base, cand) => {
    const b = Array.isArray(base) ? base : [];
    if (b.length === 0) return [];
    if (!Array.isArray(cand) || cand.length !== b.length) return null;
    const out = [];
    for (const item of cand) {
      const s = str(item);
      if (!s) return null;
      out.push(s);
    }
    return out;
  };

  // Highlights: preserve structural evidence refs/clocks, rebuild did_well from translated highlights.
  const baseHighlights = listOf(baseReview.highlights).filter((h) => h && typeof h === 'object');
  let highlights = null;
  if (baseHighlights.length) {
    if (!Array.isArray(tr.highlights) || tr.highlights.length !== baseHighlights.length) return null;
    highlights = [];
    for (let i = 0; i < baseHighlights.length; i += 1) {
      const b = baseHighlights[i]; const c = tr.highlights[i];
      if (!c || typeof c !== 'object') return null;
      const title = str(c.title); const detail = str(c.detail);
      if (!title || !detail) return null;
      const bEv = listOf(b.evidence);
      let evidence;
      if (bEv.length) {
        const facts = strList(bEv.map((e) => e?.fact), c.evidence);
        if (!facts) return null;
        evidence = bEv.map((e, j) => ({ ...e, fact: facts[j] }));
      }
      highlights.push({ ...b, title, detail, ...(evidence ? { evidence } : {}) });
    }
  }

  // Chapters: preserve topic, assessment, and structural evidence refs/clocks.
  const baseChapters = listOf(baseReview.chapters).filter((c) => c && typeof c === 'object');
  let chapters = null;
  if (baseChapters.length) {
    if (!Array.isArray(tr.chapters) || tr.chapters.length !== baseChapters.length) return null;
    chapters = [];
    for (let i = 0; i < baseChapters.length; i += 1) {
      const b = baseChapters[i]; const c = tr.chapters[i];
      if (!c || typeof c !== 'object') return null;
      const title = str(c.title); const analysis = str(c.analysis);
      if (!title || !analysis) return null;
      const takeaway = str(b.takeaway) ? str(c.takeaway) : null;
      if (str(b.takeaway) && !takeaway) return null;
      const bEv = listOf(b.evidence);
      const facts = strList(bEv.map((e) => e?.fact), c.evidence);
      if (!facts) return null;
      chapters.push({
        ...b,
        title,
        analysis,
        ...(takeaway ? { takeaway } : {}),
        evidence: bEv.map((e, j) => ({ ...e, fact: facts[j] })),
      });
    }
  }

  // The story (#437 P4): every link's sentences and evidence facts, the same shape as the base.
  const baseStory = listOf(baseReview.story).filter((l) => l && typeof l === 'object');
  let story = null;
  if (baseStory.length) {
    if (!Array.isArray(tr.story) || tr.story.length !== baseStory.length) return null;
    story = [];
    for (let i = 0; i < baseStory.length; i += 1) {
      const b = baseStory[i]; const c = tr.story[i];
      if (!c || typeof c !== 'object') return null;
      const phase = str(c.phase); const what = str(c.what_changed); const because = str(c.because);
      if (!phase || !what || !because) return null;
      const bEv = listOf(b.evidence);
      const facts = strList(bEv.map((e) => e?.fact), c.evidence);
      if (!facts) return null;
      story.push({ ...b, phase, what_changed: what, because, evidence: bEv.map((e, j) => ({ ...e, fact: facts[j] })) });
    }
  }
  const mainline = story ? mainlineOf(story, lang) : strList(baseReview.mainline, tr.mainline);
  const did_well = highlights ? didWellOf(highlights) : strList(baseReview.did_well, tr.did_well);
  const blind_spots = strList(baseReview.blind_spots, tr.blind_spots);
  if (!mainline || !did_well || !blind_spots) return null;

  const baseFindings = listOf(baseReview.findings).filter((f) => f && typeof f === 'object');
  if (!Array.isArray(tr.findings) || tr.findings.length !== baseFindings.length) return null;
  const findings = [];
  for (let i = 0; i < baseFindings.length; i += 1) {
    const bf = baseFindings[i];
    const tf = tr.findings[i];
    if (!tf || typeof tf !== 'object') return null;
    const title = str(tf.title);
    const claim = str(tf.claim);
    const fix = str(bf.fix) ? str(tf.fix) : '';
    if (!title || !claim || (str(bf.fix) && !fix)) return null;
    const bEv = listOf(bf.evidence);
    const evFacts = strList(bEv.map((e) => e?.fact), tf.evidence);
    if (!evFacts) return null;
    const evidence = bEv.map((e, j) => ({ ...e, fact: evFacts[j] }));
    let rule;
    if (bf.rule && typeof bf.rule === 'object') {
      const when = str(tf.rule?.when);
      const act = str(tf.rule?.do);
      if (!when || !act) return null;
      const seen = bf.rule.this_game ? str(tf.rule?.this_game) : null;
      if (bf.rule.this_game && !seen) return null;
      rule = { ...bf.rule, when, do: act, ...(seen ? { this_game: seen } : {}) };
    }
    findings.push({
      ...bf,
      title,
      claim,
      evidence,
      fix,
      ...(rule ? { rule } : {}),
    });
  }

  let game_plan;
  if (baseReview.game_plan && typeof baseReview.game_plan === 'object' && !Array.isArray(baseReview.game_plan)) {
    const bgp = baseReview.game_plan;
    const tgp = tr.game_plan;
    if (!tgp || typeof tgp !== 'object') return null;
    const bEv = listOf(bgp.evidence);
    const gpEv = strList(bEv.map((e) => e?.fact), tgp.evidence);
    if (!gpEv) return null;
    const nextGp = { ...bgp, evidence: bEv.map((e, j) => ({ ...e, fact: gpEv[j] })) };
    for (const k of PLAN_TEXTS) {
      if (typeof bgp[k] === 'string') {
        const v = str(tgp[k]);
        if (!v) return null;
        nextGp[k] = v;
      }
    }
    game_plan = nextGp;
  }

  const next_game = findings
    .map((f) => (f?.rule?.when && f.rule.do ? `${f.rule.when}${lang === 'zh' ? '：' : ': '}${f.rule.do}` : str(f?.fix)))
    .filter(Boolean);

  // Guard invariants on translated prose:
  // 1. Every verified fact field must preserve only numbers and clocks present in its corresponding verified source field.
  // 2. No field may introduce clock times absent from the verified base review or introduce vision claims.
  const factPairs = [
    [typeof baseReview.verdict === 'string' ? baseReview.verdict : '', verdict ?? ''],
    ...(opening_note ? [[baseReview.opening_note ?? '', opening_note]] : []),
    ...(encouragement ? [[baseReview.encouragement ?? '', encouragement]] : []),
    ...(highlights ? baseHighlights.flatMap((b, i) => [
      [b.title ?? '', highlights[i].title],
      [b.detail ?? '', highlights[i].detail],
      ...listOf(b.evidence).map((e, j) => [e?.fact ?? '', highlights[i].evidence?.[j]?.fact ?? '']),
    ]) : listOf(baseReview.did_well).map((b, i) => [b, did_well[i]])),
    ...(chapters ? baseChapters.flatMap((b, i) => [
      [b.title ?? '', chapters[i].title],
      [b.analysis ?? '', chapters[i].analysis],
      ...(str(b.takeaway) ? [[b.takeaway, chapters[i].takeaway ?? '']] : []),
      ...listOf(b.evidence).map((e, j) => [e?.fact ?? '', chapters[i].evidence?.[j]?.fact ?? '']),
    ]) : []),
    ...(story ? [] : listOf(baseReview.mainline).map((b, i) => [b, mainline[i]])),
    ...(story ? baseStory.flatMap((b, i) => [[b.phase, story[i].phase], [b.what_changed, story[i].what_changed], [b.because, story[i].because], ...listOf(b.evidence).map((e, j) => [e?.fact ?? '', story[i].evidence?.[j]?.fact ?? ''])]) : []),
  ];
  for (let i = 0; i < baseFindings.length; i += 1) {
    const bf = baseFindings[i];
    const tf = findings[i];
    factPairs.push([bf.title ?? '', tf.title], [bf.claim ?? '', tf.claim]);
    const bEv = listOf(bf.evidence);
    for (let j = 0; j < bEv.length; j += 1) factPairs.push([bEv[j]?.fact ?? '', tf.evidence[j]?.fact ?? '']);
    if (bf.rule?.this_game) factPairs.push([bf.rule.this_game, tf.rule?.this_game ?? '']);
  }
  if (baseReview.game_plan && typeof baseReview.game_plan === 'object' && game_plan) {
    for (const k of PLAN_TEXTS) if (typeof baseReview.game_plan[k] === 'string') factPairs.push([baseReview.game_plan[k], game_plan[k]]);
    const bEv = listOf(baseReview.game_plan.evidence);
    for (let j = 0; j < bEv.length; j += 1) factPairs.push([bEv[j]?.fact ?? '', game_plan.evidence[j]?.fact ?? '']);
  }
  for (const [b, c] of factPairs) if (!factsMatchSource(b, c)) return null;

  const allowedClocks = clocksIn(extractTranslatable(baseReview));
  const candidateProse = {
    verdict,
    ...(opening_note ? { opening_note } : {}),
    ...(highlights ? { highlights: highlights.map((h) => ({ title: h.title, detail: h.detail, ...(h.evidence ? { evidence: h.evidence.map((e) => e.fact) } : {}) })) } : {}),
    ...(chapters ? { chapters: chapters.map((c) => ({ title: c.title, analysis: c.analysis, ...(c.takeaway ? { takeaway: c.takeaway } : {}), evidence: c.evidence.map((e) => e.fact) })) } : {}),
    mainline,
    ...(story ? { story: story.map((l) => ({ phase: l.phase, what_changed: l.what_changed, because: l.because, evidence: l.evidence.map((e) => e.fact) })) } : {}),
    did_well,
    ...(encouragement ? { encouragement } : {}),
    blind_spots,
    findings: findings.map((f) => ({ title: f.title, claim: f.claim, evidence: f.evidence.map((e) => e.fact), fix: f.fix, ...(f.rule ? { rule: { when: f.rule.when, do: f.rule.do, ...(f.rule.this_game ? { this_game: f.rule.this_game } : {}) } } : {}) })),
    ...(game_plan ? { game_plan: { ...Object.fromEntries(PLAN_TEXTS.filter((k) => typeof game_plan[k] === 'string').map((k) => [k, game_plan[k]])), evidence: (game_plan.evidence ?? []).map((e) => e.fact) } } : {}),
  };
  for (const c of clocksIn(candidateProse)) if (!allowedClocks.has(c)) return null;
  if (hasSightClaim(candidateProse)) return null;

  const built = nameHeroes({
    ...baseReview,
    lang,
    verdict: verdict ?? '',
    ...(opening_note ? { opening_note } : {}),
    ...(highlights ? { highlights } : {}),
    ...(chapters ? { chapters } : {}),
    ...(story ? { story } : {}),
    mainline,
    findings,
    did_well,
    next_game,
    ...(encouragement ? { encouragement } : {}),
    blind_spots,
    ...(game_plan ? { game_plan } : {}),
  }, heroes, places);

  // When the run's tool sources are provided, verify the translated review with the same hard checks as the primary review.
  if (sources) {
    const check = verifyReview(built, sources);
    if (check.problems.some((p) => !p.soft)) return null;
  }

  return built;
}

/** Parse a JSON object from model text, tolerating code fences and minor JSON glitches. */
export function parseTranslationJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    try {
      const parsed = JSON.parse(jsonrepair(slice));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

export const TRANSLATE_SYSTEM = [
  'You are a precise Dota 2 coaching translator.',
  'Translate the provided verified match review JSON into each requested target language.',
  'STRICT RULES:',
  '1. Preserve the EXACT JSON structure, array lengths, and key names for every language.',
  '2. Keep EVERY game clock time (e.g. 27:27, 30:26, -0:30) and EVERY number (counts, gold, damage, seconds, percentages) EXACTLY identical — never round, drop, or alter any number. Use a dot "." for decimals (e.g. 3.4), never a comma.',
  '3. Use the provided hero_names and place_names for each target language. For Russian, keep standard English Dota 2 hero/item/ability names (e.g. Phantom Assassin, Black King Bar, Blink Dagger) and write natural Russian coaching prose.',
  '4. Keep the direct, evidence-based coaching tone ("you" / "你" / "ты"). Never add new facts, tool names, or record IDs.',
  '5. Output ONLY one valid JSON object whose top-level keys are the requested language codes. No markdown fences or extra text.',
].join('\n');

/**
 * Translate a verified review into all remaining site languages.
 * Never throws: if translation fails for any language, that language is simply omitted.
 *
 * @param {{ complete: Function, review: any, sourceLang: string, targetLangs?: string[], trace?: any, signal?: AbortSignal, onEvent?: (e: object) => void }} o
 * @returns {Promise<{ reviews: Record<string, any>, usage: { input: number, output: number } }>}
 */
export async function translateReview({ complete, review, sourceLang, targetLangs, trace = null, sources = null, signal, onEvent }) {
  const src = normalizeUiLang(sourceLang);
  const targets = [...new Set((targetLangs ?? SUPPORTED_LANGS.filter((l) => l !== src)).map(normalizeUiLang).filter((l) => l !== src))];
  const usage = { input: 0, output: 0 };
  const reviews = {};
  if (!complete || !review || !targets.length) return { reviews, usage };

  const payload = extractTranslatable(review);
  const namesByLang = Object.fromEntries(targets.map((l) => [l, {
    heroes: trace ? heroNames(trace, l) : {},
    places: placeNames(l),
  }]));

  const runOnce = async (langs) => {
    onEvent?.({ type: 'translating', langs });
    const req = {
      source_language: `${src} (${LANG_LABEL[src]})`,
      target_languages: Object.fromEntries(langs.map((l) => [l, LANG_LABEL[l]])),
      hero_names: Object.fromEntries(langs.map((l) => [l, namesByLang[l].heroes])),
      place_names: Object.fromEntries(langs.map((l) => [l, namesByLang[l].places])),
      review: payload,
    };
    const res = await complete({
      system: TRANSLATE_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(req) }],
      tools: [],
      signal,
    });
    usage.input += Number(res?.usage?.input ?? 0);
    usage.output += Number(res?.usage?.output ?? 0);
    const raw = typeof res?.text === 'string' ? res.text : '';
    const parsed = parseTranslationJson(raw);
    if (parsed) {
      for (const l of langs) {
        if (reviews[l]) continue;
        const built = applyTranslation(review, parsed[l], l, { ...namesByLang[l], sources });
        if (built) reviews[l] = built;
      }
    }
    return raw.trim().length > 0;
  };

  try {
    const hadText = await runOnce(targets);
    const missing = targets.filter((l) => !reviews[l]);
    // Retry once only if the model actually answered with text (not a stub returning empty/toolCalls) and not aborted.
    if (hadText && missing.length > 0 && !signal?.aborted) {
      await runOnce(missing);
    }
  } catch {
    // Translation is best-effort after the verified primary review: never discard the verified primary review.
  }

  return { reviews, usage };
}
