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
import { heroByInput, heroByKey } from '../../packages/review-engine/src/staticHeroes.js';
import { normalizeMatchId } from '../../packages/review-engine/src/parseMatchId.js';
import { normalizeUiLang } from '../aiLanguage.js';

export const POLL_AFTER_SEC = 20;
const SITE = 'https://dota2.ai';

export class ReplayToolError extends Error {
  /** @param {'INVALID_INPUT' | 'RATE_LIMITED'} code */
  constructor(code, message) { super(message); this.code = code; }
}

const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s'-]+/g, '_');

/**
 * The hero of `heroes` (availability's list) that `input` names: its key, English or Chinese name
 * (both `static-heroes.json` and Valve schinese `names.json`), curated CN/EN nickname (e.g. 小鹿, 骷髅王, 蓝猫, PA, QOP),
 * or numeric hero id.
 */
export function resolveHero(heroes, input) {
  if (input == null || input === '') return null;
  const raw = String(input).trim();
  if (!raw) return null;
  const n = norm(raw);
  const resolved = heroByInput(input) ?? heroByKey(n);
  const id = /^\d{1,4}$/.test(raw) ? Number(raw) : resolved?.id ?? null;
  return heroes.find((h) => h.hero === n || norm(h.en) === n || h.zh === raw || (id != null && h.hero_id === id)) ?? null;
}

const roster = (heroes) => heroes.map((h) => ({ hero: h.hero, team: h.team, en: h.en, zh: h.zh }));

