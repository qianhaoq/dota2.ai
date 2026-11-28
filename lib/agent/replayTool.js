/**
 * MCP `replay_review`: the deep replay review (lib/agent) for an agent, one call at a time. A first review takes
 * a few minutes (fetch the replay, parse it, the coach goes through it), longer than an agent's tool call should
 * block. So a call never waits: it starts what is missing and says where things stand, and the agent calls
 * again after `poll_after_sec` until `status` is `ready`.
 *
 *   pick_hero         no hero, or one not in this game: ask the user which they played (`heroes` when known)
 *   parsing           the replay is being fetched and read
 *   reviewing         the coach is going through it (`steps`: lookups so far)
 *   ready             the review: verdict, findings with their replay evidence, what to do next game, the page
 *   failed            the coach could not finish a review it could back; started again only with `retry: true`
 *                     (a poll must not spend the caller's review slots on the same failure, over and over)
 *   replay_unavailable / unavailable    nothing to review here, and why
 *
 * Starts count against the same per-caller and global limits as the web page's (lib/agent/router.js
 * forRequest); a refusal is an error that says when to come back. Pure apart from `api`.
 */
import { heroByKey } from '../../packages/review-engine/src/staticHeroes.js';
import { normalizeUiLang } from '../aiLanguage.js';

export const POLL_AFTER_SEC = 20;
const SITE = 'https://dota2.ai';

export class ReplayToolError extends Error {
  /** @param {'INVALID_INPUT' | 'RATE_LIMITED'} code */
  constructor(code, message) { super(message); this.code = code; }
}

const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s'-]+/g, '_');

/** The hero of `heroes` (availability's list) that `input` names: its key, English or Chinese name, or hero id. */
export function resolveHero(heroes, input) {
  if (input == null || input === '') return null;
  const raw = String(input).trim();
  const n = norm(raw);
  const id = /^\d{1,4}$/.test(raw) ? Number(raw) : heroByKey(n)?.id ?? null;
  return heroes.find((h) => h.hero === n || norm(h.en) === n || h.zh === raw || (id != null && h.hero_id === id)) ?? null;
}

const roster = (heroes) => heroes.map((h) => ({ hero: h.hero, team: h.team, en: h.en, zh: h.zh }));

