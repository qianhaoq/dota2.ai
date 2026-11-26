/**
 * The agent as a service: replay → trace jobs, deep-review jobs, and what is
 * kept of both. All IO is injected, so it runs offline in tests.
 *
 * - `traces` answers `get(matchId)` with a `dota2.ai/match-trace@1` or null
 *   (stores.js: a directory or a bucket).
 * - `pipeline.run(matchId)` makes a trace from the replay
 *   (tracePipeline.js: in process, or on the worker service). Optional:
 *   without it nothing can be parsed and the service says so.
 * - A parse and a deep review are background jobs: starting one returns at
 *   once; status reports running (with the stage or the agent's tool steps) /
 *   ready / failed. One job per match, one review per (match, hero, language).
 * - `docs` (a JSON store) keeps finished reviews and a small marker per
 *   running job, so another instance — or this one after a restart — reports
 *   "running" or "ready" instead of offering to start again.
 * - A running review saves a checkpoint after every finished round of lookups
 *   (the conversation so far). One that was cut off — its instance stopped or
 *   crashed — continues from there when it is started or delivered again,
 *   instead of asking the model for the whole investigation a second time.
 *   The checkpoint goes when the review ends, either way.
 * - A review is written by one model. `models` (id → { complete, name }) are the ones offered and
 *   `defaultModel` the one a request without a model gets; a review by another model is its own review, kept
 *   beside it (`.m-<id>` in its key), so the same game can be read by two models and compared. The key
 *   without a model is the reviews written before there was a choice, which models.js's first model wrote:
 *   it stays that model's whatever this server's default is, so a server set up with another default is
 *   never handed them as its own. Without `models`, the single `complete` is the default and the only one.
 * - `dispatch` (optional, tasks.js) hands a started parse or review to a queue;
 *   it comes back as `run(task)`, which does the work and answers when it is
 *   over, so the request that carries it lasts as long as the job. Without
 *   `dispatch`, or when queueing fails, the job runs in the background of the
 *   instance that started it, as before.
 */
import { DEEP_REVIEW_PROMPT_VERSION, runDeepReview, withoutHandles } from './deepReview.js';
import { SUPPORTED_LANGS, normalizeUiLang } from '../aiLanguage.js';
import { feedbackKey, feedbackRecord } from './feedback.js';
import { runChat } from './chat.js';
import { isUltimate, namesIn, resolveRef } from './evidence.js';
import { momentFrames } from './moment.js';
import { placeNames } from './places.js';
import { heroByKey } from '../../packages/review-engine/src/staticHeroes.js';
import { createFileStore, createJsonStore, createTraceStore } from './stores.js';
import { planKey } from './plans.js';
import { DEFAULT_AGENT_MODEL } from './models.js';
import { TRACE_BUILD_VERSION, traceIsOutdated } from './traceBuild.js';
import { replayPastKeeping } from './tracePipeline.js';
import { goldLead } from '../../packages/review-engine/src/trace/index.js';
import { HEROES_BY_KEY } from '../../packages/review-engine/src/staticHeroes.js';

// By the key a replay uses for the hero, which is not always the internal slug ("queen_of_pain" for queenofpain).
const HERO_BY_SLUG = HEROES_BY_KEY;
const MAX_KEPT_JOBS = 200;
/**
 * A running job says so again every BEAT_MS, also while the model is thinking or the replay is being read, so
 * one that died with its instance (a deploy, a crash) is seen as gone after STALE_MS rather than after the
 * longest a step may take. The page then starts it again by itself.
 */
const BEAT_MS = 15_000;
const STALE_MS = 90_000;
/** A queued job does not start beside one another runner reported on this recently (three beats). */
const BUSY_MS = 45_000;
const REVIEW_BEAT_MS = BEAT_MS;
const REVIEW_STALE_MS = STALE_MS;
const REVIEW_BUSY_MS = BUSY_MS;
/** A parse still going after this has stopped reporting in: the pipeline's own deadlines end it sooner (tracePipeline.js). */
const PARSE_MAX_MS = 15 * 60_000;
/** A checkpoint older than this is not continued from: the review starts over. */
const CHECKPOINT_MAX_MS = 60 * 60_000;
/** A review still going after this is given up: the model call is cancelled and the job stops reporting in. */
const REVIEW_MAX_MS = 15 * 60_000;
/**
 * The same, for a model that writes slowly (an engine's `maxMs`): the two timed on 2026-11-25 took 11 to 13
 * minutes for a review the default writes in two to three. Under the 30 minutes a queued job may take (tasks.js).
 */
export const SLOW_REVIEW_MAX_MS = 25 * 60_000;
/** A failed parse may be tried again after this (a replay can appear late; a worker can recover). */
const PARSE_RETRY_MS = 5 * 60_000;
/**
 * How soon after a failure a new parse is started when a reader asks again. Until then the same failure is
 * answered, with how long is left: a replay address that was not there a second ago is not there now (one reader
 * started seven parses of one game in fifteen seconds), and a double click must not start two downloads.
 */
export const PARSE_BACKOFF_MS = { no_replay_url: 60_000 };
export const PARSE_BACKOFF_DEFAULT_MS = 10_000;
/** After the model account refused a review for want of credit or a valid key, no review is started for this long. */
export const MODEL_DOWN_MS = 5 * 60_000;

/**
 * Why a review's model call failed, as a word the log and the page can use. From the error's HTTP status and
 * its class only: its message is the provider's text and is never logged or passed on. The class is read off
 * the prototype chain, not off `name`: the SDK's connection, timeout and abort errors all have the name "Error"
 * (openai 4.x), and a deadline that fires reaches here wrapped as its APIUserAbortError.
 * @returns {{ reason: 'model_out_of_credit' | 'model_refused_the_key' | 'model_rate_limited' | 'model_unavailable' | 'timeout' | 'error', status: number | null }}
 */
export function reviewFailure(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  // Every class the error is an instance of, by name, and its own `name` (a DOMException says TimeoutError there).
  const kinds = new Set(typeof error?.name === 'string' ? [error.name] : []);
  for (let p = error && typeof error === 'object' ? Object.getPrototypeOf(error) : null; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) if (typeof p.constructor?.name === 'string') kinds.add(p.constructor.name);
  const is = (...names) => names.some((n) => kinds.has(n));
  const reason = status === 402 ? 'model_out_of_credit'
    : status === 401 || status === 403 ? 'model_refused_the_key'
      : status === 429 ? 'model_rate_limited'
        : status != null && status >= 500 ? 'model_unavailable'
          // A timeout is a kind of connection error in the SDK: looked at first.
          : is('TimeoutError', 'AbortError', 'APIConnectionTimeoutError', 'APIUserAbortError') ? 'timeout'
            : is('APIConnectionError') ? 'model_unavailable'
              : 'error';
  return { reason, status };
}
/** Failures that the next request will meet too, until somebody tops the account up or fixes the key. */
const MODEL_DOWN_REASONS = new Set(['model_out_of_credit', 'model_refused_the_key']);
/**
 * Reasons that will not change by trying again. Not `no_replay_url`: a game
 * that just ended has no address yet and gets one minutes later.
 */
