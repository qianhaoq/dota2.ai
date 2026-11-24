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
 * - `dispatch` (optional, tasks.js) hands a started parse or review to a queue;
 *   it comes back as `run(task)`, which does the work and answers when it is
 *   over, so the request that carries it lasts as long as the job. Without
 *   `dispatch`, or when queueing fails, the job runs in the background of the
 *   instance that started it, as before.
 */
import { DEEP_REVIEW_PROMPT_VERSION, runDeepReview } from './deepReview.js';
import { runChat } from './chat.js';
import { resolveRef } from './evidence.js';
import { createFileStore, createJsonStore, createTraceStore } from './stores.js';
import { STATIC_HEROES } from '../../packages/review-engine/src/staticHeroes.js';

const HERO_BY_SLUG = new Map(Object.values(STATIC_HEROES).map((h) => [h.internalSlug, h]));
const MAX_KEPT_JOBS = 200;
/** A marker older than this belongs to a job that died with its instance. */
const PARSE_STALE_MS = 15 * 60_000;
/**
 * A running review says so again every REVIEW_BEAT_MS, also while the model is thinking, so one that died with
 * its instance (a deploy, a crash) is seen as gone after REVIEW_STALE_MS rather than after the longest a model
 * turn may take. The page then starts it again by itself.
 */
const REVIEW_BEAT_MS = 15_000;
const REVIEW_STALE_MS = 90_000;
/** A queued review does not start beside one another runner reported on this recently (three beats). */
const REVIEW_BUSY_MS = 45_000;
/** A review still going after this is given up: the model call is cancelled and the job stops reporting in. */
const REVIEW_MAX_MS = 15 * 60_000;
/** A failed parse may be tried again after this (a replay can appear late; a worker can recover). */
const PARSE_RETRY_MS = 5 * 60_000;
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
 *   complete: Function | null,
 *   model?: string | null,
 *   pipeline?: { run: (matchId: number | string, o?: { onStage?: (stage: string) => void }) => Promise<{ ok: boolean, reason?: string }> } | null,
 *   getMatchDetail?: (id: number) => Promise<any>,
 *   docs?: { get: (key: string) => Promise<any>, put: (key: string, value: any) => Promise<void> } | null,
 *   reviewDir?: string | null,
 *   beatMs?: number,
 *   dispatch?: ((task: { kind: 'parse' | 'review', matchId: string, hero?: string, lang?: string }) => Promise<void>) | null,
 *   now?: () => number,
 *   log?: (msg: string) => void,
 * }} deps
 */