/** The stored review, as an agent should quote it: every clock and number in it was checked against the replay. */
export function shapeReview(matchId, hero, lang, state) {
  const r = state?.review && typeof state.review === 'object' ? state.review : {};
  const list = (v) => (Array.isArray(v) ? v : []);
  const mapEv = (ev) => list(ev).filter((e) => e && typeof e === 'object').map((e) => ({ clock: e.clock ?? null, fact: e.fact }));
  const highlights = list(r.highlights).filter((h) => h && typeof h === 'object');
  const chapters = list(r.chapters).filter((c) => c && typeof c === 'object');
  // The language is always in the link: reviews are kept per language, and without it the page opens in the
  // reader's own last choice and asks for a review that may not exist.
  const url = `${SITE}/r/${matchId}?hero=${encodeURIComponent(hero)}&lang=${lang}`;
  return {
    status: 'ready',
    match_id: String(matchId), hero, lang, url,
    verdict: typeof r.verdict === 'string' ? r.verdict : null,
    ...(typeof r.opening_note === 'string' && r.opening_note.trim() ? { opening_note: r.opening_note } : {}),
    ...(highlights.length ? {
      highlights: highlights.map((h) => {
        const evidence = mapEv(h.evidence);
        return {
          title: h.title, detail: h.detail,
          ...(evidence.length ? { evidence } : {}),
        };
      }),
    } : {}),
    ...(chapters.length ? {
      chapters: chapters.map((c) => ({
        topic: c.topic, title: c.title, assessment: c.assessment, analysis: c.analysis,
        ...(typeof c.takeaway === 'string' && c.takeaway.trim() ? { takeaway: c.takeaway } : {}),
        evidence: mapEv(c.evidence),
      })),
    } : {}),
    mainline: list(r.mainline),
    findings: list(r.findings).filter((f) => f && typeof f === 'object').map((f) => ({
      title: f.title, claim: f.claim, fix: f.fix ?? null,
      evidence: mapEv(f.evidence),
      ...(f.rule && typeof f.rule === 'object' ? { rule: { when: f.rule.when, do: f.rule.do } } : {}),
    })),
    did_well: list(r.did_well),
    next_game: list(r.next_game),
    ...(typeof r.encouragement === 'string' && r.encouragement.trim() ? { encouragement: r.encouragement } : {}),
    blind_spots: list(r.blind_spots),
    ...(typeof state?.model === 'string' && state.model ? { model: state.model } : {}),
    ...(Number.isInteger(state?.steps) ? { steps: state.steps } : {}),
    ...(Number.isInteger(state?.tool_calls) ? { tool_calls: state.tool_calls } : {}),
    ...(Number.isInteger(state?.repair_rounds) ? { repair_rounds: state.repair_rounds } : {}),
    ...(Number.isInteger(state?.truncation_retries) ? { truncation_retries: state.truncation_retries } : {}),
    ...(state?.usage && typeof state.usage === 'object' ? { usage: state.usage } : {}),
    ...('usage_source' in (state ?? {}) ? { usage_source: state.usage_source } : state?.usage && 'source' in state.usage ? { usage_source: state.usage.source } : {}),
    checked: { against: 'replay records', removed_for_lack_of_evidence: state.verification?.dropped ?? 0 },
    ...(state?.stale_version ? {
      cached: true,
      stale_version: true,
      ...(Number.isInteger(state.prompt_version) ? { prompt_version: state.prompt_version } : {}),
      ...(Number.isInteger(state.latest_prompt_version) ? { latest_prompt_version: state.latest_prompt_version } : {}),
      ...(state.refresh_failed && typeof state.refresh_failed === 'object' ? { refresh_failed: { reason: state.refresh_failed.reason ?? null } } : {}),
    } : {}),
    note: state?.stale_version && state.refresh_failed && typeof state.refresh_failed === 'object'
      ? `Times and numbers were checked against the replay. Present in a warm, constructive coach tone (verdict + opening_note, concrete highlights, key chapters/findings, encouragement) with zero mechanical next-game KPI quotas. Quote times and numbers as given, say what the review cannot see (blind_spots), and link the url: it has every piece of evidence and a coach to ask. Updating this cached${Number.isInteger(state.prompt_version) ? ` v${state.prompt_version}` : ''} review${Number.isInteger(state.latest_prompt_version) ? ` to v${state.latest_prompt_version}` : ''} failed${state.refresh_failed.reason ? ` (${state.refresh_failed.reason})` : ''}; returning the saved review instead. Call replay_review with refresh: true and retry: true only if the user explicitly wants to retry regenerating it (this counts as a new start).`
      : state?.stale_version && Number.isInteger(state.prompt_version)
        ? `Times and numbers were checked against the replay. Present in a warm, constructive coach tone (verdict + opening_note, concrete highlights, key chapters/findings, encouragement) with zero mechanical next-game KPI quotas. Quote times and numbers as given, say what the review cannot see (blind_spots), and link the url: it has every piece of evidence and a coach to ask. This cached review was written under coach v${state.prompt_version}${Number.isInteger(state.latest_prompt_version) ? ` (latest is v${state.latest_prompt_version})` : ''}; call replay_review with refresh: true only if the user explicitly wants to regenerate it.`
        : 'Times and numbers were checked against the replay. Present in a warm, constructive coach tone (verdict + opening_note, concrete highlights, key chapters/findings, encouragement) with zero mechanical next-game KPI quotas. Quote times and numbers as given, say what the review cannot see (blind_spots), and link the url: it has every piece of evidence and a coach to ask.',
  };
}

