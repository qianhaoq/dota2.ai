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
 * - `dispatch` (optional, tasks.js) hands a started parse or review to a queue;
 *   it comes back as `run(task)`, which does the work and answers when it is
 *   over, so the request that carries it lasts as long as the job. Without
 *   `dispatch`, or when queueing fails, the job runs in the background of the
 *   instance that started it, as before.
 */
import { DEEP_REVIEW_PROMPT_VERSION, runDeepReview, withoutHandles } from './deepReview.js';
import { runChat } from './chat.js';
import { resolveRef } from './evidence.js';
import { createFileStore, createJsonStore, createTraceStore } from './stores.js';
import { planKey } from './plans.js';
import { goldAdvantage } from '../../packages/review-engine/src/trace/index.js';
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
  // A review made for a plan the player named is its own review: the same game read against what they went for.
  const keyOf = (matchId, hero, lang, plan = null) => `${matchId}.${hero}.${lang}.p${DEEP_REVIEW_PROMPT_VERSION}${plan ? `.plan-${plan}` : ''}`;
  const read = async (key) => { try { return docs ? await docs.get(key) : null; } catch { return null; } };
  const write = async (key, value) => { try { if (docs) await docs.put(key, value); } catch { log(`agent doc not saved key=${key}`); } };
  // Emptied first, then removed: where the store cannot delete, what is left is not a checkpoint any more.
  const drop = async (key) => { await write(key, { v: 0 }); try { await docs?.delete?.(key); } catch { /* emptied above */ } };

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

  // Record handles left in the text of a review stored earlier are taken out on the way: what is stored is not rewritten.
  const stored = async (key) => { const r = await read(`${key}.review.json`); return r?.review?.schema ? { ...r, review: withoutHandles(r.review) } : null; };

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
    if (job.state === 'failed') return FINAL_REASONS.has(job.reason) || age < PARSE_RETRY_MS ? { status: 'failed', reason: job.reason, final: FINAL_REASONS.has(job.reason) } : { status: 'none' };
    return { status: 'none' };
  }

  /** The replay's own lead per minute (net worth summed by team), for a page whose match record has none. */
  const goldOf = (trace) => { const adv = goldAdvantage(trace, {}); return adv ? { radiant_net_worth_lead: adv } : {}; };

  /** What exists for this match: the heroes a review can be made for, or how far the replay is. */
  async function availability(matchId) {
    const trace = await traces.get(matchId);
    const base = { model_configured: Boolean(complete), can_parse: Boolean(pipeline) };
    if (trace) return { trace: true, ...base, heroes: trace.heroes.map((h) => ({ hero: h.key, team: h.team === 2 ? 'radiant' : 'dire', hero_id: HERO_BY_SLUG.get(h.key)?.id ?? null, en: HERO_BY_SLUG.get(h.key)?.nameEn ?? h.key, zh: HERO_BY_SLUG.get(h.key)?.nameZh ?? h.key })) , ...goldOf(trace) };
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
  /** How to hand back each parse running here when the instance is stopped (shutdown). */
  const parseStops = new Map();
  const parseBegan = new WeakMap();
  /**
   * Parse here. Returns once the job is set up; `done` resolves with how it ended (ready / failed / interrupted).
   * `queued`: as for a review — the queue delivers the job again when this instance is stopped, so a stop leaves
   * it "running" for the next delivery.
   */
  async function executeParse(id, { queued = false } = {}) {
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
        out = await pipeline.run(id, { onStage: (stage) => { job.stage = stage; job.at = now(); mark({ ...job, runner }); } });
      } catch (error) { log(`parse error match=${id}: ${error?.name ?? 'error'}`); out = { ok: false, reason: 'error' }; } finally { clearInterval(beat); if (parseStops.get(id) === stop) parseStops.delete(id); }
      if (out.ok) { job.state = 'done'; if (parses.get(id) === job) parses.delete(id); await mark({ state: 'done', at: now() }); log(`parse ready match=${id}`); return { status: 'ready' }; }
      Object.assign(job, { state: 'failed', reason: out.reason ?? 'error', at: now() });
      await mark({ ...job });
      log(`parse failed match=${id} reason=${job.reason}`);
      while (parses.size > MAX_KEPT_JOBS) parses.delete(parses.keys().next().value);
      return { status: 'failed', reason: job.reason };
    })();
    return { job, done: Promise.race([work, interrupted]) };
  }

  async function status(matchId, hero, lang, plan = null) {
    const { trace, key } = await seatOf(matchId, hero);
    if (!trace) return { status: 'no_trace' };
    if (!key) return { status: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
    const id = keyOf(matchId, key, lang, planKey(plan));
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
  function start(matchId, hero, lang, { admit, plan = null } = {}) {
    const claim = `${matchId}|${String(hero ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_')}|${lang}|${planKey(plan) ?? ''}`;
    const pending = starting.get(claim);
    if (pending) return pending;
    const p = begin(matchId, hero, lang, admit, planKey(plan)).finally(() => starting.delete(claim));
    starting.set(claim, p);
    return p;
  }
  async function begin(matchId, hero, lang, admit, plan) {
    const current = await status(matchId, hero, lang, plan);
    if (current.status !== 'none' && current.status !== 'failed') return current;
    if (!complete) return { status: 'unavailable', reason: 'model_not_configured' };
    const { trace, key } = await seatOf(matchId, hero);
    const refusal = admit ? admit() : null;
    if (refusal) return { status: 'refused', refusal };
    const id = keyOf(matchId, key, lang, plan);
    if (dispatch) {
      // Queued: the marker says "running" for every instance; the review itself arrives as run({ kind: 'review' }).
      await write(`${id}.job.json`, { state: 'running', at: now(), steps: [] });
      try { await dispatch({ kind: 'review', matchId: String(matchId), hero: key, lang, ...(plan ? { plan } : {}) }); return { status: 'running', steps: [] }; } catch (error) { log(`review not queued match=${matchId} hero=${key} (${error?.message ?? 'error'}): running here`); }
    }
    const { job } = await execute(matchId, key, lang, trace, id, { plan });
    return { status: 'running', steps: job.steps };
  }
  /**
   * Run the review here. Returns once the job is set up; `done` resolves with how it ended
   * (ready / failed / interrupted). `queued`: the job came from the queue, which delivers it again when this
   * instance is stopped, so a stop leaves it "running" for the next delivery instead of offering a second start.
   */
  async function execute(matchId, key, lang, trace, id, { queued = false, plan = null } = {}) {
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
      // The checkpoint still on its way to the store is what the next start continues from: it is waited for too.
      return Promise.all([put(queued ? { state: 'running', at: now(), steps: [...job.steps] } : { state: 'interrupted', at: now() }), job.flush?.()]);
    };
    await mark({ state: 'running', at: now(), steps: [], runner });
    const began = now();
    const beat = setInterval(() => { if (now() - began > REVIEW_MAX_MS) clearInterval(beat); else if (job.state === 'running') mark({ state: 'running', at: now(), steps: [...job.steps], runner }); }, deps.beatMs ?? REVIEW_BEAT_MS);
    beat.unref?.();
    // Checkpoints are written one at a time, and only the newest one waiting is kept: a slow store never
    // holds the review up, and never writes an older state over a newer one.
    const cpKey = `${id}.checkpoint.json`;
    let cpBusy = null; let cpNext = null; let cpClosed = false;
    const saveCheckpoint = (c) => {
      if (cpClosed) return;
      cpNext = { ...c, at: now(), model: deps.model ?? null };
      cpBusy ??= (async () => { while (cpNext) { const v = cpNext; cpNext = null; await write(cpKey, v); } cpBusy = null; })();
    };
    job.flush = () => cpBusy ?? Promise.resolve();
    // The review is over (it is stored, or it failed): nothing may be continued from. Not on a stop: that is what a checkpoint is for.
    const endCheckpoint = async () => { cpClosed = true; cpNext = null; await cpBusy; await drop(cpKey); };
    (async () => {
      const failed = async (reason) => { job.state = 'failed'; job.reason = reason; job.at = now(); await mark({ state: 'failed', reason, at: now() }); if (!job.stopped) await endCheckpoint(); settle({ status: 'failed', reason }); };
      try {
        const saved = await read(cpKey);
        const checkpoint = saved && saved.model === (deps.model ?? null) && now() - (saved.at ?? 0) < CHECKPOINT_MAX_MS ? saved : null;
        const out = await runDeepReview({
          complete, trace, hero: key, lang, plan, match: await matchOf(matchId), signal: AbortSignal.timeout(REVIEW_MAX_MS),
          checkpoint, onCheckpoint: saveCheckpoint,
          onEvent: (e) => {
            if (e.type === 'tool_start') { job.steps.push({ tool: e.name, args: e.args }); mark({ state: 'running', at: now(), steps: [...job.steps], runner }); }
            // Continued from a checkpoint: the reader sees the lookups already made, and the log says so.
            if (e.type === 'resumed') { job.steps.push(...e.tools.map((t) => ({ tool: t.name, args: t.args }))); mark({ state: 'running', at: now(), steps: [...job.steps], runner }); log(`deep-review resumed match=${matchId} hero=${key} after ${e.tools.length} lookups`); }
          },
        });
        // What the check removed and why, beside the review — also when it removed everything: a dropped finding is otherwise gone without a trace.
        if (out.verification?.problems?.length) await write(`${id}.unverified.json`, { at: now(), status: out.status, problems: out.verification.problems, dropped_findings: out.dropped_findings ?? [] });
        if (out.status !== 'ok') { await failed(out.status); log(`deep-review failed match=${matchId} hero=${key} reason=${out.status}`); return; }
        const result = { review: out.review, verification: { repaired: out.verification.repaired, dropped: out.verification.dropped }, model: deps.model ?? null, tool_calls: out.tool_calls.length };
        // Saved before it is announced, so "ready" always means it survives a restart (when a store is set).
        await write(`${id}.review.json`, result);
        await endCheckpoint();
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
   * @param {{ kind?: string, matchId?: string | number, hero?: string, lang?: string, plan?: string }} task
   */
  const delivering = new Set();
  async function run(task) {
    const matchId = String(task?.matchId ?? '');
    if (!/^[1-9]\d{0,12}$/.test(matchId)) return { status: 'invalid' };
    if (task.kind !== 'parse' && (task.kind !== 'review' || typeof task.hero !== 'string')) return { status: 'invalid' };
    const lang = task.lang === 'zh' ? 'zh' : 'en';
    // A plan that is none of the known ones is a task this service did not send.
    const plan = planKey(task.plan);
    if (task.plan != null && !plan) return { status: 'invalid' };
    // Taken before the first await and held until the work is over: two deliveries of one job overlapping on
    // this instance cannot both find nothing running and both begin.
    const claim = task.kind === 'parse' ? `parse|${matchId}` : `review|${matchId}|${task.hero.trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_')}|${lang}|${plan ?? ''}`;
    if (delivering.has(claim)) return { status: 'busy' };
    delivering.add(claim);
    try {
      if (task.kind === 'parse') {
        if (await traces.get(matchId)) return { status: 'ready' };
        if (!pipeline) return { status: 'unavailable' };
        const marker = await read(`${matchId}.parse.json`);
        if (marker?.state === 'running' && marker.runner && marker.runner !== runner && now() - (marker.at ?? 0) < BUSY_MS) return { status: 'busy' };
        // Looked at last, with no await before the job is registered: a background start here in the meantime is seen.
        if (parses.get(matchId)?.state === 'running') return { status: 'busy' };
        return await (await executeParse(matchId, { queued: true })).done;
      }
      const { trace, key } = await seatOf(matchId, task.hero);
      if (!trace || !key) return { status: 'gone' };
      if (!complete) return { status: 'unavailable' };
      const id = keyOf(matchId, key, lang, plan);
      if (await stored(id)) return { status: 'ready' };
      const marker = await read(`${id}.job.json`);
      if (marker?.state === 'running' && marker.runner && marker.runner !== runner && now() - (marker.at ?? 0) < REVIEW_BUSY_MS) return { status: 'busy' };
      // Looked at last, with no await before the job is registered: a background start here in the meantime is seen.
      if (jobs.get(id)?.state === 'running') return { status: 'busy' };
      return await (await execute(matchId, key, lang, trace, id, { queued: true, plan })).done;
    } finally { delivering.delete(claim); }
  }

  /** One chat turn. `onEvent` gets the tool steps as they happen. */
  async function chat({ matchId, hero, lang, plan = null, question, history, signal, onEvent }) {
    const { trace, key } = await seatOf(matchId, hero);
    if (!trace) return { status: 'no_trace' };
    if (!key) return { status: 'unknown_hero' };
    if (!complete) return { status: 'unavailable' };
    // The conversation is about the review the reader is looking at: the one made for their plan, if they named one.
    const p = planKey(plan);
    const ready = jobs.get(keyOf(matchId, key, lang, p));
    const review = ready?.state === 'ready' ? ready.result.review : (await stored(keyOf(matchId, key, lang, p)))?.review ?? null;
    return runChat({ complete, trace, hero: key, lang, plan: p, match: await matchOf(matchId), review, question, history, signal, onEvent });
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
   * The instance is going away: every review and parse still running here is marked interrupted, so another
   * instance offers to start it again at once instead of reporting "running" for a job nobody is doing. One that
   * came from the queue stays "running" and its run() answers "interrupted": the queue delivers it again.
   */
  async function shutdown() {
    await Promise.all([...[...jobs.values()].filter((j) => j.state === 'running' && j.stop).map((j) => j.stop()), ...[...parseStops.values()].map((stop) => stop())]);
  }

  return { availability, prepare, status, start, run, chat, evidence, shutdown };
}
