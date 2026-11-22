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
  const reviewLimiter = deps.reviewLimiter ?? createSlidingWindowLimiter({ limit: 3, windowMs: 600_000 });
  const reviewGlobal = createSlidingWindowLimiter({ limit: 60, windowMs: 3_600_000 });
  // A parse downloads ~50 MB and runs the extractor: three per caller per ten minutes, and a daily ceiling overall.
  const parseLimiter = deps.parseLimiter ?? createSlidingWindowLimiter({ limit: 3, windowMs: 600_000 });
  const parseDaily = createSlidingWindowLimiter({ limit: deps.parseDailyMax ?? 300, windowMs: 86_400_000 });
  const chatLimiter = deps.chatLimiter ?? createSlidingWindowLimiter({ limit: 12, globalLimit: 600, windowMs: 60_000 });
  const router = express.Router();
  const limited = (res, g) => { res.set('Retry-After', String(g.retryAfterSec)); return res.status(429).json({ code: 'rate_limited', error: 'Too many requests', retryAfterSec: g.retryAfterSec }); };
  const key = (req) => rateLimitKey(resolveClientIp(req));

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
    const g = parseLimiter.tryConsume(key(req));
    if (!g.ok) return limited(res, g);
    const all = parseDaily.tryConsume('all');
    if (!all.ok) return res.status(503).json({ code: 'busy', error: 'Replay parsing is at capacity today', retryAfterSec: all.retryAfterSec });
    const out = await service.prepare(req.params.matchId);
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
    // The model budget first: a request it refuses must not use up a review slot, the caller's or the hour's.
    if (deps.llm) { const b = deps.llm.acquire(req); if (!b.ok) return res.status(b.reason === 'cost_guard' ? 503 : 429).json({ code: b.reason === 'cost_guard' ? 'busy' : 'rate_limited', error: 'Model budget reached; try again later', retryAfterSec: b.retryAfterSec ?? 60 }); }
    const g = reviewLimiter.tryConsume(key(req));
    if (!g.ok) return limited(res, g);
    const all = reviewGlobal.tryConsume('all');
    if (!all.ok) return res.status(503).json({ code: 'busy', error: 'Deep reviews are at capacity; try again later', retryAfterSec: all.retryAfterSec });
    const out = await service.start(req.params.matchId, hero, lang);
    log(`review start match=${req.params.matchId} hero=${hero} -> ${out.status}`);
    return res.status(out.status === 'running' ? 202 : out.status === 'unavailable' ? 503 : 200).json(out);
  });

  router.post('/api/agent/:matchId/chat', async (req, res) => {
    const guard = deps.guard?.(req) ?? { ok: true };
    if (!guard.ok) return res.status(guard.status).json({ code: 'forbidden', error: guard.error });
    const body = parseChatBody(req.body);
    if (body.error) return res.status(400).json({ code: body.error, error: 'Invalid chat request' });
    if (!heroOf(body.hero)) return res.status(400).json({ code: 'invalid_hero', error: 'hero is required' });
    if (deps.llm) { const b = deps.llm.acquire(req); if (!b.ok) return res.status(b.reason === 'cost_guard' ? 503 : 429).json({ code: b.reason === 'cost_guard' ? 'busy' : 'rate_limited', error: 'Model budget reached; try again later', retryAfterSec: b.retryAfterSec ?? 60 }); }
    const g = chatLimiter.tryConsume(key(req));
    if (!g.ok) return limited(res, g);
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