const FINAL_REASONS = new Set(['replay_gone', 'too_large', 'wrong_match']);

/** Traces from a directory (what scripts/build-trace.mjs writes). */
export function createFileTraceStore(dir, options) {
  return createTraceStore(dir ? createFileStore(dir) : null, options);
}

/**
 * @param {{
 *   traces: { get: (matchId: number | string) => Promise<any> },
 *   complete?: Function | null,
 *   model?: string | null,
 *   models?: Record<string, { complete: Function, name?: string | null, maxMs?: number }> | null,
 *   defaultModel?: string | null,
 *   pipeline?: { run: (matchId: number | string, o?: { onStage?: (stage: string) => void }) => Promise<{ ok: boolean, reason?: string }> } | null,
 *   getMatchDetail?: (id: number) => Promise<any>,
 *   docs?: { get: (key: string) => Promise<any>, put: (key: string, value: any) => Promise<void> } | null,
 *   feedback?: { put: (key: string, value: any) => Promise<void> } | null,  where readers' words on findings are kept; without it none is taken
 *   reviewDir?: string | null,
 *   beatMs?: number,
 *   dispatch?: ((task: { kind: 'parse' | 'review', matchId: string, hero?: string, lang?: string, plan?: string, model?: string }) => Promise<void>) | null,
 *   now?: () => number,
 *   log?: (msg: string) => void,
 * }} deps
 */
