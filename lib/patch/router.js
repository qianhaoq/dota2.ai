/**
 * HTTP surface of the patch advisor.
 *
 *   GET  /api/patch            the patch at a glance (the patch_overview record): no model, cacheable
 *   GET  /api/patch/hero/:hero one hero's notes and numbers (the hero_patch record)
 *   GET  /api/patch/news       the home page's patch news, live from Valve (lib/patch/news.js)
 *   POST /api/patch/chat  {lang,question,history}   SSE: {step} … {text, unverified?} {done}
 *
 * A chat turn calls a model: it passes the same-origin guard, a per-caller
 * limit and the shared LLM budget, all taken in one step so a request refused
 * anywhere leaves nothing reserved. Reads are only rate limited. All IO is
 * injected.
 */
import express from 'express';
import { createSlidingWindowLimiter } from '../rateLimiter.js';
import { rateLimitKey } from '../rateLimitKey.js';
import { createSlots } from '../agent/slots.js';
import { parseAdvisorBody, runAdvisor } from './advisor.js';
import { PATCH_BRACKETS, findHero, findNotedItem } from './data.js';
import { runPatchTool } from './tools.js';

const langOf = (v) => (v === 'zh' ? 'zh' : 'en');
/** What a lookup is about, in the reader's words: a hero's or item's name, or the words searched for. Null when it is about nothing in particular, or the name is not known. */
export function aboutOf(tool, args, lang) {
  if (tool === 'hero_patch') return findHero(args?.hero)?.[lang] ?? null;
  if (tool === 'item_patch') return findNotedItem(args?.item)?.name[lang] ?? null;
  if (tool === 'search_notes') return typeof args?.query === 'string' && args.query.trim() ? args.query.trim().slice(0, 60) : null;
  return null;
}

/**
 * @param {{
 *   complete: Function | null,
 *   resolveClientIp: (req: object) => string,
 *   guard?: (req: object) => { ok: true } | { ok: false, status: number, error: string },
 *   llm?: { acquire: (req: object) => { ok: boolean, reason?: string, retryAfterSec?: number } },
 *   readLimiter?: { tryConsume: Function }, chatLimiter?: { tryConsume: Function, full?: Function, retryAfterSec?: Function },
 *   run?: typeof runAdvisor,
 *   news?: { get: () => Promise<object | null> } | null,
 *   log?: (msg: string) => void,
 * }} deps
 */
