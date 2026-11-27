/**
 * HTTP surface of the review agent.
 *
 *   GET  /api/agent/:matchId                    is there a replay trace (for which heroes), or how far the parse is
 *   POST /api/agent/:matchId/prepare            start parsing the replay into a trace (202)
 *   (review and chat also take `model`: one of the ids the first route lists; none means the default)
 *   GET  /api/agent/:matchId/review?hero=&lang= none | running (+ tool steps) | ready (+ review) | failed | no_trace
 *   GET  /api/agent/:matchId/evidence?hero=&ref= the tool record behind a ref (what an evidence card shows)
 *   GET  /api/agent/:matchId/moment?hero=&t=    where the ten heroes were around a game time (what the page replays)
 *   POST /api/agent/:matchId/review  {hero,lang} start the deep review (202), or the state it is already in
 *   POST /api/agent/:matchId/chat    {hero,lang,question,history}  SSE: {step} … {text, unverified?} {done}
 *   POST /api/agent/:matchId/feedback {hero,lang,version,finding,title,rating,reason?,id}  a reader's word on one finding
 *                                    of the stored review: right | wrong | useless (feedback.js). No model call.
 *   POST /internal/agent/run         {kind,matchId,hero?,lang?}    a queued parse or review, done inside this
 *                                    request (tasks.js). Only with `runAuth`, and only for a caller it accepts.
 *
 * Starting a review and each chat turn call a model: both pass the
 * same-origin guard, a per-caller limit and the shared LLM budget. Reads are
 * only rate limited. All IO is injected.
 */
import express from 'express';
import { asyncHandler } from '../asyncHandler.js';
import { createSlidingWindowLimiter } from '../rateLimiter.js';
import { rateLimitKey } from '../rateLimitKey.js';
import { parseChatBody } from './chat.js';
import { parseFeedback } from './feedback.js';
import { createSlots } from './slots.js';
import { RUN_PATH } from './tasks.js';
import { planKey } from './plans.js';
import { DEFAULT_AGENT_MODEL } from './models.js';
import { normalizeUiLang } from '../aiLanguage.js';

const MATCH_ID = /^[1-9]\d{0,12}$/;
/**
 * Said with every refusal to start a review or answer on this site's model: the ways to run the same coach on a
 * model of the reader's own, which do not wait on this site's budget (packages/dsh; an agent over MCP or the CLI).
 */
export const ALTERNATIVES = Object.freeze([
  Object.freeze({ id: 'dsh', url: 'https://dota2.ai/#ways-dsh' }),
  Object.freeze({ id: 'agent', url: 'https://dota2.ai/#ways' }),
]);
const heroOf = (v) => (typeof v === 'string' && /^[A-Za-z][A-Za-z _-]{0,39}$/.test(v.trim()) ? v.trim() : null);
const langOf = (v) => normalizeUiLang(v);
/** The plan a request names: a known one, none (null), or `false` for a value that is no plan — refused, not ignored. */
const planOfRequest = (v) => (v == null || v === '' ? null : planKey(v) ?? false);

/**
 * @param {{
 *   service: { availability: Function, prepare: Function, status: Function, start: Function, chat: Function, evidence: Function, moment: Function, feedback?: Function, run?: Function },
 *   runAuth?: ((req: object) => Promise<boolean>) | null,
 *   resolveClientIp: (req: object) => string,
 *   guard?: (req: object) => { ok: true } | { ok: false, status: number, error: string },
 *   llm?: { acquire: (req: object) => { ok: boolean, reason?: string, retryAfterSec?: number } },
 *   readLimiter?: { tryConsume: Function }, reviewLimiter?: { tryConsume: Function }, chatLimiter?: { tryConsume: Function }, parseLimiter?: { tryConsume: Function },
 *   parseDailyMax?: number,
 *   reviewDailyMax?: number, reviewHourlyMax?: number,
 *   chatDaily?: { full: Function, retryAfterSec: Function, tryConsume: Function },
 *   feedbackLimiter?: { tryConsume: Function }, feedbackDailyMax?: number,
 *   modelHourlyMax?: number,
 *   log?: (msg: string) => void,
 * }} deps
 */