// Where the same review runs on the reader's own model, with no wait on this site's budget.
const OWN_MODEL = 'To review now on your own model instead, install the dota2.ai plugin for DeepSeek Harness (DSH): https://dota2.ai/#ways-dsh';
const refusal = (r) => {
  const after = r.body?.retryAfterSec ?? 60;
  return new ReplayToolError('RATE_LIMITED', r.status === 429
    ? `Too many reviews started by this caller; try again in ${after} s. ${OWN_MODEL}`
    : r.body?.code === 'daily_cap'
      ? `Today's reviews on dota2.ai's own model are used up; they come back in ${after} s. ${OWN_MODEL}`
      : `The coach is at capacity; try again in ${after} s. ${OWN_MODEL}`);
};

/**
 * @param {{ read: Function, validMatch: Function, availability: Function, status: Function, prepare: Function, start: Function }} api
 *   lib/agent/router.js forRequest(req)
 * @param {{ match_id: string | number, hero?: string | number, lang?: 'en' | 'zh', retry?: boolean, refresh?: boolean }} args
 */
export async function replayReview(api, args) {
  const matchId = String(args?.match_id ?? '').trim();
  if (!api.validMatch(matchId)) throw new ReplayToolError('INVALID_INPUT', 'match_id must be a Dota 2 match ID (digits).');
  const lang = normalizeUiLang(args?.lang);
  const g = api.read();
  if (!g.ok) throw new ReplayToolError('RATE_LIMITED', `Too many requests; try again in ${g.retryAfterSec} s.`);
  const avail = await api.availability(matchId);

  if (!avail.trace) {
    if (!avail.can_parse) return { status: 'unavailable', reason: 'replay_parsing_off', message: 'This server cannot fetch replays, so it cannot review this game.' };
    const p = avail.parse ?? { status: 'none' };
    if (p.status === 'failed' && p.final) return replayGone(p.reason);
    // A non-final parse failure (e.g. Steam GC rate-limited / replay URL not yet available) must not loop as
    // `parsing` on every poll: report it honestly and retry only when the caller asks (`retry: true`).
    if (p.status === 'failed' && args?.retry !== true) return parseFailed(matchId, p);
    // A hero is needed for the review, not for the parse: start the parse now either way, and ask while it runs.
    if (p.status !== 'running') {
      const r = await api.prepare(matchId);
      if (r.status === 429 || (r.status === 503 && r.body?.retryAfterSec)) throw refusal(r);
      if (r.body?.status === 'failed' && r.body.final) return replayGone(r.body.reason);
      if (r.body?.status === 'failed') return parseFailed(matchId, r.body);
      if (r.body?.status === 'unavailable') return { status: 'unavailable', reason: 'replay_parsing_off', message: 'This server cannot fetch replays, so it cannot review this game.' };
    }
    return {
      status: 'parsing', match_id: matchId,
      message: 'Fetching and reading the replay (a minute or two). Call replay_review again with the same arguments.',
      ...(args?.hero == null || args.hero === '' ? { ask_user: 'Which hero did the user play in this game? (coach_report without hero lists the roster.)' } : {}),
      poll_after_sec: POLL_AFTER_SEC,
    };
  }

  const hero = resolveHero(avail.heroes, args?.hero);
  if (!hero) {
    return {
      status: 'pick_hero', match_id: matchId,
      message: args?.hero == null || args.hero === '' ? 'The review is written for one player: ask the user which hero they played.' : `"${String(args.hero).slice(0, 40)}" is not in this game: ask the user which hero they played.`,
      heroes: roster(avail.heroes),
    };
  }
  let state = await api.status(matchId, hero.hero, lang);
  // "none" can also be a failure the page no longer calls one (a minute on), or one another instance ran:
  // only a retry the agent asked for starts it again.
  if (state.status === 'none' && args?.retry !== true && api.lastFailure) {
    const f = await api.lastFailure(matchId, hero.hero, lang);
    if (f) state = { status: 'failed', reason: f.reason };
  }
  if (state.status === 'failed' && args?.retry !== true) {
    return {
      status: 'failed', match_id: matchId, hero: hero.hero, lang, reason: state.reason ?? null,
      message: 'The coach could not finish a review it could back with the replay. It often works on a second try: call replay_review again with retry: true (this counts as a new start).',
    };
  }
  // If an earlier refresh attempt failed (in-memory, recent marker, or older shared marker), a poll with
  // `refresh: true` must NOT silently spend another start; require explicit `retry: true` just like `failed`.
  let refreshFailure = state.status === 'ready' && state.stale_version === true ? (state.refresh_failed ?? null) : null;
  if (!refreshFailure && args?.refresh === true && state.status === 'ready' && state.stale_version === true && args?.retry !== true && api.lastFailure) {
    const f = await api.lastFailure(matchId, hero.hero, lang);
    if (f) refreshFailure = { reason: f.reason ?? null };
  }
  const wantsRefresh = args?.refresh === true && state.status === 'ready' && state.stale_version === true && (!refreshFailure || args?.retry === true);
  if (state.status === 'none' || state.status === 'failed' || wantsRefresh) {
    if (!avail.model_configured) {
      if (wantsRefresh) return shapeReview(matchId, hero.hero, lang, { ...state, refresh_failed: { reason: 'model_not_configured' } });
      return { status: 'unavailable', reason: 'model_not_configured', message: 'The coach is not available on this server right now.' };
    }
    const prevReady = wantsRefresh ? state : null;
    const r = wantsRefresh ? await api.start(matchId, hero.hero, lang, { refresh: true }) : await api.start(matchId, hero.hero, lang);
    if (r.status === 429 || (r.status === 503 && r.body?.retryAfterSec)) throw refusal(r);
    if (r.status === 503) {
      if (prevReady) return shapeReview(matchId, hero.hero, lang, { ...prevReady, refresh_failed: { reason: r.body?.reason ?? 'model_not_configured' } });
      return { status: 'unavailable', reason: r.body?.reason ?? 'model_not_configured', message: 'The coach is not available on this server right now.' };
    }
    if (prevReady && (r.body?.status === 'failed' || r.body?.status === 'unavailable')) {
      return shapeReview(matchId, hero.hero, lang, { ...prevReady, refresh_failed: { reason: r.body.reason ?? null } });
    }
    state = r.body;
    refreshFailure = null;
  }
  if (state.status === 'ready') return shapeReview(matchId, hero.hero, lang, refreshFailure ? { ...state, refresh_failed: refreshFailure } : state);
  return {
    status: 'reviewing', match_id: matchId, hero: hero.hero, lang,
    steps: Array.isArray(state.steps) ? state.steps.length : 0,
    message: args?.retry === true
      ? 'The coach is going through the replay (two to three minutes in all). Call replay_review again without retry: true to check progress.'
      : 'The coach is going through the replay (two to three minutes in all). Call replay_review again with the same arguments.',
    poll_after_sec: POLL_AFTER_SEC,
  };
}

function parseFailed(matchId, p) {
  const reason = p?.reason ?? 'parse_failed';
  const retryIn = Number.isFinite(p?.retry_in_sec) && p.retry_in_sec > 0 ? Math.ceil(p.retry_in_sec) : null;
  const waitHint = retryIn != null
    ? ` Wait about ${retryIn} s and call replay_review again with retry: true.`
    : ' Call replay_review again with retry: true to try fetching the replay again.';
  return {
    status: 'failed',
    stage: 'parse',
    match_id: matchId,
    reason,
    ...(retryIn != null ? { retry_in_sec: retryIn } : {}),
    message: `Could not fetch or parse the replay right now (${reason}).${waitHint} coach_report still has the scoreboard-level review.`,
  };
}

function replayGone(reason) {
  return reason === 'replay_gone'
    ? { status: 'replay_unavailable', reason, message: 'Valve keeps replays for about two weeks; this one is gone, so there is nothing to review honestly. coach_report still has the scoreboard-level review.' }
    : { status: 'replay_unavailable', reason: reason ?? 'parse_failed', message: 'The replay could not be fetched or read. coach_report still has the scoreboard-level review.' };
}
