/**
 * What a reader says about one finding of a review: right, wrong or not useful — and, for the last two, which
 * of a few fixed reasons.
 *
 * It is the only word we get on whether a review was right. The eval scores a review against a rubric somebody
 * wrote for a dozen games; this is every reader, on their own game.
 *
 * What is kept, and what is not:
 * - the game, the hero, the language, the prompt version and model the review was written by;
 * - which finding: its place, its title and the records it cites, copied from the stored review — so the word
 *   still means something after that review is written again;
 * - the rating and the reason, both from fixed lists. No free text: a label can be counted, and nothing a
 *   person typed is stored. No address, no account, no browser id;
 * - one record per reader per finding: the page makes up an id for it, and a change of mind sent with the same
 *   id takes the earlier record's place.
 *
 * Pure: the caller gives the stored review and the time.
 */
import { MAX_FINDINGS } from './review/schema.js';

export const FEEDBACK_SCHEMA = 'dota2.ai/finding-feedback@1';
export const RATINGS = ['right', 'wrong', 'useless'];
/**
 * Why, for a rating that is not "right".
 * wrong — fact: a fact in it is wrong; judgment: the facts are right, the conclusion is not; not_mine: it was not the player's to change.
 * useless — knew: the player knew it already; vague: nothing to act on; minor: not what decided the game.
 */
export const REASONS = { wrong: ['fact', 'judgment', 'not_mine'], useless: ['knew', 'vague', 'minor'] };
/** A finding's title as the page sends it back: longer than any the schema allows, shorter than a paste. */
const TITLE_MAX = 300;
const ID = /^[a-z0-9]{10,24}$/;
/** The records one finding cites, kept with the word on it. */
const REFS_MAX = 24;

/**
 * The part of a request body that is the feedback itself (the route reads hero, lang, plan and model).
 * @returns {{ finding: number, title: string, rating: 'right' | 'wrong' | 'useless', reason: string | null, id: string } | null}
 *   null for anything else: an unknown rating, a reason that does not belong to the rating, a reason for "right".
 */
export function parseFeedback(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!Number.isInteger(b.finding) || b.finding < 0 || b.finding >= MAX_FINDINGS) return null;
  if (typeof b.title !== 'string' || !b.title || b.title.length > TITLE_MAX) return null;
  if (!RATINGS.includes(b.rating)) return null;
  const reason = b.reason == null || b.reason === '' ? null : b.reason;
  if (reason !== null && !(REASONS[b.rating] ?? []).includes(reason)) return null;
  if (typeof b.id !== 'string' || !ID.test(b.id)) return null;
  return { finding: b.finding, title: b.title, rating: b.rating, reason, id: b.id };
}

/**
 * The record to store, read against the review it is about.
 * @param {{ matchId: string | number, hero: string, lang: string, plan?: string | null, model?: string | null, promptVersion: number, review: any, value: NonNullable<ReturnType<typeof parseFeedback>>, at: number }} o
 * @returns {{ error: 'no_such_finding' | 'stale' } | { schema: string, at: string, match_id: number, hero: string, lang: string, prompt_version: number, plan: string | null, model: string | null, finding: { index: number, of: number, title: string, refs: string[] }, rating: string, reason: string | null }}
 *   stale: the finding in that place is not the one the reader saw (the review was written again since).
 */
export function feedbackRecord({ matchId, hero, lang, plan = null, model = null, promptVersion, review, value, at }) {
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  const f = findings[value.finding];
  if (!f) return { error: 'no_such_finding' };
  if (f.title !== value.title) return { error: 'stale' };
  const refs = [...new Set((Array.isArray(f.evidence) ? f.evidence : []).flatMap((e) => (Array.isArray(e?.refs) ? e.refs : [])).filter((r) => typeof r === 'string'))].slice(0, REFS_MAX);
  return {
    schema: FEEDBACK_SCHEMA, at: new Date(at).toISOString(), match_id: Number(matchId), hero, lang, prompt_version: promptVersion, plan, model,
    finding: { index: value.finding, of: findings.length, title: f.title, refs },
    rating: value.rating, reason: value.reason,
  };
}

/** Where one reader's word on one finding is kept, under the review's own key: the same id again takes its place. */
export const feedbackKey = (reviewKey, value) => `${reviewKey}.f${value.finding}.${value.id}`;

const tally = () => ({ n: 0, right: 0, wrong: 0, useless: 0, right_rate: null, reasons: {} });
const add = (t, r) => { t.n += 1; t[r.rating] += 1; if (r.reason) t.reasons[r.reason] = (t.reasons[r.reason] ?? 0) + 1; t.right_rate = Math.round((t.right / t.n) * 100) / 100; };

/**
 * Stored records, counted: overall, by prompt version, and for the first finding alone (the one the page leads
 * with). Records of another schema, or with a rating this file does not know, are counted as skipped — never
 * as a rating. A rate is null where nothing was said.
 * @param {any[]} records
 */
export function summarizeFeedback(records) {
  const all = tally(); const first = tally(); const byVersion = new Map(); const notRight = []; let skipped = 0;
  for (const r of Array.isArray(records) ? records : []) {
    if (r?.schema !== FEEDBACK_SCHEMA || !RATINGS.includes(r.rating) || !Number.isInteger(r.finding?.index)) { skipped += 1; continue; }
    add(all, r);
    if (r.finding.index === 0) add(first, r);
    const v = Number.isInteger(r.prompt_version) ? r.prompt_version : null;
    if (!byVersion.has(v)) byVersion.set(v, tally());
    add(byVersion.get(v), r);
    if (r.rating !== 'right') notRight.push({ at: r.at, match_id: r.match_id, hero: r.hero, lang: r.lang, prompt_version: v, model: r.model ?? null, finding: r.finding.index + 1, title: r.finding.title, rating: r.rating, reason: r.reason ?? null });
  }
  return {
    all, first_finding: first, skipped,
    by_prompt_version: [...byVersion].sort((a, b) => (b[0] ?? -1) - (a[0] ?? -1)).map(([prompt_version, t]) => ({ prompt_version, ...t })),
    not_right: notRight.sort((a, b) => String(b.at).localeCompare(String(a.at))),
  };
}