/** The stored review, as an agent should quote it: every clock and number in it was checked against the replay. */
export function shapeReview(matchId, hero, lang, state, { surface = 'remote_mcp', cache_scope } = {}) {
  const r = state?.review && typeof state.review === 'object' ? state.review : {};
  const list = (v) => (Array.isArray(v) ? v : []);
  const mapEv = (ev) => list(ev).filter((e) => e && typeof e === 'object').map((e) => ({ clock: e.clock ?? null, fact: e.fact }));
  const highlights = list(r.highlights).filter((h) => h && typeof h === 'object');
  const chapters = list(r.chapters).filter((c) => c && typeof c === 'object');
  const gp = r.game_plan && typeof r.game_plan === 'object' && !Array.isArray(r.game_plan) ? r.game_plan : null;
  const gpEv = gp ? mapEv(gp.evidence) : [];
  // The language is always in the link: reviews are kept per language, and without it the page opens in the
  // reader's own last choice and asks for a review that may not exist.
  const url = `${SITE}/r/${matchId}?hero=${encodeURIComponent(hero)}&lang=${lang}`;
  const presentationNote = 'Times and numbers were checked against the replay. Present directly and logically without template fluff or mechanical next-game numeric quotas: verdict, up-front highlights (what went well) and findings (what did not), chronological chapters (draft → recommended game plan → laning → midgame → wards & macro → skills & items), game_plan attribution, and blind_spots, then link the url for interactive evidence and follow-up Q&A.';
  return {
    status: 'ready',
    surface,
    cache_scope: cache_scope ?? (surface === 'native_dsh' ? 'dsh_local' : 'web_cloud'),
    match_id: String(matchId), hero, lang, url,
    verdict: typeof r.verdict === 'string' ? r.verdict : null,
    highlights: highlights.map((h) => {
      const evidence = mapEv(h.evidence);
      return {
        title: h.title, detail: h.detail,
        ...(evidence.length ? { evidence } : {}),
      };
    }),
    findings: list(r.findings).filter((f) => f && typeof f === 'object').map((f) => ({
      title: f.title, claim: f.claim, fix: f.fix ?? null,
      evidence: mapEv(f.evidence),
    })),
    chapters: chapters.map((c) => ({
      topic: c.topic, title: c.title, analysis: c.analysis,
      evidence: mapEv(c.evidence),
    })),
    ...(gp ? {
      game_plan: {
        ...(typeof gp.main_reason === 'string' ? { main_reason: gp.main_reason } : {}),
        ...(typeof gp.why === 'string' ? { why: gp.why } : {}),
        ...(typeof gp.against_your_plan === 'string' ? { against_your_plan: gp.against_your_plan } : {}),
        ...(gpEv.length ? { evidence: gpEv } : {}),
      },
    } : {}),
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
      ? `${presentationNote} Updating this cached${Number.isInteger(state.prompt_version) ? ` v${state.prompt_version}` : ''} review${Number.isInteger(state.latest_prompt_version) ? ` to v${state.latest_prompt_version}` : ''} failed${state.refresh_failed.reason ? ` (${state.refresh_failed.reason})` : ''}; returning the saved review instead. Call replay_review with refresh: true and retry: true only if the user explicitly wants to retry regenerating it (this counts as a new start).`
      : state?.stale_version && Number.isInteger(state.prompt_version)
        ? `${presentationNote} This cached review was written under coach v${state.prompt_version}${Number.isInteger(state.latest_prompt_version) ? ` (latest is v${state.latest_prompt_version})` : ''}; call replay_review with refresh: true only if the user explicitly wants to regenerate it.`
        : presentationNote,
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

const PARSE_STAGE_DETAIL = {
  locating: 'locating the replay',
  downloading: 'downloading the replay',
  extracting: 'extracting replay events',
  building: 'building the replay trace',
  storing: 'saving the replay trace',
};

/**
 * @param {{ surface?: 'native_dsh' | 'remote_mcp', toolName?: string, coachToolName?: string, read: Function, validMatch: Function, availability: Function, status: Function, lastFailure?: Function, prepare: Function, start: Function }} api
 *   lib/agent/router.js forRequest(req) or packages/dsh/src/service.js local adapter
 * @param {{ match_id: string | number, hero?: string | number, lang?: 'en' | 'zh', retry?: boolean, refresh?: boolean }} args
 */
export async function replayReview(api, args) {
  const rawMatch = String(args?.match_id ?? '').trim();
  const matchId = normalizeMatchId(args?.match_id) ?? rawMatch;
  if (!api.validMatch(matchId)) {
    throw new ReplayToolError('INVALID_INPUT', 'match_id must be a Dota 2 match ID (digits) or a dota2.ai / OpenDota / Dotabuff / STRATZ match URL.');
  }
  const surface = api.surface ?? 'remote_mcp';
  const toolName = api.toolName ?? (surface === 'native_dsh' ? 'dota2ai_replay_review' : 'replay_review');
  const coachTool = api.coachToolName ?? (surface === 'native_dsh' ? 'dota2ai_coach_report' : 'coach_report');
  const ctx = { surface, toolName, coachTool };

  const lang = normalizeUiLang(args?.lang);
  const g = api.read();
  if (!g.ok) throw new ReplayToolError('RATE_LIMITED', `Too many requests; try again in ${g.retryAfterSec} s.`);
  let avail = await api.availability(matchId);

  if (!avail.trace) {
    if (!avail.can_parse) {
      return {
        status: 'unavailable',
        surface,
        stage: 'parse',
        match_id: matchId,
        reason: 'replay_parsing_off',
        message: surface === 'native_dsh'
          ? `This DSH plugin cannot fetch replays right now. ${coachTool} still has the scoreboard-level review.`
          : `This server cannot fetch replays, so it cannot review this game. ${coachTool} still has the scoreboard-level review.`,
      };
    }
    const p = avail.parse ?? { status: 'none' };
    if (p.status === 'failed' && p.final) return replayGone(matchId, p.reason, ctx);
    // A non-final parse failure (e.g. Steam GC rate-limited / replay URL not yet available) must not loop as
    // `parsing` on every poll: report it honestly and retry only when the caller asks (`retry: true`).
    if (p.status === 'failed' && args?.retry !== true) return parseFailed(matchId, p, ctx);
    let parseStage = p.stage ?? null;
    // A hero is needed for the review, not for the parse: start the parse now either way, and ask while it runs.
    if (p.status !== 'running') {
      const r = await api.prepare(matchId);
      if (r.status === 429 || (r.status === 503 && r.body?.retryAfterSec)) throw refusal(r);
      if (r.body?.status === 'failed' && r.body.final) return replayGone(matchId, r.body.reason, ctx);
      if (r.body?.status === 'failed') return parseFailed(matchId, r.body, ctx);
      if (r.body?.status === 'unavailable') {
        return {
          status: 'unavailable',
          surface,
          stage: 'parse',
          match_id: matchId,
          reason: 'replay_parsing_off',
          message: surface === 'native_dsh'
            ? `This DSH plugin cannot fetch replays right now. ${coachTool} still has the scoreboard-level review.`
            : `This server cannot fetch replays, so it cannot review this game. ${coachTool} still has the scoreboard-level review.`,
        };
      }
      if (r.body?.status === 'ready') {
        avail = await api.availability(matchId);
      } else if (r.body?.stage) {
        parseStage = r.body.stage;
      }
    }
    if (!avail.trace) {
      const stage = parseStage ?? 'locating';
      const stageLabel = PARSE_STAGE_DETAIL[stage] ?? 'fetching and reading the replay';
      return {
        status: 'parsing',
        surface,
        stage,
        match_id: matchId,
        message: `Still preparing the replay (${stageLabel}; usually a minute or two). Call ${toolName} again with the same arguments.`,
        ...(args?.hero == null || args.hero === '' ? { ask_user: `Which hero did the user play in this game? (${coachTool} without hero lists the roster.)` } : {}),
        poll_after_sec: POLL_AFTER_SEC,
      };
    }
  }

  const hero = resolveHero(avail.heroes, args?.hero);
  if (!hero) {
    return {
      status: 'pick_hero',
      surface,
      match_id: matchId,
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
    return reviewFailed(matchId, hero.hero, lang, state.reason ?? null, ctx);
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
      if (wantsRefresh) return shapeReview(matchId, hero.hero, lang, { ...state, refresh_failed: { reason: 'model_not_configured' } }, { surface });
      return modelUnavailable(matchId, 'model_not_configured', null, ctx);
    }
    const prevReady = wantsRefresh ? state : null;
    const r = wantsRefresh ? await api.start(matchId, hero.hero, lang, { refresh: true }) : await api.start(matchId, hero.hero, lang);
    if (r.status === 429 || (r.status === 503 && r.body?.retryAfterSec)) throw refusal(r);
    if (r.status === 503) {
      const reason = r.body?.reason ?? 'model_not_configured';
      if (prevReady) return shapeReview(matchId, hero.hero, lang, { ...prevReady, refresh_failed: { reason } }, { surface });
      return modelUnavailable(matchId, reason, r.body?.retry_in_sec ?? null, ctx);
    }
    if (prevReady && (r.body?.status === 'failed' || r.body?.status === 'unavailable')) {
      return shapeReview(matchId, hero.hero, lang, { ...prevReady, refresh_failed: { reason: r.body.reason ?? null } }, { surface });
    }
    if (r.body?.status === 'unavailable') {
      return modelUnavailable(matchId, r.body.reason ?? 'model_not_configured', r.body.retry_in_sec ?? null, ctx);
    }
    if (r.body?.status === 'failed') {
      return reviewFailed(matchId, hero.hero, lang, r.body.reason ?? null, ctx);
    }
    state = r.body;
    refreshFailure = null;
  }
  if (state.status === 'ready') return shapeReview(matchId, hero.hero, lang, refreshFailure ? { ...state, refresh_failed: refreshFailure } : state, { surface });
  return {
    status: 'reviewing',
    surface,
    stage: 'review',
    match_id: matchId, hero: hero.hero, lang,
    steps: Array.isArray(state.steps) ? state.steps.length : 0,
    message: args?.retry === true
      ? `The coach is going through the replay (two to three minutes in all). Call ${toolName} again without retry: true to check progress.`
      : `The coach is going through the replay (two to three minutes in all). Call ${toolName} again with the same arguments.`,
    poll_after_sec: POLL_AFTER_SEC,
  };
}

function modelUnavailable(matchId, reason, retryInRaw, { surface }) {
  const retryIn = Number.isFinite(retryInRaw) && retryInRaw > 0 ? Math.ceil(retryInRaw) : null;
  const wait = retryIn != null ? ` Try again in about ${retryIn} s.` : '';
  const message = surface === 'native_dsh'
    ? reason === 'model_out_of_credit'
      ? `Your DSH model account reported insufficient balance (${reason}). Top up or switch models in DSH.${wait}`
      : reason === 'model_refused_the_key'
        ? `Your DSH model API key was rejected (${reason}). Update the key or switch models in DSH.${wait}`
        : `No DSH model is configured yet (${reason}). Configure or select a model in DSH settings and call again.`
    : `The coach is not available on this server right now (${reason}).${wait}`;
  return {
    status: 'unavailable',
    surface,
    stage: 'review',
    match_id: matchId,
    reason,
    ...(retryIn != null ? { retry_in_sec: retryIn } : {}),
    message,
  };
}

function reviewFailed(matchId, hero, lang, reason, { surface, toolName }) {
  const detail = reason === 'model_out_of_credit' && surface === 'native_dsh'
    ? 'Your DSH model account reported insufficient balance. Top up or switch models in DSH, then call'
    : reason === 'model_refused_the_key' && surface === 'native_dsh'
      ? 'Your DSH model API key was rejected. Check your API key in DSH, then call'
      : reason === 'model_rate_limited'
        ? 'The model rate-limited this review. Wait a moment and call'
        : reason === 'timeout'
          ? 'The review timed out before finishing. Call'
          : 'The coach could not finish a review it could back with the replay. It often works on a second try: call';
  return {
    status: 'failed',
    surface,
    stage: 'review',
    match_id: matchId,
    hero,
    lang,
    reason,
    retryable: true,
    message: `${detail} ${toolName} again with retry: true${surface === 'remote_mcp' ? ' (this counts as a new start)' : ''}.`,
  };
}

function parseFailed(matchId, p, { surface, toolName, coachTool }) {
  const reason = p?.reason ?? 'parse_failed';
  const retryIn = Number.isFinite(p?.retry_in_sec) && p.retry_in_sec > 0 ? Math.ceil(p.retry_in_sec) : null;
  const waitHint = retryIn != null
    ? ` Wait about ${retryIn} s and call ${toolName} again with retry: true.`
    : ` Call ${toolName} again with retry: true to try fetching the replay again.`;
  const lead = reason === 'no_replay_url'
    ? 'The replay URL is not available from Valve yet (a match that just finished takes a few minutes).'
    : reason === 'rate_limited'
      ? 'Replay parsing is temporarily rate-limited.'
      : reason === 'busy'
        ? 'Replay parsing is temporarily at capacity.'
        : `Could not fetch or parse the replay right now (${reason}).`;
  return {
    status: 'failed',
    surface,
    stage: 'parse',
    match_id: matchId,
    reason,
    retryable: true,
    ...(retryIn != null ? { retry_in_sec: retryIn } : {}),
    message: `${lead}${waitHint} ${coachTool} still has the scoreboard-level review.`,
  };
}

function replayGone(matchId, reason, { surface, coachTool }) {
  return reason === 'replay_gone'
    ? {
      status: 'replay_unavailable',
      surface,
      stage: 'parse',
      match_id: matchId,
      reason,
      retryable: false,
      message: `Valve keeps replays for about two weeks; this one is gone, so there is nothing to review honestly. ${coachTool} still has the scoreboard-level review.`,
    }
    : {
      status: 'replay_unavailable',
      surface,
      stage: 'parse',
      match_id: matchId,
      reason: reason ?? 'parse_failed',
      retryable: false,
      message: `The replay could not be fetched or read (${reason ?? 'parse_failed'}). ${coachTool} still has the scoreboard-level review.`,
    };
}
