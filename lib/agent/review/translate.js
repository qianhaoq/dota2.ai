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
import { sightClaims, statedFacts, str, verifyReview } from './verify.js';

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

/** Extract only the translatable prose fields of a verified review. */
export function extractTranslatable(review) {
  const out = {
    verdict: review.verdict ?? '',
    mainline: Array.isArray(review.mainline) ? review.mainline : [],
    findings: (review.findings ?? []).map((f) => ({
      title: f.title ?? '',
      claim: f.claim ?? '',
      evidence: (f.evidence ?? []).map((e) => e.fact ?? ''),
      ...(f.rule ? {
        rule: {
          when: f.rule.when,
          do: f.rule.do,
          ...(f.rule.this_game ? { this_game: f.rule.this_game } : {}),
        },
      } : {}),
      fix: f.fix ?? '',
    })),
    did_well: Array.isArray(review.did_well) ? review.did_well : [],
    blind_spots: Array.isArray(review.blind_spots) ? review.blind_spots : [],
  };
  if (review.game_plan) {
    const gp = {};
    for (const k of PLAN_TEXTS) if (typeof review.game_plan[k] === 'string') gp[k] = review.game_plan[k];
    gp.evidence = (review.game_plan.evidence ?? []).map((e) => e.fact ?? '');
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
  if (!tr || typeof tr !== 'object' || Array.isArray(tr)) return null;
  const lang = normalizeUiLang(targetLang);
  const verdict = str(tr.verdict);
  if (str(baseReview.verdict) && !verdict) return null;

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

  const mainline = strList(baseReview.mainline, tr.mainline);
  const did_well = strList(baseReview.did_well, tr.did_well);
  const blind_spots = strList(baseReview.blind_spots, tr.blind_spots);
  if (!mainline || !did_well || !blind_spots) return null;

  const baseFindings = Array.isArray(baseReview.findings) ? baseReview.findings : [];
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
    const evFacts = strList((bf.evidence ?? []).map((e) => e.fact), tf.evidence);
    if (!evFacts) return null;
    const evidence = (bf.evidence ?? []).map((e, j) => ({ ...e, fact: evFacts[j] }));
    let rule;
    if (bf.rule) {
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
  if (baseReview.game_plan) {
    const bgp = baseReview.game_plan;
    const tgp = tr.game_plan;
    if (!tgp || typeof tgp !== 'object') return null;
    const gpEv = strList((bgp.evidence ?? []).map((e) => e.fact), tgp.evidence);
    if (!gpEv) return null;
    const nextGp = { ...bgp, evidence: (bgp.evidence ?? []).map((e, j) => ({ ...e, fact: gpEv[j] })) };
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
    [baseReview.verdict ?? '', verdict ?? ''],
    ...(baseReview.mainline ?? []).map((b, i) => [b, mainline[i]]),
    ...(baseReview.did_well ?? []).map((b, i) => [b, did_well[i]]),
  ];
  for (let i = 0; i < baseFindings.length; i += 1) {
    const bf = baseFindings[i];
    const tf = findings[i];
    factPairs.push([bf.title ?? '', tf.title], [bf.claim ?? '', tf.claim]);
    for (let j = 0; j < (bf.evidence ?? []).length; j += 1) factPairs.push([bf.evidence[j].fact ?? '', tf.evidence[j].fact]);
    if (bf.rule?.this_game) factPairs.push([bf.rule.this_game, tf.rule?.this_game ?? '']);
  }
  if (baseReview.game_plan && game_plan) {
    for (const k of PLAN_TEXTS) if (typeof baseReview.game_plan[k] === 'string') factPairs.push([baseReview.game_plan[k], game_plan[k]]);
    for (let j = 0; j < (baseReview.game_plan.evidence ?? []).length; j += 1) factPairs.push([baseReview.game_plan.evidence[j].fact ?? '', game_plan.evidence[j].fact]);
  }
  for (const [b, c] of factPairs) if (!factsMatchSource(b, c)) return null;

  const allowedClocks = clocksIn(extractTranslatable(baseReview));
  const candidateProse = { verdict, mainline, did_well, blind_spots, findings: findings.map((f) => ({ title: f.title, claim: f.claim, evidence: f.evidence.map((e) => e.fact), fix: f.fix, ...(f.rule ? { rule: { when: f.rule.when, do: f.rule.do, ...(f.rule.this_game ? { this_game: f.rule.this_game } : {}) } } : {}) })), ...(game_plan ? { game_plan: { ...Object.fromEntries(PLAN_TEXTS.filter((k) => typeof game_plan[k] === 'string').map((k) => [k, game_plan[k]])), evidence: (game_plan.evidence ?? []).map((e) => e.fact) } } : {}) };
  for (const c of clocksIn(candidateProse)) if (!allowedClocks.has(c)) return null;
  if (hasSightClaim(candidateProse)) return null;

  const built = nameHeroes({
    ...baseReview,
    lang,
    verdict: verdict ?? '',
    mainline,
    findings,
    did_well,
    next_game,
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

const TRANSLATE_SYSTEM = [
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
