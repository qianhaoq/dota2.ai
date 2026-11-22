/**
 * HTTP surface of the review agent.
 *
 *   GET  /api/agent/:matchId                    is there a replay trace (for which heroes), or how far the parse is
 *   POST /api/agent/:matchId/prepare            start parsing the replay into a trace (202)
 *   GET  /api/agent/:matchId/review?hero=&lang= none | running (+ tool steps) | ready (+ review) | failed | no_trace
 *   GET  /api/agent/:matchId/evidence?hero=&ref= the tool record behind a ref (what an evidence card shows)
 *   POST /api/agent/:matchId/review  {hero,lang} start the deep review (202), or the state it is already in
 *   POST /api/agent/:matchId/chat    {hero,lang,question,history}  SSE: {step} … {text, unverified?} {done}
 *
 * Starting a review and each chat turn call a model: both pass the
 * same-origin guard, a per-caller limit and the shared LLM budget. Reads are
 * only rate limited. All IO is injected.
 */
import express from 'express';
import { createSlidingWindowLimiter } from '../rateLimiter.js';
import { rateLimitKey } from '../rateLimitKey.js';
import { parseChatBody } from './chat.js';
import { createSlots } from './slots.js';

const MATCH_ID = /^[1-9]\d{0,12}$/;
const heroOf = (v) => (typeof v === 'string' && /^[A-Za-z][A-Za-z _-]{0,39}$/.test(v.trim()) ? v.trim() : null);
const langOf = (v) => (v === 'zh' ? 'zh' : 'en');

/**
 * @param {{
 *   service: { availability: Function, prepare: Function, status: Function, start: Function, chat: Function, evidence: Function },
 *   resolveClientIp: (req: object) => string,
 *   guard?: (req: object) => { ok: true } | { ok: false, status: number, error: string },
 *   llm?: { acquire: (req: object) => { ok: boolean, reason?: string, retryAfterSec?: number } },
 *   readLimiter?: { tryConsume: Function }, reviewLimiter?: { tryConsume: Function }, chatLimiter?: { tryConsume: Function }, parseLimiter?: { tryConsume: Function },
 *   parseDailyMax?: number,
 *   log?: (msg: string) => void,
 * }} deps
 */