export function createAgentService(deps) {
  const { traces, complete } = deps;
  const pipeline = deps.pipeline ?? null;
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
  const keyOf = (matchId, hero, lang) => `${matchId}.${hero}.${lang}.p${DEEP_REVIEW_PROMPT_VERSION}`;
  const read = async (key) => { try { return docs ? await docs.get(key) : null; } catch { return null; } };
  const write = async (key, value) => { try { if (docs) await docs.put(key, value); } catch { log(`agent doc not saved key=${key}`); } };

  /** The scoreboard-level match, best effort: the review works without it. */
  async function matchOf(matchId) {
    if (!deps.getMatchDetail) return null;
    try { return await deps.getMatchDetail(Number(matchId)); } catch { return null; }
  }

  async function seatOf(matchId, hero) {
    const trace = await traces.get(matchId);
    if (!trace) return { trace: null, key: null };
    const k = String(hero ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_');
    return { trace, key: trace.heroes.some((h) => h.key === k) ? k : null };
  }

  const stored = async (key) => { const r = await read(`${key}.review.json`); return r?.review?.schema ? r : null; };

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
    if (job.state === 'running') return age < PARSE_STALE_MS ? { status: 'running', stage: job.stage ?? null } : { status: 'none' };
    if (job.state === 'failed') return FINAL_REASONS.has(job.reason) || age < PARSE_RETRY_MS ? { status: 'failed', reason: job.reason, final: FINAL_REASONS.has(job.reason) } : { status: 'none' };
    return { status: 'none' };
  }

  /** What exists for this match: the heroes a review can be made for, or how far the replay is. */
  async function availability(matchId) {
    const trace = await traces.get(matchId);
    const base = { model_configured: Boolean(complete), can_parse: Boolean(pipeline) };
    if (trace) return { trace: true, ...base, heroes: trace.heroes.map((h) => ({ hero: h.key, team: h.team === 2 ? 'radiant' : 'dire', hero_id: HERO_BY_SLUG.get(h.key)?.id ?? null, en: HERO_BY_SLUG.get(h.key)?.nameEn ?? h.key, zh: HERO_BY_SLUG.get(h.key)?.nameZh ?? h.key })) };
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
    if (await traces.get(id)) return { status: 'ready' };
    if (!pipeline) return { status: 'unavailable' };
    const state = await parseState(id);
    if (state.status === 'running' || (state.status === 'failed' && state.final)) return state;
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
  /** Parse here. Returns once the job is set up; `done` resolves with how it ended. */
  async function executeParse(id) {
    const job = { state: 'running', stage: 'locating', at: now() };
    parses.set(id, job);
    await write(`${id}.parse.json`, job);
    const done = (async () => {
      // Marker writes go one after another, in the order they were made: a slow "downloading" must not land
      // after "failed" and bring a dead parse back to life for other instances.
      let last = Promise.resolve();
      const mark = (value) => { last = last.then(() => write(`${id}.parse.json`, value)); return last; };
      let out;
      try {
        out = await pipeline.run(id, { onStage: (stage) => { job.stage = stage; job.at = now(); mark({ ...job }); } });
      } catch (error) { log(`parse error match=${id}: ${error?.name ?? 'error'}`); out = { ok: false, reason: 'error' }; }
      if (out.ok) { parses.delete(id); await mark({ state: 'done', at: now() }); log(`parse ready match=${id}`); return { status: 'ready' }; }
      Object.assign(job, { state: 'failed', reason: out.reason ?? 'error', at: now() });
      await mark({ ...job });
      log(`parse failed match=${id} reason=${job.reason}`);
      while (parses.size > MAX_KEPT_JOBS) parses.delete(parses.keys().next().value);
      return { status: 'failed', reason: job.reason };
    })();
    return { job, done };
  }

  async function status(matchId, hero, lang) {
    const { trace, key } = await seatOf(matchId, hero);
    if (!trace) return { status: 'no_trace' };
    if (!key) return { status: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
    const id = keyOf(matchId, key, lang);
    const job = jobs.get(id);
    if (job?.state === 'running') return { status: 'running', steps: job.steps };
    if (job?.state === 'ready') return { ...job.result, status: 'ready' };
    const disk = await stored(id);
    if (disk) { jobs.set(id, { state: 'ready', result: disk }); return { ...disk, status: 'ready' }; }
    // Running on another instance: say so rather than offer a second start. That includes a retry started
    // elsewhere after this instance's own attempt failed: the newer attempt is the one to report.
    const marker = await read(`${id}.job.json`);
    if (marker?.state === 'running' && now() - (marker.at ?? 0) < REVIEW_STALE_MS && (job?.state !== 'failed' || (marker.at ?? 0) >= (job.at ?? 0))) return { status: 'running', steps: marker.steps ?? [] };
    if (job?.state === 'failed') return { status: 'failed', reason: job.reason };
    if (marker?.state === 'failed' && now() - (marker.at ?? 0) < 60_000) return { status: 'failed', reason: marker.reason };
    return { status: 'none' };
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
  function start(matchId, hero, lang, { admit } = {}) {
    const claim = `${matchId}|${String(hero ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_')}|${lang}`;
    const pending = starting.get(claim);
    if (pending) return pending;
    const p = begin(matchId, hero, lang, admit).finally(() => starting.delete(claim));
    starting.set(claim, p);
    return p;
  }
  async function begin(matchId, hero, lang, admit) {
    const current = await status(matchId, hero, lang);
    if (current.status !== 'none' && current.status !== 'failed') return current;
    if (!complete) return { status: 'unavailable', reason: 'model_not_configured' };
    const { trace, key } = await seatOf(matchId, hero);
    const refusal = admit ? admit() : null;
    if (refusal) return { status: 'refused', refusal };
    const id = keyOf(matchId, key, lang);
    if (dispatch) {
      // Queued: the marker says "running" for every instance; the review itself arrives as run({ kind: 'review' }).
      await write(`${id}.job.json`, { state: 'running', at: now(), steps: [] });
      try { await dispatch({ kind: 'review', matchId: String(matchId), hero: key, lang }); return { status: 'running', steps: [] }; } catch (error) { log(`review not queued match=${matchId} hero=${key} (${error?.message ?? 'error'}): running here`); }
    }
    const { job } = await execute(matchId, key, lang, trace, id);
    return { status: 'running', steps: job.steps };
  }
  /**
   * Run the review here. Returns once the job is set up; `done` resolves with how it ended
   * (ready / failed / interrupted). `queued`: the job came from the queue, which delivers it again when this
   * instance is stopped, so a stop leaves it "running" for the next delivery instead of offering a second start.
   */
  async function execute(matchId, key, lang, trace, id, { queued = false } = {}) {
    const job = { state: 'running', steps: [] };
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
      return put(queued ? { state: 'running', at: now(), steps: [...job.steps] } : { state: 'interrupted', at: now() });
    };
    await mark({ state: 'running', at: now(), steps: [], runner });
    const began = now();
    const beat = setInterval(() => { if (now() - began > REVIEW_MAX_MS) clearInterval(beat); else if (job.state === 'running') mark({ state: 'running', at: now(), steps: [...job.steps], runner }); }, deps.beatMs ?? REVIEW_BEAT_MS);
    beat.unref?.();
    (async () => {
      const failed = async (reason) => { job.state = 'failed'; job.reason = reason; job.at = now(); await mark({ state: 'failed', reason, at: now() }); settle({ status: 'failed', reason }); };
      try {
        const out = await runDeepReview({
          complete, trace, hero: key, lang, match: await matchOf(matchId), signal: AbortSignal.timeout(REVIEW_MAX_MS),
          onEvent: (e) => { if (e.type === 'tool_start') { job.steps.push({ tool: e.name, args: e.args }); mark({ state: 'running', at: now(), steps: [...job.steps], runner }); } },
        });
        // What the check removed and why, beside the review — also when it removed everything: a dropped finding is otherwise gone without a trace.
        if (out.verification?.problems?.length) await write(`${id}.unverified.json`, { at: now(), status: out.status, problems: out.verification.problems, dropped_findings: out.dropped_findings ?? [] });
        if (out.status !== 'ok') { await failed(out.status); log(`deep-review failed match=${matchId} hero=${key} reason=${out.status}`); return; }
        const result = { review: out.review, verification: { repaired: out.verification.repaired, dropped: out.verification.dropped }, model: deps.model ?? null, tool_calls: out.tool_calls.length };
        // Saved before it is announced, so "ready" always means it survives a restart (when a store is set).
        await write(`${id}.review.json`, result);
        job.result = result; job.state = 'ready';
        await mark({ state: 'done', at: now() });
        settle({ status: 'ready' });
        log(`deep-review ready match=${matchId} hero=${key} steps=${out.steps} in=${out.usage.input} out=${out.usage.output} dropped=${out.verification.dropped} unverified=${out.verification.problems.map((p) => `${p.where}${p.index + 1}:${p.kind}`).join(',') || 'none'}`);
      } catch (error) {
        await failed('error');
        log(`deep-review error match=${matchId} hero=${key}: ${error?.name ?? 'error'}`);
      } finally { clearInterval(beat); }
    })();
    return { job, done };
  }

  /**
   * Do a queued parse or review, and answer when it is over (tasks.js: the request that carries the task
   * lasts as long as the work). Never throws.
   * - ready / failed / gone / unavailable / invalid: nothing more to do; the queue is told so.
   * - busy (already running here, or another runner reported on it within REVIEW_BUSY_MS) and interrupted
   *   (this instance is stopping): the queue should deliver the task again.
   * @param {{ kind?: string, matchId?: string | number, hero?: string, lang?: string }} task
   */
  async function run(task) {
    const matchId = String(task?.matchId ?? '');
    if (!/^[1-9]\d{0,12}$/.test(matchId)) return { status: 'invalid' };
    if (task.kind === 'parse') {
      if (await traces.get(matchId)) return { status: 'ready' };
      if (!pipeline) return { status: 'unavailable' };
      if (parses.get(matchId)?.state === 'running') return { status: 'busy' };
      return (await executeParse(matchId)).done;
    }
    if (task.kind !== 'review' || typeof task.hero !== 'string') return { status: 'invalid' };
    const lang = task.lang === 'zh' ? 'zh' : 'en';
    const { trace, key } = await seatOf(matchId, task.hero);
    if (!trace || !key) return { status: 'gone' };
    if (!complete) return { status: 'unavailable' };
    const id = keyOf(matchId, key, lang);
    if (jobs.get(id)?.state === 'running') return { status: 'busy' };
    if (await stored(id)) return { status: 'ready' };
    const marker = await read(`${id}.job.json`);
    if (marker?.state === 'running' && marker.runner && marker.runner !== runner && now() - (marker.at ?? 0) < REVIEW_BUSY_MS) return { status: 'busy' };
    return (await execute(matchId, key, lang, trace, id, { queued: true })).done;
  }

  /** One chat turn. `onEvent` gets the tool steps as they happen. */
  async function chat({ matchId, hero, lang, question, history, signal, onEvent }) {
    const { trace, key } = await seatOf(matchId, hero);
    if (!trace) return { status: 'no_trace' };
    if (!key) return { status: 'unknown_hero' };
    if (!complete) return { status: 'unavailable' };
    const ready = jobs.get(keyOf(matchId, key, lang));
    const review = ready?.state === 'ready' ? ready.result.review : (await stored(keyOf(matchId, key, lang)))?.review ?? null;
    return runChat({ complete, trace, hero: key, lang, match: await matchOf(matchId), review, question, history, signal, onEvent });
  }

  /** The tool record behind a ref, recomputed from the trace, with display names. */
  async function evidence(matchId, hero, lang, ref) {
    const { trace, key } = await seatOf(matchId, hero);
    if (!trace) return { status: 'no_trace' };
    if (!key) return { status: 'unknown_hero' };
    const out = resolveRef(trace, ref, { hero: key, lang, match: await matchOf(matchId) });
    return out ? { status: 'ok', ...out } : { status: 'unknown_ref' };
  }

  /**
   * The instance is going away: every review still running here is marked interrupted, so another instance
   * offers to start it again at once instead of reporting "running" for a job nobody is doing. One that came
   * from the queue stays "running" and its run() answers "interrupted": the queue delivers it again.
   */
  async function shutdown() {
    await Promise.all([...jobs.values()].filter((j) => j.state === 'running' && j.stop).map((j) => j.stop()));
  }

  return { availability, prepare, status, start, run, chat, evidence, shutdown };
}