export function createPatchRouter(deps) {
  const { complete, resolveClientIp } = deps;
  const log = deps.log ?? (() => {});
  const run = deps.run ?? runAdvisor;
  const readLimiter = deps.readLimiter ?? createSlidingWindowLimiter({ limit: 60, globalLimit: 2400, windowMs: 60_000 });
  const chatLimiter = deps.chatLimiter ?? createSlots({ limit: 8, windowMs: 60_000 });
  const chatGlobal = createSlots({ limit: 300, windowMs: 60_000 });
  const router = express.Router();
  const key = (req) => rateLimitKey(resolveClientIp(req));
  const limited = (res, g) => { res.set('Retry-After', String(g.retryAfterSec)); return res.status(429).json({ code: 'rate_limited', error: 'Too many requests', retryAfterSec: g.retryAfterSec }); };
  const record = (res, out) => {
    if (out.error) return res.status(404).json({ code: out.error, error: 'Not found' });
    const { tool, ...rest } = out;
    // A pure function of the committed snapshots: the same for everyone until the next deploy.
    res.set('Cache-Control', 'public, max-age=600');
    return res.json(rest);
  };

  router.get('/api/patch', (req, res) => {
    const g = readLimiter.tryConsume(key(req));
    if (!g.ok) return limited(res, g);
    return record(res, { ...runPatchTool('patch_overview', {}, { lang: langOf(req.query.lang) }), advisor: Boolean(complete) });
  });

  router.get('/api/patch/news', async (req, res) => {
    const g = readLimiter.tryConsume(key(req));
    if (!g.ok) return limited(res, g);
    const news = await deps.news?.get().catch(() => null);
    // Unavailable (Valve not answering on a cold instance): the page keeps the patch it shipped with.
    if (!news) return res.status(503).set('Cache-Control', 'no-store').json({ code: 'patch_news_unavailable', error: 'Patch news unavailable' });
    // While the highlights are being chosen, ask again soon; after that, a few minutes is fine.
    res.set('Cache-Control', news.picking ? 'public, max-age=30' : 'public, max-age=300');
    return res.json(news);
  });

  router.get('/api/patch/hero/:hero', (req, res) => {
    const g = readLimiter.tryConsume(key(req));
    if (!g.ok) return limited(res, g);
    const hero = String(req.params.hero ?? '').slice(0, 40);
    const bracket = typeof req.query.bracket === 'string' && PATCH_BRACKETS.includes(req.query.bracket) ? req.query.bracket : undefined;
    return record(res, runPatchTool('hero_patch', { hero, ...(bracket ? { bracket } : {}) }, { lang: langOf(req.query.lang) }));
  });

  router.post('/api/patch/chat', async (req, res) => {
    const guard = deps.guard?.(req) ?? { ok: true };
    if (!guard.ok) return res.status(guard.status).json({ code: 'forbidden', error: guard.error });
    const body = parseAdvisorBody(req.body);
    if (body.error) return res.status(400).json({ code: body.error, error: 'Invalid question' });
    // Nothing is spent on a turn that cannot be answered.
    if (!complete) return res.status(503).json({ code: 'unavailable', error: 'The advisor is not configured' });
    // Look at every limit, then take the model budget, then take the slots: a refusal leaves nothing reserved.
    const limits = [[chatLimiter, key(req), 429, 'rate_limited'], [chatGlobal, 'all', 503, 'busy']];
    for (const [limiter, k, status, code] of limits) {
      if (limiter.full?.(k)) { const retryAfterSec = limiter.retryAfterSec?.(k) ?? 60; res.set('Retry-After', String(retryAfterSec)); return res.status(status).json({ code, error: 'Too many requests', retryAfterSec }); }
    }
    if (deps.llm) {
      const b = deps.llm.acquire(req);
      if (!b.ok) { const retryAfterSec = b.retryAfterSec ?? 60; res.set('Retry-After', String(retryAfterSec)); return res.status(b.reason === 'cost_guard' ? 503 : 429).json({ code: b.reason === 'cost_guard' ? 'busy' : 'rate_limited', error: 'Model budget reached; try again later', retryAfterSec }); }
    }
    for (const [limiter, k, status, code] of limits) {
      const g = limiter.tryConsume(k);
      if (!g.ok) { res.set('Retry-After', String(g.retryAfterSec)); return res.status(status).json({ code, error: 'Too many requests', retryAfterSec: g.retryAfterSec }); }
    }
    // A caller who leaves ends the lookups and the model calls made for them.
    const ac = new AbortController();
    let gone = false;
    res.on('close', () => { if (!res.writableEnded) { gone = true; ac.abort(); } });
    res.status(200);
    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    const send = (obj) => { if (!gone && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
    try {
      const out = await run({
        complete, lang: body.lang, question: body.question, history: body.history, signal: ac.signal,
        // A step about a hero or an item carries the name to show for it: the model asks by engine key.
        onEvent: (e) => { if (e.type === 'tool_start') { const about = aboutOf(e.name, e.args, body.lang); send({ step: { tool: e.name, args: e.args, ...(about ? { about } : {}) } }); } },
      });
      if (out.status === 'ok') send({ text: out.text, ...(out.unverified.length ? { unverified: out.unverified } : {}) });
      else send({ error: out.status });
      log(`patch chat -> ${out.status} tools=${out.tool_calls?.length ?? 0} in=${out.usage?.input ?? 0} out=${out.usage?.output ?? 0} unverified=${out.unverified?.length ?? 0}`);
    } catch (error) {
      if (!gone) { log(`patch chat failed: ${error?.name ?? 'error'}`); send({ error: 'failed' }); }
    }
    send({ done: true });
    if (!res.writableEnded) res.end();
    return undefined;
  });

  return router;
}