export function createAgentRouter(deps) {
  const { service, resolveClientIp } = deps;
  const log = deps.log ?? (() => {});
  const readLimiter = deps.readLimiter ?? createSlidingWindowLimiter({ limit: 60, globalLimit: 2400, windowMs: 60_000 });
  // A deep review is a few hundred thousand tokens: three per caller per ten minutes, sixty an hour overall.
  const reviewLimiter = deps.reviewLimiter ?? createSlots({ limit: 3, windowMs: 600_000 });
  const reviewGlobal = createSlots({ limit: 60, windowMs: 3_600_000 });
  const chatLimiter = deps.chatLimiter ?? createSlots({ limit: 12, windowMs: 60_000 });
  const chatGlobal = createSlots({ limit: 600, windowMs: 60_000 });
  // A parse downloads ~50 MB and runs the extractor: three per caller per ten minutes, and a daily ceiling overall.
  const parseLimiter = deps.parseLimiter ?? createSlots({ limit: 3, windowMs: 600_000 });
  const parseDaily = createSlots({ limit: deps.parseDailyMax ?? 300, windowMs: 86_400_000 });
  const router = express.Router();
  const limited = (res, g) => { res.set('Retry-After', String(g.retryAfterSec)); return res.status(429).json({ code: 'rate_limited', error: 'Too many requests', retryAfterSec: g.retryAfterSec }); };
  const key = (req) => rateLimitKey(resolveClientIp(req));

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
      ? { status: 429, body: { code: 'rate_limited', error: 'Too many requests', retryAfterSec } }
      : { status: 503, body: { code: 'busy', error: 'At capacity; try again later', retryAfterSec } });
    for (const [limiter, k, kind] of limits) if (limiter.full?.(k)) return refusal(kind, limiter.retryAfterSec?.(k) ?? 60);
    if (deps.llm) {
      const b = deps.llm.acquire(req);
      if (!b.ok) return { status: b.reason === 'cost_guard' ? 503 : 429, body: { code: b.reason === 'cost_guard' ? 'busy' : 'rate_limited', error: 'Model budget reached; try again later', retryAfterSec: b.retryAfterSec ?? 60 } };
    }
    for (const [limiter, k, kind] of limits) { const g = limiter.tryConsume(k); if (!g.ok) return refusal(kind, g.retryAfterSec); }
    return null;
  }
  const refuse = (res, r) => { if (r.body?.retryAfterSec) res.set('Retry-After', String(r.body.retryAfterSec)); return res.status(r.status).json(r.body); };

  router.param('matchId', (req, res, next, id) => (MATCH_ID.test(id) ? next() : res.status(400).json({ code: 'invalid_match_id', error: 'Invalid match ID' })));

  router.get('/api/agent/:matchId', async (req, res) => {
    const g = readLimiter.tryConsume(key(req));
    if (!g.ok) return limited(res, g);
    res.set('Cache-Control', 'no-store');
    return res.json(await service.availability(req.params.matchId));
  });

  router.post('/api/agent/:matchId/prepare', async (req, res) => {
    const guard = deps.guard?.(req) ?? { ok: true };
    if (!guard.ok) return res.status(guard.status).json({ code: 'forbidden', error: guard.error });
    // Already there, already running, or known to be impossible: answer without spending a slot.
    const now = await service.availability(req.params.matchId);
    if (now.trace) return res.json({ status: 'ready' });
    if (!now.can_parse) return res.status(503).json({ status: 'unavailable' });
    // Already running, or known to be impossible: answer without spending a slot. A failure that may pass
    // (no address yet, a download that broke) can be tried again, within the caller's limit.
    if (now.parse.status === 'running' || (now.parse.status === 'failed' && now.parse.final)) return res.json(now.parse);
    // Charged inside the parse's claim, and both limits looked at before either is taken: of several requests
    // for the same match arriving together only the one that starts the parse takes a slot, and a full day
    // does not cost the caller one.
    const out = await service.prepare(req.params.matchId, { admit: () => {
      if (parseLimiter.full?.(key(req))) return { status: 429, body: { code: 'rate_limited', error: 'Too many requests', retryAfterSec: parseLimiter.retryAfterSec(key(req)) } };
      if (parseDaily.full('all')) return { status: 503, body: { code: 'busy', error: 'Replay parsing is at capacity today', retryAfterSec: parseDaily.retryAfterSec('all') } };
      const g = parseLimiter.tryConsume(key(req));
      if (!g.ok) return { status: 429, body: { code: 'rate_limited', error: 'Too many requests', retryAfterSec: g.retryAfterSec } };
      parseDaily.tryConsume('all');
      return null;
    } });
    // Refused: every request that shared this start gets the refusal, each on its own response.
    if (out.status === 'refused') return refuse(res, out.refusal);
    log(`parse start match=${req.params.matchId} -> ${out.status}`);
    return res.status(out.status === 'running' ? 202 : 200).json(out);
  });

  router.get('/api/agent/:matchId/review', async (req, res) => {
    const hero = heroOf(req.query.hero);
    if (!hero) return res.status(400).json({ code: 'invalid_hero', error: 'hero is required' });
    const g = readLimiter.tryConsume(key(req));
    if (!g.ok) return limited(res, g);
    res.set('Cache-Control', 'no-store');
    return res.json(await service.status(req.params.matchId, hero, langOf(req.query.lang)));
  });

  router.get('/api/agent/:matchId/evidence', async (req, res) => {
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
  });

  router.post('/api/agent/:matchId/review', async (req, res) => {
    const guard = deps.guard?.(req) ?? { ok: true };
    if (!guard.ok) return res.status(guard.status).json({ code: 'forbidden', error: guard.error });
    const hero = heroOf(req.body?.hero);
    if (!hero) return res.status(400).json({ code: 'invalid_hero', error: 'hero is required' });
    const lang = langOf(req.body?.lang);
    // Already running or done: answer without spending anyone's budget.
    const now = await service.status(req.params.matchId, hero, lang);
    if (now.status !== 'none' && now.status !== 'failed') return res.status(now.status === 'no_trace' || now.status === 'unknown_hero' ? 404 : 200).json(now);
    // Nothing is spent on a request that cannot be served: no model, no start.
    if (!(await service.availability(req.params.matchId)).model_configured) return res.status(503).json({ status: 'unavailable', reason: 'model_not_configured' });
    // Charged inside the job's claim: of several requests for the same review arriving together, only the one
    // that creates the job takes a slot and model budget; the others join it for free.
    const out = await service.start(req.params.matchId, hero, lang, { admit: () => admit(req, [[reviewLimiter, key(req), 'caller'], [reviewGlobal, 'all', 'all']]) });
    // Refused: every request that shared this start gets the refusal, each on its own response.
    if (out.status === 'refused') return refuse(res, out.refusal);
    log(`review start match=${req.params.matchId} hero=${hero} -> ${out.status}`);
    return res.status(out.status === 'running' ? 202 : out.status === 'unavailable' ? 503 : 200).json(out);
  });

  router.post('/api/agent/:matchId/chat', async (req, res) => {
    const guard = deps.guard?.(req) ?? { ok: true };
    if (!guard.ok) return res.status(guard.status).json({ code: 'forbidden', error: guard.error });
    const body = parseChatBody(req.body);
    if (body.error) return res.status(400).json({ code: body.error, error: 'Invalid chat request' });
    if (!heroOf(body.hero)) return res.status(400).json({ code: 'invalid_hero', error: 'hero is required' });
    // Nothing is spent on a turn that cannot be answered: no replay trace, a hero not in it, no model.
    const avail = await service.availability(req.params.matchId);
    const cannot = !avail.trace ? 'no_trace' : !avail.heroes.some((h) => h.hero === body.hero.trim().toLowerCase().replace(/[\s-]+/g, '_')) ? 'unknown_hero' : !avail.model_configured ? 'unavailable' : null;
    if (cannot) {
      res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
      res.write(`data: ${JSON.stringify({ error: cannot })}\n\ndata: ${JSON.stringify({ done: true })}\n\n`);
      return res.end();
    }
    const no = admit(req, [[chatLimiter, key(req), 'caller'], [chatGlobal, 'all', 'all']]);
    if (no) return refuse(res, no);
    const ac = new AbortController();
    let gone = false;
    res.on('close', () => { if (!res.writableEnded) { gone = true; ac.abort(); } });
    res.status(200);
    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    const send = (obj) => { if (!gone && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
    try {
      const out = await service.chat({
        matchId: req.params.matchId, hero: body.hero, lang: body.lang, question: body.question, history: body.history, signal: ac.signal,
        onEvent: (e) => { if (e.type === 'tool_start') send({ step: { tool: e.name, args: e.args } }); },
      });
      if (out.status === 'ok') send({ text: out.text, ...(out.unverified.length ? { unverified: out.unverified } : {}) });
      else send({ error: out.status });
    } catch (error) {
      if (!gone) { log(`chat failed match=${req.params.matchId}: ${error?.name ?? 'error'}`); send({ error: 'failed' }); }
    }
    send({ done: true });
    if (!res.writableEnded) res.end();
    return undefined;
  });

  return router;
}