export function createAgentService(deps) {
  const { traces } = deps;
  // Who writes a review: the default (asked for by no name, or by its own), and the others by id.
  const defaultModel = deps.models ? deps.defaultModel ?? Object.keys(deps.models)[0] ?? null : null;
  const mainEngine = deps.models ? (defaultModel != null ? deps.models[defaultModel] ?? null : null) : deps.complete ? { complete: deps.complete, name: deps.model ?? null } : null;
  const others = new Map(Object.entries(deps.models ?? {}).filter(([id]) => id !== defaultModel));
  /** The model a request names: null (the default), the id of another one offered here, or `false` (not offered). */
  const modelOf = (v) => (v == null || v === '' || (defaultModel != null && v === defaultModel) ? null : others.has(v) ? v : false);
  const engineOf = (model) => (model ? others.get(model) : mainEngine) ?? null;
  const pipeline = deps.pipeline ?? null;
  const reparseOldTraces = deps.reparseOldTraces === true;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => Date.now());
  const docs = deps.docs ?? (deps.reviewDir ? createJsonStore(createFileStore(deps.reviewDir)) : null);
  const dispatch = deps.dispatch ?? null;
  /** Who is running a job, in its marker: another instance's fresh marker is a review somebody is doing. */
  const runner = `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  /** @type {Map<string, any>} */
  const jobs = new Map();
  /** @type {Map<string, any>} */
  const parses = new Map();
  // A review made for a plan the player named is its own review: the same game read against what they went for.
  // So is one written by another model: the same game as that model read it. `model` is what modelOf gave (null:
  // this server's default). The key carries the model's id — unless it is the model whose reviews never did
  // (models.js's first), and not because it happens to be the default here.
  const idOf = (model) => model ?? defaultModel;
  const suffixOf = (plan = null, model = null) => {
    const id = idOf(model);
    return `p${DEEP_REVIEW_PROMPT_VERSION}${plan ? `.plan-${plan}` : ''}${id && id !== DEFAULT_AGENT_MODEL ? `.m-${id}` : ''}`;
  };
  // One job and one trilingual bundle per (match, hero, prompt version, plan, model): generating en/zh/ru once.
  const keyOf = (matchId, hero, plan = null, model = null) => `${matchId}.${hero}.${suffixOf(plan, model)}`;
  // Legacy per-language key (pre-bundle stored reviews, and per-language finding feedback records).
  const legacyKeyOf = (matchId, hero, lang, plan = null, model = null) => `${matchId}.${hero}.${lang}.${suffixOf(plan, model)}`;
  const read = async (key) => { try { return docs ? await docs.get(key) : null; } catch { return null; } };
  const write = async (key, value) => { try { if (docs) await docs.put(key, value); } catch { log(`agent doc not saved key=${key}`); } };
  // Emptied first, then removed: where the store cannot delete, what is left is not a checkpoint any more.
  const drop = async (key) => { await write(key, { v: 0 }); try { await docs?.delete?.(key); } catch { /* emptied above */ } };

  /** The scoreboard-level match, best effort: the review works without it. */
  async function matchOf(matchId) {
    if (!deps.getMatchDetail) return null;
    try { return await deps.getMatchDetail(Number(matchId)); } catch { return null; }
  }

  /** A hero as a request names it ("Queen of Pain", npc_dota_hero_queenofpain's key) → the key reviews are kept under. */
  const heroKeyOf = (hero) => String(hero ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_');

  function raceSignal(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('The operation timed out.', 'TimeoutError'));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new DOMException('The operation timed out.', 'TimeoutError'));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
        (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
      );
    });
  }
  const sleepSignal = (ms, signal) => raceSignal(new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); }), signal);

  /** Read a stored trace, evicting an in-memory legacy trace if a remote worker or another runner finished upgrading it. */
  async function freshTraceOf(matchId) {
    let trace = await traces.get(matchId);
    if (trace && reparseOldTraces && traceIsOutdated(trace) && typeof traces.evict === 'function') {
      const id = String(matchId);
      const marker = parses.get(id)?.state === 'running' ? null : await read(`${id}.parse.json`);
      if (marker?.state === 'done' && marker?.trace_version === TRACE_BUILD_VERSION) {
        traces.evict(id);
        trace = (await traces.get(matchId)) ?? trace;
      }
    }
    return trace;
  }

  async function seatOf(matchId, hero) {
    const trace = await freshTraceOf(matchId);
    if (!trace) return { trace: null, key: null };
    const k = heroKeyOf(hero);
    return { trace, key: trace.heroes.some((h) => h.key === k) ? k : null };
  }

  const cleanReviewsMap = (map) => Object.fromEntries(
    Object.entries(map ?? {}).filter(([, r]) => r?.schema).map(([l, r]) => [l, withoutHandles(r)]),
  );
  // Record handles left in the text of a review stored earlier are taken out on the way: what is stored is not rewritten.
  // Reads the trilingual bundle first (`<match>.<hero>.p<v>.review.json`), falling back to legacy per-language files.
  const stored = async (matchId, hero, lang, plan = null, model = null) => {
    const L = normalizeUiLang(lang);
    const bundle = await read(`${keyOf(matchId, hero, plan, model)}.review.json`);
    if (bundle?.reviews && typeof bundle.reviews === 'object') {
      const reviews = cleanReviewsMap(bundle.reviews);
      if (reviews[L]) return { ...bundle, review: reviews[L], reviews };
    }
    const legacy = await read(`${legacyKeyOf(matchId, hero, L, plan, model)}.review.json`);
    if (legacy?.review?.schema) {
      const review = withoutHandles(legacy.review);
      return { ...legacy, review, reviews: { [L]: review } };
    }
    return null;
  };

  /** Where the replay parse of this match stands (when there is no trace). */
  async function parseState(matchId) {
    const id = String(matchId);
    const local = parses.get(id);
    // A parse running here is the truth. One that ended here may have been tried again on another instance:
    // the shared marker wins when it is the newer of the two.
    const shared = local?.state === 'running' ? null : await read(`${id}.parse.json`);
    const job = shared && (!local || (shared.at ?? 0) >= (local.at ?? 0)) ? shared : local ?? shared;
    if (!job) return { status: 'none' };
    const age = now() - (job.at ?? 0);
    // A parse running here is running for as long as it may take, whatever its marker's age (a timer can be
    // late); another instance's is believed only while it keeps reporting in.
    if (job.state === 'running') return (job === local ? now() - (parseBegan.get(job) ?? 0) < PARSE_MAX_MS : age < STALE_MS) ? { status: 'running', stage: job.stage ?? null } : { status: 'none' };
    if (job.state === 'failed') {
      const final = FINAL_REASONS.has(job.reason);
      if (!final && age >= PARSE_RETRY_MS) return { status: 'none' };
      // How long until asking again starts a new parse (0: now). A final failure has no such time.
      const backoff = PARSE_BACKOFF_MS[job.reason] ?? PARSE_BACKOFF_DEFAULT_MS;
      return { status: 'failed', reason: job.reason, final, ...(final ? {} : { retry_in_sec: Math.max(0, Math.ceil((backoff - age) / 1000)) }) };
    }
    return { status: 'none' };
  }

  /**
   * The replay's own lead per minute, for a page whose match record has none: gold earned, summed from the combat
   * log, when the trace has its gold rows; else the net worth graph summed by team. Named for what it is.
   */
  const goldOf = (trace) => { const g = goldLead(trace, {}); return !g ? {} : g.source === 'replay_gold_log' ? { radiant_gold_lead: g.lead } : { radiant_net_worth_lead: g.lead }; };

  /**
   * Whether an existing outdated trace can and should be re-parsed from its replay (#365):
   * - Only when `reparseOldTraces` and `pipeline` are enabled and `traceIsOutdated(trace)` is true.
   * - Never when a re-parse under `TRACE_BUILD_VERSION` already failed for good (`replay_gone`, `too_large`,
   *   `wrong_match`) or failed within `PARSE_RETRY_MS`, or when the match record's own times prove the replay
   *   is past keeping (>14 days): then the existing trace stays as-is ("unknown" for missing fields).
   */
  async function shouldReparseTrace(matchId, trace) {
    if (!reparseOldTraces || !pipeline || !traceIsOutdated(trace)) return false;
    const id = String(matchId);
    const local = parses.get(id);
    const shared = local?.state === 'running' ? null : await read(`${id}.parse.json`);
    const marker = shared && (!local || (shared.at ?? 0) >= (local.at ?? 0)) ? shared : local ?? shared;
    if (marker?.trace_version === TRACE_BUILD_VERSION) {
      if (marker.state === 'done') return false;
      if (marker.state === 'failed') {
        if (FINAL_REASONS.has(marker.reason)) return false;
        if (now() - (marker.at ?? 0) < PARSE_RETRY_MS) return false;
      }
    }
    const match = await matchOf(matchId);
    if (replayPastKeeping(match, now())) {
      const gone = { state: 'failed', reason: 'replay_gone', trace_version: TRACE_BUILD_VERSION, at: now() };
      parses.set(id, gone);
      await write(`${id}.parse.json`, gone);
      return false;
    }
    return true;
  }

  const activeParses = new Map();
  const reparsing = new Map();
  const reparseClaims = new Map();

  /**
   * Join an in-flight parse or re-parse an outdated trace in place, deduplicated per match, without ever deleting the
   * stored trace if the replay is gone or the download fails. `allowStart: false` joins an active parse if one is
   * already running, without starting a new `executeParse` when parse admission was refused.
   */
  async function upgradeOutdatedTrace(matchId, fallbackTrace, { allowStart = true, signal } = {}) {
    const id = String(matchId);
    if (preparing.has(id)) await raceSignal(preparing.get(id).catch(() => null), signal);
    if (activeParses.has(id)) {
      await raceSignal(activeParses.get(id), signal);
      traces.evict?.(id);
      return (await traces.get(id)) ?? fallbackTrace;
    }
    while ((await parseState(id)).status === 'running') {
      if (activeParses.has(id)) {
        await raceSignal(activeParses.get(id), signal);
        break;
      }
      await sleepSignal(Math.min(1000, deps.beatMs ?? 250), signal);
    }
    const postWait = await freshTraceOf(id);
    if (postWait && !traceIsOutdated(postWait)) return postWait;
    if (!allowStart) return postWait ?? fallbackTrace;

    let entry = reparsing.get(id);
    if (!entry) {
      const abort = new AbortController();
      entry = {
        waiters: 0,
        abort,
        promise: (async () => {
          if (!(await shouldReparseTrace(id, postWait ?? fallbackTrace))) return (await freshTraceOf(id)) ?? fallbackTrace;
          if (activeParses.has(id)) {
            await activeParses.get(id);
            traces.evict?.(id);
            return (await traces.get(id)) ?? fallbackTrace;
          }
          log(`trace reparse start match=${id} target_build=${TRACE_BUILD_VERSION}`);
          const { done } = await executeParse(id, { signal: abort.signal });
          const res = await done;
          if (res?.status === 'ready') {
            traces.evict?.(id);
            const fresh = await traces.get(id);
            if (fresh) return fresh;
          }
          log(`trace reparse kept-old match=${id} reason=${res?.reason ?? res?.status ?? 'unknown'}`);
          return (await traces.get(id)) ?? fallbackTrace;
        })().finally(() => reparsing.delete(id)),
      };
      reparsing.set(id, entry);
    }
    entry.waiters += 1;
    let released = false;
    const release = (reason) => {
      if (released) return;
      released = true;
      entry.waiters -= 1;
      if (entry.waiters <= 0 && reason !== undefined) entry.abort.abort(reason);
    };
    const onAbort = () => release(signal?.reason ?? new DOMException('The operation timed out.', 'TimeoutError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await raceSignal(entry.promise, signal);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      release(undefined);
    }
  }

  /** What exists for this match: the heroes a review can be made for, or how far the replay is. */
  async function availability(matchId) {
    const trace = await freshTraceOf(matchId);
    // `models`: the ids a review can be asked from here, the default first (only where there is a choice to offer).
    const base = { model_configured: Boolean(engineOf(null)), can_parse: Boolean(pipeline), ...(deps.models && engineOf(null) ? { models: [defaultModel, ...others.keys()], default_model: defaultModel } : {}) };
    if (trace) return { trace: true, ...(traceIsOutdated(trace) ? { trace_outdated: true } : {}), ...base, heroes: trace.heroes.map((h) => ({ hero: h.key, team: h.team === 2 ? 'radiant' : 'dire', hero_id: HERO_BY_SLUG.get(h.key)?.id ?? null, en: HERO_BY_SLUG.get(h.key)?.nameEn ?? h.key, zh: HERO_BY_SLUG.get(h.key)?.nameZh ?? h.key, ru: HERO_BY_SLUG.get(h.key)?.nameEn ?? h.key })), ...goldOf(trace) };
    return { trace: false, ...base, heroes: [], parse: await parseState(matchId) };
  }

  /**
   * Start (or join) parsing this match's replay. Never throws; never waits for
   * the parse. Two requests arriving together share one start (the claim is
   * taken before the first await), so one replay is fetched once. `admit`
   * (optional) is asked once, by the request about to start the parse; one
   * that joins it, or finds the trace or a final failure, is never charged.
   * It returns null to admit, or a refusal handed back to every request
   * sharing the start.
   */
  const preparing = new Map();
  function prepare(matchId, { admit } = {}) {
    const id = String(matchId);
    const pending = preparing.get(id);
    if (pending) return pending;
    const p = beginParse(id, admit).finally(() => preparing.delete(id));
    preparing.set(id, p);
    return p;
  }
  async function beginParse(id, admit) {
    const existing = await freshTraceOf(id);
    if (existing && !(await shouldReparseTrace(id, existing))) return { status: 'ready' };
    if (!pipeline) return existing ? { status: 'ready' } : { status: 'unavailable' };
    const state = await parseState(id);
    // Running, failed for good, or failed a moment ago: answered as it stands, and nobody is charged for asking.
    if (state.status === 'running') return state;
    if (state.status === 'failed' && (state.final || state.retry_in_sec > 0)) return existing ? { status: 'ready' } : state;
    const refusal = admit ? admit() : null;
    if (refusal) return { status: 'refused', refusal };
    if (dispatch) {
      // Queued: the marker says "running" for every instance; the parse itself arrives as run({ kind: 'parse' }).
      await write(`${id}.parse.json`, { state: 'running', stage: 'locating', at: now() });
      try { await dispatch({ kind: 'parse', matchId: id }); return { status: 'running', stage: 'locating' }; } catch (error) { log(`parse not queued match=${id} (${error?.message ?? 'error'}): running here`); }
    }
    const { job } = await executeParse(id);
    return { status: 'running', stage: job.stage };
  }
  /** How to hand back each parse running here when the instance is stopped (shutdown). */
  const parseStops = new Map();
  const parseBegan = new WeakMap();
  /**
   * Parse here. Returns once the job is set up; `done` resolves with how it ended (ready / failed / interrupted).
   * `queued`: as for a review — the queue delivers the job again when this instance is stopped, so a stop leaves
   * it "running" for the next delivery.
   */
  async function executeParse(id, { queued = false, signal } = {}) {
    const job = { state: 'running', stage: 'locating', at: now() };
    parses.set(id, job);
    parseBegan.set(job, now());
    // Marker writes go one after another, in the order they were made: a slow "downloading" must not land
    // after "failed" and bring a dead parse back to life for other instances.
    let last = Promise.resolve();
    const put = (value) => { last = last.then(() => write(`${id}.parse.json`, value)); return last; };
    // After `stop` (the instance is going away) nothing may say "running" again; how it ended still may.
    let stopped = false;
    const mark = (value) => (stopped && value.state === 'running' ? last : put(value));
    let interrupt;
    const interrupted = new Promise((resolve) => { interrupt = resolve; });
    const stop = () => {
      stopped = true;
      if (job.state !== 'running') return last;
      interrupt({ status: 'interrupted' });
      return put(queued ? { state: 'running', stage: job.stage, at: now() } : { state: 'interrupted', at: now() });
    };
    parseStops.set(id, stop);
    await mark({ ...job, runner });
    const began = now();
    const beat = setInterval(() => { if (now() - began > PARSE_MAX_MS) clearInterval(beat); else if (job.state === 'running') { job.at = now(); mark({ ...job, runner }); } }, deps.beatMs ?? BEAT_MS);
    beat.unref?.();
    const work = (async () => {
      let out;
      try {
        out = await pipeline.run(id, { onStage: (stage) => { job.stage = stage; job.at = now(); mark({ ...job, runner }); }, ...(signal ? { signal } : {}) });
      } catch (error) { log(`parse error match=${id}: ${error?.name ?? 'error'}`); out = { ok: false, reason: 'error' }; } finally { clearInterval(beat); if (parseStops.get(id) === stop) parseStops.delete(id); }
      if (out.ok) { traces.evict?.(id); job.state = 'done'; if (parses.get(id) === job) parses.delete(id); await mark({ state: 'done', trace_version: TRACE_BUILD_VERSION, at: now() }); log(`parse ready match=${id}`); return { status: 'ready' }; }
      Object.assign(job, { state: 'failed', reason: out.reason ?? 'error', trace_version: TRACE_BUILD_VERSION, at: now() });
      await mark({ ...job });
      log(`parse failed match=${id} reason=${job.reason}`);
      while (parses.size > MAX_KEPT_JOBS) parses.delete(parses.keys().next().value);
      return { status: 'failed', reason: job.reason };
    })();
    const settled = Promise.race([work, interrupted]);
    activeParses.set(id, settled);
    settled.finally(() => { if (activeParses.get(id) === settled) activeParses.delete(id); });
    return { job, done: settled };
  }

  const readyPayload = (record, rev) => ({
    status: 'ready',
    model: record.model,
    tool_calls: record.tool_calls,
    ...(record.verification ? { verification: record.verification } : {}),
    prompt_version: DEEP_REVIEW_PROMPT_VERSION,
    review: rev,
    ...(Object.keys(record.reviews ?? {}).length > 1 ? { reviews: record.reviews } : {}),
  });

  async function status(matchId, hero, lang, plan = null, model = null) {
    const { trace, key } = await seatOf(matchId, hero);
    if (!trace) return { status: 'no_trace' };
    if (!key) return { status: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
    const m = modelOf(model);
    if (m === false) return { status: 'unavailable', reason: 'model_not_offered' };
    const L = normalizeUiLang(lang);
    const p = planKey(plan);
    const id = keyOf(matchId, key, p, m);
    const job = jobs.get(id);
    if (job?.state === 'running') return { status: 'running', steps: job.steps };
    // The version this review was written under (it is part of the key it was found by): the page says it back
    // with a reader's word on a finding, so a word on an older review is not taken for this one.
    if (job?.state === 'ready') {
      const rev = job.result.reviews?.[L] ?? (job.result.review?.lang === L ? job.result.review : null);
      if (rev) return readyPayload(job.result, rev);
    }
    const disk = await stored(matchId, key, L, p, m);
    if (disk) {
      const merged = job?.state === 'ready' ? { ...disk, reviews: { ...job.result.reviews, ...disk.reviews } } : disk;
      jobs.set(id, { state: 'ready', result: merged });
      return readyPayload(merged, disk.review);
    }
    // Running on another instance: say so rather than offer a second start. That includes a retry started
    // elsewhere after this instance's own attempt failed: the newer attempt is the one to report.
    const marker = await read(`${id}.job.json`);
    if (marker?.state === 'running' && now() - (marker.at ?? 0) < REVIEW_STALE_MS && (job?.state !== 'failed' || (marker.at ?? 0) >= (job.at ?? 0))) return { status: 'running', steps: marker.steps ?? [] };
    if (job?.state === 'failed') return { status: 'failed', reason: job.reason };
    if (marker?.state === 'failed' && now() - (marker.at ?? 0) < 60_000) return { status: 'failed', reason: marker.reason };
    return { status: 'none' };
  }

  /**
   * The last attempt at this review failed, as any instance can tell: this one's own job, or the shared job
   * marker (status() stops calling a marker's failure "failed" after a minute, so the page offers a fresh
   * start; an agent's poll must not take that as one). { reason, at } or null. Never throws.
   */
  async function lastFailure(matchId, hero, _lang, plan = null, model = null) {
    try {
      const { trace, key } = await seatOf(matchId, hero);
      const m = modelOf(model);
      if (!trace || !key || m === false) return null;
      const id = keyOf(matchId, key, planKey(plan), m);
      const job = jobs.get(id);
      if (job?.state === 'failed') return { reason: job.reason ?? null, at: job.at ?? null };
      const marker = await read(`${id}.job.json`);
      return marker?.state === 'failed' ? { reason: marker.reason ?? null, at: marker.at ?? null } : null;
    } catch { return null; }
  }

  /**
   * The finished review for a selection, if one is stored; null otherwise. Reads the bundle (or legacy file)
   * and nothing else (no trace, no job), so a link preview can afford it. Never throws.
   */
  async function peek(matchId, hero, lang, plan = null, model = null) {
    const k = String(hero ?? '').trim().toLowerCase();
    const m = modelOf(model);
    if (m === false || !/^\d{1,20}$/.test(String(matchId)) || !/^[a-z][a-z0-9_]{1,39}$/.test(k) || !SUPPORTED_LANGS.includes(lang)) return null;
    try { return (await stored(matchId, k, lang, planKey(plan), m))?.review ?? null; } catch { return null; }
  }

  /**
   * Start (or join) the review job. Never throws; never waits for the model.
   * Two requests arriving together share one start: the claim is taken
   * before the first await, so both cannot see "none" and both begin.
   * `admit` (optional) is asked once, by the request that is about to create
   * the job; one that joins an existing start, or finds the review already
   * there, is never charged. It returns null to admit, or a refusal that is
   * handed back as `{ status: 'refused', refusal }` to every request sharing
   * the start.
   */
  const starting = new Map();
  /** Per model id: { reason, at, until } after its account refused a review (MODEL_DOWN_REASONS). */
  const modelDown = new Map();

  async function claimReparse(id, trace, admitParse) {
    if (!reparseOldTraces || !pipeline || !traceIsOutdated(trace)) return false;
    if (reparseClaims.has(id)) {
      await reparseClaims.get(id);
      return false;
    }
    const p = (async () => {
      if (preparing.has(id)) await preparing.get(id).catch(() => null);
      if (activeParses.has(id) || reparsing.has(id) || (await parseState(id)).status === 'running') return false;
      const latest = (await freshTraceOf(id)) ?? trace;
      if (!(await shouldReparseTrace(id, latest))) return false;
      if (admitParse) {
        const refusal = admitParse();
        if (refusal) {
          log(`trace reparse skipped match=${id} reason=${refusal.body?.code ?? 'refused'}`);
          return false;
        }
      }
      return true;
    })().finally(() => reparseClaims.delete(id));
    reparseClaims.set(id, p);
    return p;
  }

  function start(matchId, hero, lang, { admit, admitParse, plan = null, model = null } = {}) {
    const m = modelOf(model);
    if (m === false) return Promise.resolve({ status: 'unavailable', reason: 'model_not_offered' });
    const L = normalizeUiLang(lang);
    const pPlan = planKey(plan);
    const claim = `${matchId}|${String(hero ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_')}|${pPlan ?? ''}|${m ?? ''}`;
    let pending = starting.get(claim);
    if (!pending) {
      pending = begin(matchId, hero, L, admit, pPlan, m, admitParse).finally(() => starting.delete(claim));
      starting.set(claim, pending);
    }
    return pending.then((res) => {
      if (res?.status !== 'ready') return res;
      const rev = res.reviews?.[L] ?? (res.review?.lang === L ? res.review : null);
      if (rev) return { ...res, review: rev };
      // Caller requested a language missing from a legacy single-language stored review: start/read for its own language.
      return begin(matchId, hero, L, admit, pPlan, m, admitParse);
    });
  }
  async function begin(matchId, hero, lang, admit, plan, model, admitParse) {
    const current = await status(matchId, hero, lang, plan, model);
    if (current.status !== 'none' && current.status !== 'failed') return current;
    if (!engineOf(model)) return { status: 'unavailable', reason: 'model_not_configured' };
    // The account behind this model just refused a review for want of credit or a valid key, or the periodic
    // balance check saw it under the pause floor: the next one would fail too, so none is started (and nobody is
    // charged a slot) until that has had time to be put right.
    const modelKey = idOf(model) ?? '';
    const monitorDown = deps.balanceMonitor?.down?.(modelKey) ?? null;
    if (monitorDown) return { status: 'unavailable', reason: monitorDown.reason, retry_in_sec: monitorDown.retry_in_sec };
    const down = modelDown.get(modelKey);
    if (down?.reason === 'model_out_of_credit' && deps.balanceMonitor?.healthySince?.(modelKey, down.at ?? Infinity)) modelDown.delete(modelKey);
    else if (down && now() < down.until) return { status: 'unavailable', reason: down.reason, retry_in_sec: Math.ceil((down.until - now()) / 1000) };
    const { trace, key } = await seatOf(matchId, hero);
    const refusal = admit ? admit() : null;
    if (refusal) return { status: 'refused', refusal };
    const allowReparse = await claimReparse(String(matchId), trace, admitParse);
    const id = keyOf(matchId, key, plan, model);
    if (dispatch) {
      // Queued: the marker says "running" for every instance; the review itself arrives as run({ kind: 'review' }).
      // The task names its model, the default's too: which model runs it must not depend on what the default
      // is on the instance, or at the time, it arrives.
      await write(`${id}.job.json`, { state: 'running', at: now(), steps: [] });
      try { await dispatch({ kind: 'review', matchId: String(matchId), hero: key, lang, ...(plan ? { plan } : {}), ...(idOf(model) ? { model: idOf(model) } : {}), ...(allowReparse ? { reparse: true } : {}) }); return { status: 'running', steps: [] }; } catch (error) { log(`review not queued match=${matchId} hero=${key} (${error?.message ?? 'error'}): running here`); }
    }
    const { job } = await execute(matchId, key, lang, trace, id, { plan, model, allowReparse });
    return { status: 'running', steps: job.steps };
  }
  /**
   * Run the review here. Returns once the job is set up; `done` resolves with how it ended
   * (ready / failed / interrupted). `queued`: the job came from the queue, which delivers it again when this
   * instance is stopped, so a stop leaves it "running" for the next delivery instead of offering a second start.
   */
  async function execute(matchId, key, lang, trace, id, { queued = false, plan = null, model = null, allowReparse = true } = {}) {
    // The model is fixed when the job begins: what it is called upstream is kept with the review and its checkpoint.
    const engine = engineOf(model);
    const maxMs = engine.maxMs ?? REVIEW_MAX_MS;
    const job = { state: 'running', steps: [] };
    const tag = idOf(model) ? ` model=${idOf(model)}` : '';
    jobs.set(id, job);
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    while (jobs.size > MAX_KEPT_JOBS) { const oldest = [...jobs].find(([, j]) => j.state !== 'running'); if (!oldest) break; jobs.delete(oldest[0]); }
    // Marker writes go one after another, in the order they were made (as for a parse): a slow progress
    // write must not land after the terminal one and show a finished or failed review as running.
    let last = Promise.resolve();
    // After `stop` (the instance is going away) nothing may say "running" again; how it ended still may.
    const put = (value) => { last = last.then(() => write(`${id}.job.json`, value)); return last; };
    const mark = (value) => (job.stopped && value.state === 'running' ? last : put(value));
    job.stop = () => {
      job.stopped = true;
      if (job.state !== 'running') return last;
      settle({ status: 'interrupted' });
      // The checkpoint still on its way to the store is what the next start continues from: it is waited for too.
      return Promise.all([put(queued ? { state: 'running', at: now(), steps: [...job.steps] } : { state: 'interrupted', at: now() }), job.flush?.()]);
    };
    await mark({ state: 'running', at: now(), steps: [], runner });
    const began = now();
    const deadline = began + maxMs;
    const jobAbort = new AbortController();
    const deadlineTimer = setTimeout(() => jobAbort.abort(new DOMException('The operation timed out.', 'TimeoutError')), maxMs);
    deadlineTimer.unref?.();
    const beat = setInterval(() => { if (now() - began > maxMs) clearInterval(beat); else if (job.state === 'running') mark({ state: 'running', at: now(), steps: [...job.steps], runner }); }, deps.beatMs ?? REVIEW_BEAT_MS);
    beat.unref?.();
    // Checkpoints are written one at a time, and only the newest one waiting is kept: a slow store never
    // holds the review up, and never writes an older state over a newer one.
    const cpKey = `${id}.checkpoint.json`;
    let cpBusy = null; let cpNext = null; let cpClosed = false;
    const saveCheckpoint = (c) => {
      if (cpClosed) return;
      cpNext = { ...c, at: now(), model: engine.name ?? null };
      cpBusy ??= (async () => { while (cpNext) { const v = cpNext; cpNext = null; await write(cpKey, v); } cpBusy = null; })();
    };
    job.flush = () => cpBusy ?? Promise.resolve();
    // The review is over (it is stored, or it failed): nothing may be continued from. Not on a stop: that is what a checkpoint is for.
    const endCheckpoint = async () => { cpClosed = true; cpNext = null; await cpBusy; await drop(cpKey); };
    (async () => {
      const failed = async (reason) => { job.state = 'failed'; job.reason = reason; job.at = now(); await mark({ state: 'failed', reason, at: now() }); if (!job.stopped) await endCheckpoint(); settle({ status: 'failed', reason }); };
      try {
        const saved = await read(cpKey);
        const checkpoint = saved && saved.model === (engine.name ?? null) && now() - (saved.at ?? 0) < CHECKPOINT_MAX_MS ? saved : null;
        // A fresh review on an older trace upgrades the trace first when the replay is still kept; if the replay is
        // gone or fails to download, the existing trace is kept as-is ("unknown" for missing fields). Never upgrade
        // mid-checkpoint: a checkpoint's lookups were computed on `trace`. Re-parse + model run share `maxMs`.
        const activeTrace = checkpoint ? trace : await upgradeOutdatedTrace(matchId, trace, { allowStart: allowReparse, signal: jobAbort.signal });
        const match = await raceSignal(matchOf(matchId), jobAbort.signal);
        const remainingMs = deadline - now();
        if (jobAbort.signal.aborted || remainingMs <= 0) {
          throw jobAbort.signal.reason ?? new DOMException('The operation timed out.', 'TimeoutError');
        }
        const out = await runDeepReview({
          complete: engine.complete, trace: activeTrace, hero: key, lang, plan, match,
          signal: AbortSignal.any([jobAbort.signal, AbortSignal.timeout(remainingMs)]),
          checkpoint, onCheckpoint: saveCheckpoint,
          onEvent: (e) => {
            if (e.type === 'tool_start') { job.steps.push({ tool: e.name, args: e.args }); mark({ state: 'running', at: now(), steps: [...job.steps], runner }); }
            // Continued from a checkpoint: the reader sees the lookups already made, and the log says so.
            if (e.type === 'resumed') { job.steps.push(...e.tools.map((t) => ({ tool: t.name, args: t.args }))); mark({ state: 'running', at: now(), steps: [...job.steps], runner }); log(`deep-review resumed match=${matchId} hero=${key} plan=${plan ?? 'none'}${tag} after ${e.tools.length} lookups`); }
          },
        });
        // What the check removed and why, beside the review — also when it removed everything: a dropped finding is otherwise gone without a trace.
        if (out.verification?.problems?.length) await write(`${id}.unverified.json`, { at: now(), status: out.status, problems: out.verification.problems, dropped_findings: out.dropped_findings ?? [] });
        if (out.status !== 'ok') { await failed(out.status); log(`deep-review failed match=${matchId} hero=${key} plan=${plan ?? 'none'}${tag} reason=${out.status}`); return; }
        const existing = await read(`${id}.review.json`);
        const priorReviews = existing?.reviews && typeof existing.reviews === 'object' ? cleanReviewsMap(existing.reviews) : {};
        const reviews = { ...priorReviews, ...(out.reviews ?? { [normalizeUiLang(lang)]: out.review }) };
        const result = { schema: 'dota2.ai/deep-review-bundle@1', primary_lang: normalizeUiLang(lang), review: out.review, reviews, verification: { repaired: out.verification.repaired, dropped: out.verification.dropped }, model: engine.name ?? null, tool_calls: out.tool_calls.length };
        // Saved before it is announced, so "ready" always means it survives a restart (when a store is set).
        await write(`${id}.review.json`, result);
        await endCheckpoint();
        job.result = result; job.state = 'ready';
        await mark({ state: 'done', at: now() });
        settle({ status: 'ready' });
        log(`deep-review ready match=${matchId} hero=${key} plan=${plan ?? 'none'}${tag} steps=${out.steps} in=${out.usage.input} out=${out.usage.output} dropped=${out.verification.dropped} unverified=${out.verification.problems.map((p) => `${p.where}${p.index + 1}:${p.kind}`).join(',') || 'none'} langs=${Object.keys(reviews).join(',')}`);
      } catch (error) {
        // Why, as far as the status and the error's name say: "Error" alone could not tell an empty account from a timeout.
        const why = reviewFailure(error);
        const failedAt = now();
        if (MODEL_DOWN_REASONS.has(why.reason)) modelDown.set(idOf(model) ?? '', { reason: why.reason, at: failedAt, until: failedAt + MODEL_DOWN_MS });
        // Logged before the job is marked failed: the line must be there by the time anybody sees "failed".
        log(`deep-review error match=${matchId} hero=${key} plan=${plan ?? 'none'}${tag}: reason=${why.reason}${why.status != null ? ` status=${why.status}` : ''} (${error?.constructor?.name ?? error?.name ?? 'error'})`);
        await failed(why.reason);
      } finally { clearInterval(beat); clearTimeout(deadlineTimer); }
    })();
    return { job, done };
  }

  /**
   * Do a queued parse or review, and answer when it is over (tasks.js: the request that carries the task
   * lasts as long as the work). Never throws.
   * - ready / failed / gone / unavailable / invalid: nothing more to do; the queue is told so.
   * - busy (already running here, or another runner reported on it within REVIEW_BUSY_MS) and interrupted
   *   (this instance is stopping): the queue should deliver the task again.
   * @param {{ kind?: string, matchId?: string | number, hero?: string, lang?: string, plan?: string, model?: string }} task
   */
  const delivering = new Set();
  async function run(task) {
    const matchId = String(task?.matchId ?? '');
    if (!/^[1-9]\d{0,12}$/.test(matchId)) return { status: 'invalid' };
    if (task.kind !== 'parse' && (task.kind !== 'review' || typeof task.hero !== 'string')) return { status: 'invalid' };
    const lang = normalizeUiLang(task.lang);
    // A plan that is none of the known ones is a task this service did not send.
    const plan = planKey(task.plan);
    if (task.plan != null && !plan) return { status: 'invalid' };
    // So is a model not offered here: the task is dropped, never run by another model in its place.
    const model = task.kind === 'review' ? modelOf(task.model) : null;
    if (model === false) return { status: 'invalid' };
    // Taken before the first await and held until the work is over: two deliveries of one job overlapping on
    // this instance cannot both find nothing running and both begin.
    const claim = task.kind === 'parse' ? `parse|${matchId}` : `review|${matchId}|${task.hero.trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_')}|${plan ?? ''}|${model ?? ''}`;
    if (delivering.has(claim)) return { status: 'busy' };
    delivering.add(claim);
    try {
      if (task.kind === 'parse') {
        const existing = await traces.get(matchId);
        if (existing && !(await shouldReparseTrace(matchId, existing))) return { status: 'ready' };
        if (!pipeline) return existing ? { status: 'ready' } : { status: 'unavailable' };
        const marker = await read(`${matchId}.parse.json`);
        if (marker?.state === 'running' && marker.runner && marker.runner !== runner && now() - (marker.at ?? 0) < BUSY_MS) return { status: 'busy' };
        // Looked at last, with no await before the job is registered: a background start here in the meantime is seen.
        if (parses.get(matchId)?.state === 'running') return { status: 'busy' };
        return await (await executeParse(matchId, { queued: true })).done;
      }
      const { trace, key } = await seatOf(matchId, task.hero);
      if (!trace || !key) return { status: 'gone' };
      if (!engineOf(model)) return { status: 'unavailable' };
      const id = keyOf(matchId, key, plan, model);
      if (await stored(matchId, key, lang, plan, model)) return { status: 'ready' };
      const marker = await read(`${id}.job.json`);
      if (marker?.state === 'running' && marker.runner && marker.runner !== runner && now() - (marker.at ?? 0) < REVIEW_BUSY_MS) return { status: 'busy' };
      // Looked at last, with no await before the job is registered: a background start here in the meantime is seen.
      if (jobs.get(id)?.state === 'running') return { status: 'busy' };
      return await (await execute(matchId, key, lang, trace, id, { queued: true, plan, model, allowReparse: task.reparse === true })).done;
    } finally { delivering.delete(claim); }
  }

  /** One chat turn. `onEvent` gets the tool steps as they happen. */
  async function chat({ matchId, hero, lang, plan = null, model = null, question, history, signal, onEvent }) {
    const { trace, key } = await seatOf(matchId, hero);
    if (!trace) return { status: 'no_trace' };
    if (!key) return { status: 'unknown_hero' };
    // The model that wrote the review on screen also answers the questions about it.
    const m = modelOf(model);
    const engine = m === false ? null : engineOf(m);
    if (!engine) return { status: 'unavailable' };
    // The conversation is about the review the reader is looking at: the one made for their plan, if they named one.
    const L = normalizeUiLang(lang);
    const p = planKey(plan);
    const ready = jobs.get(keyOf(matchId, key, p, m));
    const memReview = ready?.state === 'ready' ? (ready.result.reviews?.[L] ?? (ready.result.review?.lang === L ? ready.result.review : null)) : null;
    const review = memReview ?? (await stored(matchId, key, L, p, m))?.review ?? null;
    return runChat({ complete: engine.complete, trace, hero: key, lang: L, plan: p, match: await matchOf(matchId), review, question, history, signal, onEvent });
  }

  /** The tool record behind a ref, recomputed from the trace, with display names. */
  async function evidence(matchId, hero, lang, ref) {
    const { trace, key } = await seatOf(matchId, hero);
    if (!trace) return { status: 'no_trace' };
    if (!key) return { status: 'unknown_hero' };
    const out = resolveRef(trace, ref, { hero: key, lang, match: await matchOf(matchId) });
    return out ? { status: 'ok', ...out } : { status: 'unknown_ref' };
  }

  /** Where the ten heroes were around a game time (lib/agent/moment.js), with display names: what the page replays. */
  async function moment(matchId, hero, lang, t, to = null) {
    const { trace, key } = await seatOf(matchId, hero);
    if (!trace) return { status: 'no_trace' };
    if (!key) return { status: 'unknown_hero' };
    const out = momentFrames(trace, { hero: key, t, ...(to != null ? { to } : {}) });
    if (out.error) return { status: out.error };
    // The game's own name for each hero ("queenofpain"), which is what its minimap icon is filed under; left out for a hero the table does not know.
    const icons = Object.fromEntries(out.heroes.map((h) => [h.hero, heroByKey(h.hero)?.internalSlug]).filter(([, slug]) => typeof slug === 'string' && slug));
    // Each cast says whether it is its hero's ultimate (the ability data), and every ability gets its name in the reader's language.
    const casts = out.casts ? out.casts.map((c) => ({ ...c, ...(isUltimate(c.ability) ? { ultimate: true } : {}) })) : null;
    return { status: 'ok', names: namesIn([...out.heroes.map((h) => h.hero), ...(casts ?? []).map((c) => c.ability)], lang), icons, place_name: out.place ? placeNames(lang)[out.place] ?? null : null, ...out, casts };
  }

  /**
   * A reader's word on one finding of the review they are looking at (lib/agent/feedback.js). Taken only for a
   * review that is stored, and only for the finding that stands in that place in it: the record copies the
   * finding's title and refs from the review, not from the request. The request names the prompt version of the
   * review the reader saw: a word on a review of another version is refused (stale), never kept under this one.
   * @param {string | number} matchId
   * @param {string} hero
   * @param {string} lang
   * @param {{ plan?: string | null, model?: string | null, value: { version: number, finding: number, title: string, rating: string, reason: string | null, id: string } }} o
   */
  async function feedback(matchId, hero, lang, o) {
    const { plan = null, model = null, value } = o;
    if (!deps.feedback) return { status: 'unavailable' };
    if (value.version !== DEEP_REVIEW_PROMPT_VERSION) return { status: 'stale' };
    const m = modelOf(model);
    if (m === false) return { status: 'unavailable', reason: 'model_not_offered' };
    const L = normalizeUiLang(lang);
    const p = planKey(plan);
    const key = heroKeyOf(hero);
    const id = keyOf(matchId, key, p, m);
    const fbKeyPrefix = legacyKeyOf(matchId, key, L, p, m);
    const job = jobs.get(id);
    const memReview = job?.state === 'ready' ? (job.result.reviews?.[L] ?? (job.result.review?.lang === L ? job.result.review : null)) : null;
    const rev = memReview ?? (await stored(matchId, key, L, p, m))?.review ?? null;
    if (!rev) return { status: 'no_review' };
    const record = feedbackRecord({ matchId, hero: key, lang: L, plan: p, model: idOf(m), promptVersion: DEEP_REVIEW_PROMPT_VERSION, review: rev, value, at: now() });
    if (record.error) return { status: record.error };
    try { await deps.feedback.put(feedbackKey(fbKeyPrefix, value), record); } catch { log(`feedback not saved match=${matchId} hero=${key}`); return { status: 'unavailable' }; }
    log(`feedback match=${matchId} hero=${key} p${DEEP_REVIEW_PROMPT_VERSION} finding=${value.finding + 1}/${record.finding.of} ${value.rating}${value.reason ? `:${value.reason}` : ''}`);
    return { status: 'ok' };
  }

  /**
   * The instance is going away: every review and parse still running here is marked interrupted, so another
   * instance offers to start it again at once instead of reporting "running" for a job nobody is doing. One that
   * came from the queue stays "running" and its run() answers "interrupted": the queue delivers it again.
   */
  async function shutdown() {
    await Promise.all([...[...jobs.values()].filter((j) => j.state === 'running' && j.stop).map((j) => j.stop()), ...[...parseStops.values()].map((stop) => stop())]);
  }

  return { availability, prepare, status, lastFailure, peek, start, run, chat, evidence, moment, feedback, shutdown, modelOf, idOf };
}