export function createAgentRouter(deps) {
  const { service, resolveClientIp } = deps;
  const log = deps.log ?? (() => {});
  const readLimiter = deps.readLimiter ?? createSlidingWindowLimiter({ limit: 60, globalLimit: 2400, windowMs: 60_000 });
  // A deep review is a few hundred thousand tokens: five per caller per ten minutes (a new reader tries a few
  // of their games at once), sixty an hour overall.
  const reviewLimiter = deps.reviewLimiter ?? createSlots({ limit: 5, windowMs: 600_000 });
  const reviewGlobal = createSlots({ limit: deps.reviewHourlyMax ?? 60, windowMs: 3_600_000 });
  // And a daily ceiling on what this site pays for at all: past it the reader is pointed at the ways to run the
  // same review on a model of their own (the DSH plugin, an agent over MCP), which cost this site nothing.
  const reviewDaily = createSlots({ limit: deps.reviewDailyMax ?? 250, windowMs: 86_400_000 });
  // Each model other than models.js's first has its own hourly ceiling as well (keyed by its id): they are priced
  // differently, and one of them must not be able to take the whole hour's reviews. By what the model is: one
  // that is this server's default keeps its ceiling.
  const modelGlobal = createSlots({ limit: deps.modelHourlyMax ?? 20, windowMs: 3_600_000 });
  /** `model`: what modelOfRequest gave (null: the default here). The id its ceiling is kept under, or null for none. */
  const ceilingOf = (model) => { const id = service.idOf ? service.idOf(model) : model; return id && id !== DEFAULT_AGENT_MODEL ? id : null; };
  /**
   * The model a request names: null (none, or the default by name), the id of another model offered here, or
   * `false` — refused, not ignored: a review is never written by a model the reader did not ask for.
   */
  const modelOfRequest = (v) => (v == null || v === '' ? null : typeof v === 'string' && service.modelOf ? service.modelOf(v) : false);
  const chatLimiter = deps.chatLimiter ?? createSlots({ limit: 12, windowMs: 60_000 });
  const chatGlobal = createSlots({ limit: 600, windowMs: 60_000 });
  // A day's follow-up answers on this site's model. server.js passes one counter shared with the coach's and the
  // patch advisor's answers.
  const chatDaily = deps.chatDaily ?? createSlots({ limit: 2000, windowMs: 86_400_000 });
  // A parse downloads ~50 MB and runs the extractor: five per caller per ten minutes, and a daily ceiling overall.
  const parseLimiter = deps.parseLimiter ?? createSlots({ limit: 5, windowMs: 600_000 });
  const parseDaily = createSlots({ limit: deps.parseDailyMax ?? 300, windowMs: 86_400_000 });
  // A word on a finding is one small object written: thirty per caller per ten minutes (a review has three
  // findings, and a mind may change), and a daily ceiling on what is written at all.
  const feedbackLimiter = deps.feedbackLimiter ?? createSlots({ limit: 30, windowMs: 600_000 });
  const feedbackDaily = createSlots({ limit: deps.feedbackDailyMax ?? 5000, windowMs: 86_400_000 });
  const router = express.Router();
  const limited = (res, g) => { res.set('Retry-After', String(g.retryAfterSec)); return res.status(429).json({ code: 'rate_limited', error: 'Too many requests', retryAfterSec: g.retryAfterSec }); };
  const key = (req) => rateLimitKey(resolveClientIp(req));
  /** A request from one of our own browsers or scripts (the X-Dota2ai-Internal header): said in the log line, nothing else changes. */
  const ours = (req) => (req.get?.('x-dota2ai-internal') === '1' ? ' internal' : '');

  /**
   * Admit one request that will call a model, in one synchronous step: look
   * at every limit, then take the model budget, then take the slots. A
   * request refused anywhere leaves nothing reserved — not a review slot when
   * the model budget says no, not model budget when a limit is full.
   * `limits`: [limiter, key, 'caller' | 'all'].
   * Returns null when admitted, else the refusal ({ status, body }) for the
   * caller to answer with: a start shared by several requests is refused to
   * each of them, and each must get its own response.
   */
  function admit(req, limits) {
    const refusal = (kind, retryAfterSec) => (kind === 'caller'
      ? { status: 429, body: { code: 'rate_limited', error: 'Too many requests', retryAfterSec, alternatives: ALTERNATIVES } }
      : kind === 'daily'
        ? { status: 503, body: { code: 'daily_cap', error: "Today's reviews on this site's model are used up", retryAfterSec, alternatives: ALTERNATIVES } }
        : { status: 503, body: { code: 'busy', error: 'At capacity; try again later', retryAfterSec, alternatives: ALTERNATIVES } });
    for (const [limiter, k, kind] of limits) if (limiter.full?.(k)) return refusal(kind, limiter.retryAfterSec?.(k) ?? 60);
    if (deps.llm) {
      const b = deps.llm.acquire(req);
      if (!b.ok) return { status: b.reason === 'cost_guard' ? 503 : 429, body: { code: b.reason === 'cost_guard' ? 'busy' : 'rate_limited', error: 'Model budget reached; try again later', retryAfterSec: b.retryAfterSec ?? 60, alternatives: ALTERNATIVES } };
    }
    for (const [limiter, k, kind] of limits) { const g = limiter.tryConsume(k); if (!g.ok) return refusal(kind, g.retryAfterSec); }
    return null;
  }
  const refuse = (res, r) => { if (r.body?.retryAfterSec) res.set('Retry-After', String(r.body.retryAfterSec)); return res.status(r.status).json(r.body); };

  router.param('matchId', (req, res, next, id) => (MATCH_ID.test(id) ? next() : res.status(400).json({ code: 'invalid_match_id', error: 'Invalid match ID' })));

  // The queue's delivery of a started parse or review. It is answered when the work is over: 200 when there is
  // nothing more to do (done, failed for good, nothing to run), 503 when the queue should deliver it again.
  if (deps.runAuth && service.run) {
    router.post(RUN_PATH, asyncHandler(async (req, res) => {
      if (!(await deps.runAuth(req))) return res.status(403).json({ code: 'forbidden', error: 'Forbidden' });
      let out;
      try { out = await service.run(req.body ?? {}); } catch (error) { log(`run failed kind=${req.body?.kind} match=${req.body?.matchId}: ${error?.name ?? 'error'}`); out = { status: 'interrupted' }; }
      const again = out.status === 'busy' || out.status === 'interrupted';
      log(`run ${req.body?.kind} match=${req.body?.matchId}${req.body?.hero ? ` hero=${req.body.hero}` : ''}${typeof req.body?.model === 'string' ? ` model=${req.body.model.slice(0, 40)}` : ''} -> ${out.status}`);
      if (res.writableEnded || res.destroyed) return undefined;
      return res.status(again ? 503 : 200).json({ status: out.status });
    }));
  }

  router.get('/api/agent/:matchId', asyncHandler(async (req, res) => {
    const g = readLimiter.tryConsume(key(req));
    if (!g.ok) return limited(res, g);
    res.set('Cache-Control', 'no-store');
    return res.json(await service.availability(req.params.matchId));
  }));

  router.get('/api/agent/:matchId/trace', asyncHandler(async (req, res) => {
    const g = readLimiter.tryConsume(key(req));
    if (!g.ok) return limited(res, g);
    const raw = service.traceRaw ? await service.traceRaw(req.params.matchId) : null;
    if (!raw) return res.status(404).json({ code: 'no_trace', error: 'No trace for this match' });
    res.set({ 'Content-Type': 'application/gzip', 'Cache-Control': 'private, max-age=3600' });
    return res.send(raw);
  }));

  function tryAdmitParse(req) {
    if (parseLimiter.full?.(key(req))) return { status: 429, body: { code: 'rate_limited', error: 'Too many requests', retryAfterSec: parseLimiter.retryAfterSec(key(req)) } };
    if (parseDaily.full('all')) return { status: 503, body: { code: 'busy', error: 'Replay parsing is at capacity today', retryAfterSec: parseDaily.retryAfterSec('all') } };
    const g = parseLimiter.tryConsume(key(req));
    if (!g.ok) return { status: 429, body: { code: 'rate_limited', error: 'Too many requests', retryAfterSec: g.retryAfterSec } };
    parseDaily.tryConsume('all');
    return null;
  }

  /**
   * Start this match's parse for the caller of `req`: the one path the page's POST and an agent's tool call
   * share, with the same limits. Returns the HTTP answer as { status, body }; a refusal's body carries
   * `retryAfterSec`. `via`: said in the log line (' mcp').
   */
  async function startParse(req, matchId, via = '') {
    // Already there, already running, or known to be impossible: answer without spending a slot.
    const now = await service.availability(matchId);
    if (now.trace && !now.trace_outdated) return { status: 200, body: { status: 'ready' } };
    if (!now.can_parse) return now.trace ? { status: 200, body: { status: 'ready' } } : { status: 503, body: { status: 'unavailable' } };
    // Already running, or known to be impossible: answer without spending a slot. A failure that may pass
    // (no address yet, a download that broke) can be tried again, within the caller's limit.
    if (now.parse && (now.parse.status === 'running' || (now.parse.status === 'failed' && now.parse.final))) return { status: 200, body: now.parse };
    // Charged inside the parse's claim, and both limits looked at before either is taken: of several requests
    // for the same match arriving together only the one that starts the parse takes a slot, and a full day
    // does not cost the caller one.
    const out = await service.prepare(matchId, { admit: () => tryAdmitParse(req) });
    // Refused: every request that shared this start gets the refusal, each on its own response.
    if (out.status === 'refused') return out.refusal;
    log(`parse start match=${matchId} -> ${out.status}${ours(req)}${via}`);
    return { status: out.status === 'running' ? 202 : 200, body: out };
  }

  /** Start (or find) a review for the caller of `req`: shared by the page's POST and an agent's tool call. Same shape as startParse. */
  async function startReview(req, matchId, hero, lang, plan, model, via = '') {
    // Already running or done: answer without spending anyone's budget.
    const now = await service.status(matchId, hero, lang, plan, model);
    if (now.status !== 'none' && now.status !== 'failed') return { status: now.status === 'no_trace' || now.status === 'unknown_hero' ? 404 : 200, body: now };
    // Nothing is spent on a request that cannot be served: no model, no start.
    if (!(await service.availability(matchId)).model_configured) return { status: 503, body: { status: 'unavailable', reason: 'model_not_configured' } };
    // Charged inside the job's claim: of several requests for the same review arriving together, only the one
    // that creates the job takes a slot and model budget; the others join it for free. An automatic trace
    // upgrade is subject to the same parseLimiter + parseDaily admission as /prepare (#365).
    const out = await service.start(matchId, hero, lang, {
      plan,
      model,
      admit: () => admit(req, [[reviewLimiter, key(req), 'caller'], [reviewGlobal, 'all', 'all'], [reviewDaily, 'all', 'daily'], ...(ceilingOf(model) ? [[modelGlobal, ceilingOf(model), 'all']] : [])]),
      admitParse: () => tryAdmitParse(req),
    });
    // Refused: every request that shared this start gets the refusal, each on its own response.
    if (out.status === 'refused') return out.refusal;
    log(`review start match=${matchId} hero=${hero} plan=${plan ?? 'none'}${model ? ` model=${model}` : ''} -> ${out.status}${ours(req)}${via}`);
    return { status: out.status === 'running' ? 202 : out.status === 'unavailable' ? 503 : 200, body: out };
  }
  /** An answer from startParse / startReview, on the response: a refusal says when to come back. */
  const answer = (res, r) => { if (r.body?.retryAfterSec) res.set('Retry-After', String(r.body.retryAfterSec)); return res.status(r.status).json(r.body); };

  router.post('/api/agent/:matchId/prepare', asyncHandler(async (req, res) => {
    const guard = deps.guard?.(req) ?? { ok: true };
    if (!guard.ok) return res.status(guard.status).json({ code: 'forbidden', error: guard.error });
    return answer(res, await startParse(req, req.params.matchId));
  }));

  router.get('/api/agent/:matchId/review', asyncHandler(async (req, res) => {
    const hero = heroOf(req.query.hero);
    if (!hero) return res.status(400).json({ code: 'invalid_hero', error: 'hero is required' });
    const g = readLimiter.tryConsume(key(req));
    if (!g.ok) return limited(res, g);
    const plan = planOfRequest(req.query.plan);
    if (plan === false) return res.status(400).json({ code: 'invalid_plan', error: 'Unknown plan' });
    const model = modelOfRequest(req.query.model);
    if (model === false) return res.status(400).json({ code: 'invalid_model', error: 'Unknown model' });
    res.set('Cache-Control', 'no-store');
    return res.json(await service.status(req.params.matchId, hero, langOf(req.query.lang), plan, model));
  }));

  router.get('/api/agent/:matchId/evidence', asyncHandler(async (req, res) => {
    const hero = heroOf(req.query.hero);
    const ref = typeof req.query.ref === 'string' ? req.query.ref.slice(0, 120) : '';
    if (!hero || !ref) return res.status(400).json({ code: 'invalid_input', error: 'hero and ref are required' });
    const g = readLimiter.tryConsume(key(req));
    if (!g.ok) return limited(res, g);
    const out = await service.evidence(req.params.matchId, hero, langOf(req.query.lang), ref);
    if (out.status !== 'ok') return res.status(404).json({ code: out.status, error: 'No such evidence' });
    // A record is a pure function of the replay: safe to cache.
    res.set('Cache-Control', 'private, max-age=3600');
    return res.json(out);
  }));

  router.get('/api/agent/:matchId/moment', asyncHandler(async (req, res) => {
    const hero = heroOf(req.query.hero);
    const t = typeof req.query.t === 'string' && /^-?\d{1,6}(\.\d{1,3})?$/.test(req.query.t) ? Number(req.query.t) : NaN;
    const hasTo = req.query.to != null && req.query.to !== '';
    const to = hasTo ? (typeof req.query.to === 'string' && /^-?\d{1,6}(\.\d{1,3})?$/.test(req.query.to) ? Number(req.query.to) : NaN) : null;
    if (!hero || !Number.isFinite(t) || (hasTo && (!Number.isFinite(to) || to < t))) {
      return res.status(400).json({ code: 'invalid_input', error: 'hero and t (game seconds, with optional to >= t) are required' });
    }
    const g = readLimiter.tryConsume(key(req));
    if (!g.ok) return limited(res, g);
    const out = await service.moment(req.params.matchId, hero, langOf(req.query.lang), t, to);
    if (out.status !== 'ok') return res.status(404).json({ code: out.status, error: 'No such moment' });
    // Positions are a pure function of the replay: safe to cache.
    res.set('Cache-Control', 'private, max-age=3600');
    return res.json(out);
  }));

  router.post('/api/agent/:matchId/review', asyncHandler(async (req, res) => {
    const guard = deps.guard?.(req) ?? { ok: true };
    if (!guard.ok) return res.status(guard.status).json({ code: 'forbidden', error: guard.error });
    const hero = heroOf(req.body?.hero);
    if (!hero) return res.status(400).json({ code: 'invalid_hero', error: 'hero is required' });
    const lang = langOf(req.body?.lang);
    const plan = planOfRequest(req.body?.plan);
    if (plan === false) return res.status(400).json({ code: 'invalid_plan', error: 'Unknown plan' });
    const model = modelOfRequest(req.body?.model);
    if (model === false) return res.status(400).json({ code: 'invalid_model', error: 'Unknown model' });
    return answer(res, await startReview(req, req.params.matchId, hero, lang, plan, model));
  }));

  router.post('/api/agent/:matchId/feedback', asyncHandler(async (req, res) => {
    const guard = deps.guard?.(req) ?? { ok: true };
    if (!guard.ok) return res.status(guard.status).json({ code: 'forbidden', error: guard.error });
    const hero = heroOf(req.body?.hero);
    const value = parseFeedback(req.body);
    if (!hero || !value) return res.status(400).json({ code: 'invalid_input', error: 'hero, version, finding, title, rating and id are required; reason must belong to the rating' });
    const plan = planOfRequest(req.body?.plan);
    if (plan === false) return res.status(400).json({ code: 'invalid_plan', error: 'Unknown plan' });
    const model = modelOfRequest(req.body?.model);
    if (model === false) return res.status(400).json({ code: 'invalid_model', error: 'Unknown model' });
    if (!service.feedback) return res.status(503).json({ code: 'unavailable', error: 'Feedback is not kept here' });
    // The day's ceiling is looked at before the caller is charged, and taken only for a request that was let in.
    if (feedbackDaily.full('all')) { const retryAfterSec = feedbackDaily.retryAfterSec('all') ?? 3600; res.set('Retry-After', String(retryAfterSec)); return res.status(503).json({ code: 'busy', error: 'At capacity; try again later', retryAfterSec }); }
    const g = feedbackLimiter.tryConsume(key(req));
    if (!g.ok) return limited(res, g);
    feedbackDaily.tryConsume('all');
    const out = await service.feedback(req.params.matchId, hero, langOf(req.body?.lang), { plan, model, value });
    if (out.status === 'ok') return res.json({ status: 'ok' });
    if (out.status === 'unavailable') return res.status(503).json({ code: 'unavailable', error: 'Feedback could not be kept' });
    // No such review, no such finding in it, or another finding stands there now: nothing is written.
    return res.status(404).json({ code: out.status, error: 'No such finding to speak of' });
  }));

  router.post('/api/agent/:matchId/chat', asyncHandler(async (req, res) => {
    const guard = deps.guard?.(req) ?? { ok: true };
    if (!guard.ok) return res.status(guard.status).json({ code: 'forbidden', error: guard.error });
    const body = parseChatBody(req.body);
    if (body.error) return res.status(400).json({ code: body.error, error: 'Invalid chat request' });
    if (!heroOf(body.hero)) return res.status(400).json({ code: 'invalid_hero', error: 'hero is required' });
    const model = modelOfRequest(body.model);
    if (model === false) return res.status(400).json({ code: 'invalid_model', error: 'Unknown model' });
    // Listen for the caller leaving before the first await: one who is gone by the time the trace is read
    // must not be admitted, and a paid investigation must not run for a closed connection.
    const ac = new AbortController();
    let gone = false;
    res.on('close', () => { if (!res.writableEnded) { gone = true; ac.abort(); } });
    // Nothing is spent on a turn that cannot be answered: no replay trace, a hero not in it, no model.
    const avail = await service.availability(req.params.matchId);
    if (gone) return undefined;
    const cannot = !avail.trace ? 'no_trace' : !avail.heroes.some((h) => h.hero === body.hero.trim().toLowerCase().replace(/[\s-]+/g, '_')) ? 'unknown_hero' : !avail.model_configured ? 'unavailable' : null;
    if (cannot) {
      res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
      res.write(`data: ${JSON.stringify({ error: cannot })}\n\ndata: ${JSON.stringify({ done: true })}\n\n`);
      return res.end();
    }
    const no = admit(req, [[chatLimiter, key(req), 'caller'], [chatGlobal, 'all', 'all'], [chatDaily, 'all', 'daily']]);
    if (no) return refuse(res, no);
    res.status(200);
    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    const send = (obj) => { if (!gone && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
    try {
      const out = await service.chat({
        matchId: req.params.matchId, hero: body.hero, lang: body.lang, plan: body.plan, model, question: body.question, history: body.history, signal: ac.signal,
        onEvent: (e) => { if (e.type === 'tool_start') send({ step: { tool: e.name, args: e.args } }); },
      });
      if (out.status === 'ok') send({ text: out.text, ...(out.unverified.length ? { unverified: out.unverified } : {}) });
      else send({ error: out.status });
      // One line per turn: how it went, never what was asked.
      log(`chat match=${req.params.matchId} hero=${body.hero} plan=${body.plan ?? 'none'}${model ? ` model=${model}` : ''} -> ${out.status} tools=${out.tool_calls?.length ?? 0} in=${out.usage?.input ?? 0} out=${out.usage?.output ?? 0} unverified=${out.unverified?.length ?? 0}`);
    } catch (error) {
      if (!gone) { log(`chat failed match=${req.params.matchId}: ${error?.name ?? 'error'}`); send({ error: 'failed' }); }
    }
    send({ done: true });
    if (!res.writableEnded) res.end();
    return undefined;
  }));

  /**
   * The same review for an agent's tool call (MCP replay_review), as the caller of `req`: its reads count on
   * the read limit, its starts on the same parse and review limits and model budget as the page's. There is
   * no same-origin guard: agents are not browsers. Never throws for a bad match id: `MATCH_ID` is checked.
   */
  router.forRequest = (req) => ({
    read: () => readLimiter.tryConsume(key(req)),
    validMatch: (id) => MATCH_ID.test(String(id)),
    availability: (id) => service.availability(String(id)),
    status: (id, hero, lang) => service.status(String(id), hero, langOf(lang), null, null),
    lastFailure: (id, hero, lang) => (service.lastFailure ? service.lastFailure(String(id), hero, langOf(lang), null, null) : Promise.resolve(null)),
    prepare: (id) => startParse(req, String(id), ' mcp'),
    start: (id, hero, lang) => startReview(req, String(id), hero, langOf(lang), null, null, ' mcp'),
  });
  return router;
}
