/**
 * GET /api/coach/:matchId — the coach report as JSON (same payload the web
 * page and the CLI render). Optional `slot` + `pos` override one player's
 * inferred position. All IO is injected so the route is testable offline.
 */
import express from 'express';
import { buildCoachReport } from './analyze.js';
import { parseAskBody, askMessages, fallbackAnswer, FALLBACK_NOTICE } from './ask.js';
import { decideFollowUpOutcome } from '../matchReview/followUpFallback.js';
import { createSlidingWindowLimiter } from '../rateLimiter.js';

const MAX_MATCH_ID = 2 ** 40;

export function parseCoachQuery(params, query) {
  const raw = String(params.matchId ?? '');
  if (!/^[1-9]\d{0,12}$/.test(raw) || Number(raw) > MAX_MATCH_ID) return { error: 'invalid_match_id' };
  const overrides = {};
  if (query.slot !== undefined || query.pos !== undefined) {
    const slot = Number(query.slot); const pos = Number(query.pos);
    if (!Number.isInteger(slot) || slot < 0 || slot > 9 || !Number.isInteger(pos) || pos < 1 || pos > 5) {
      return { error: 'invalid_override' };
    }
    overrides[slot] = pos;
  }
  return { matchId: Number(raw), overrides, zh: query.lang === 'zh' };
}

/**
 * @param {{
 *   getMatchDetail: (id: number) => Promise<object>,
 *   resolveClientIp: (req: object) => string,
 *   mapError: (error: unknown, isZh: boolean) => { status: number, body: object },
 *   limiter?: { tryConsume: (key: string) => { ok: boolean, retryAfterSec: number } },
 *   log?: (msg: string) => void,
 *   cases?: { get: (o: object) => Promise<object>, peek: (o: object) => object | null },
 *   ask?: {
 *     guard?: (req: object) => { ok: true } | { ok: false, status: number, error: string },
 *     llm?: { acquire: (req: object) => { ok: boolean, reason?: string, retryAfterSec?: number }, respondRateLimited: Function },
 *     providers: (messages: object[]) => { name: string, create: (signal: AbortSignal) => Promise<AsyncIterable<any>> }[],
 *     stream: (opts: object) => Promise<{ status: string }>,
 *     attemptMs: number,
 *   },
 * }} deps
 */
export function createCoachRouter(deps) {
  const { getMatchDetail, resolveClientIp, mapError } = deps;
  const limiter = deps.limiter ?? createSlidingWindowLimiter({ limit: 40, globalLimit: 1200, windowMs: 60_000 });
  const log = deps.log ?? (() => {});
  const router = express.Router();

  router.get('/api/coach/:matchId', async (req, res) => {
    const q = parseCoachQuery(req.params, req.query);
    if (q.error) {
      return res.status(400).json({ code: q.error, error: q.error === 'invalid_match_id' ? 'Invalid match id' : 'slot must be 0-9 and pos 1-5' });
    }
    const gate = limiter.tryConsume(resolveClientIp(req));
    if (!gate.ok) {
      res.set('Retry-After', String(gate.retryAfterSec));
      return res.status(429).json({ code: 'rate_limited', error: 'Too many requests', retryAfterSec: gate.retryAfterSec });
    }
    let match;
    try {
      match = await getMatchDetail(q.matchId);
    } catch (error) {
      const mapped = mapError(error, q.zh);
      return res.status(mapped.status).json({ code: mapped.status === 404 ? 'not_found' : 'upstream', ...mapped.body });
    }
    try {
      const report = buildCoachReport(match, { overrides: q.overrides });
      res.set('Cache-Control', report.match.parsed ? 'public, max-age=300' : 'no-store');
      return res.json(report);
    } catch (error) {
      if (error?.code === 'INSUFFICIENT') {
        return res.status(422).json({ code: 'insufficient', error: 'OpenDota has no player data for this match yet' });
      }
      log(`build failed match=${q.matchId}: ${error?.message ?? error}`);
      return res.status(500).json({ code: 'internal', error: 'Could not build the report' });
    }
  });

  // GET /api/coach/:matchId/cases?slot=&pos= — professional games where the
  // same (or a similar) hero met the same key enemy: one that repeated the
  // player's problem and lost, one that avoided it and won. Loaded after the
  // report, because it may need a dozen upstream fetches on a cold cache.
  router.get('/api/coach/:matchId/cases', async (req, res) => {
    // `slot` is required here; `pos` is an optional override for that slot.
    const q = parseCoachQuery(req.params, req.query.pos != null && req.query.pos !== '' ? req.query : { lang: req.query.lang });
    const slot = Number(req.query.slot);
    if (q.error || !Number.isInteger(slot) || slot < 0 || slot > 9) {
      return res.status(400).json({ code: q.error ?? 'invalid_slot', error: 'Invalid match id or slot' });
    }
    if (!deps.cases) return res.status(404).json({ code: 'unavailable', error: 'Case studies are not enabled' });
    const gate = limiter.tryConsume(resolveClientIp(req));
    if (!gate.ok) {
      res.set('Retry-After', String(gate.retryAfterSec));
      return res.status(429).json({ code: 'rate_limited', error: 'Too many requests', retryAfterSec: gate.retryAfterSec });
    }
    let match; let report;
    try {
      match = await getMatchDetail(q.matchId);
      report = buildCoachReport(match, { overrides: q.overrides });
    } catch (error) {
      if (error?.code === 'INSUFFICIENT') return res.status(422).json({ code: 'insufficient', error: 'OpenDota has no player data for this match yet' });
      const mapped = mapError(error, q.zh);
      return res.status(mapped.status).json({ code: mapped.status === 404 ? 'not_found' : 'upstream', ...mapped.body });
    }
    if (!report.match.parsed) return res.status(422).json({ code: 'needs_parse', error: 'Case studies need a parsed match' });
    try {
      const out = await deps.cases.get({ report, slot, match });
      res.set('Cache-Control', 'public, max-age=3600');
      return res.json(out);
    } catch (error) {
      log(`cases failed match=${q.matchId} slot=${slot}: ${error?.message ?? error}`);
      return res.status(502).json({ code: 'upstream', error: 'Could not load professional games right now' });
    }
  });

  // POST /api/coach/:matchId/ask — follow-up questions on one player's
  // report, streamed as SSE `data: {"text"}` frames, then `{"done":true}`.
  router.post('/api/coach/:matchId/ask', async (req, res) => {
    const q = parseCoachQuery(req.params, {});
    if (q.error) return res.status(400).json({ code: q.error, error: 'Invalid match id' });
    const body = parseAskBody(req.body);
    if (body.error) return res.status(400).json({ code: body.error, error: body.error });
    const ask = deps.ask;
    const guard = ask?.guard?.(req) ?? { ok: true };
    if (!guard.ok) return res.status(guard.status).json({ code: 'forbidden', error: guard.error });
    const gate = limiter.tryConsume(resolveClientIp(req));
    if (!gate.ok) {
      res.set('Retry-After', String(gate.retryAfterSec));
      return res.status(429).json({ code: 'rate_limited', error: 'Too many requests', retryAfterSec: gate.retryAfterSec });
    }
    // Disconnect handling before the first await: a client that leaves while
    // the match loads must never reach the LLM budget or a paid completion.
    const ac = new AbortController();
    let gone = false;
    res.on('close', () => { if (!res.writableEnded) { gone = true; ac.abort(); } });
    let report;
    try {
      const overrides = body.pos ? { [body.slot]: body.pos } : {};
      report = buildCoachReport(await getMatchDetail(q.matchId), { overrides });
    } catch (error) {
      if (error?.code === 'INSUFFICIENT') return res.status(422).json({ code: 'insufficient', error: 'OpenDota has no player data for this match yet' });
      const mapped = mapError(error, body.lang === 'zh');
      return res.status(mapped.status).json({ code: mapped.status === 404 ? 'not_found' : 'upstream', ...mapped.body });
    }
    if (gone) return undefined;
    // Case studies the page already loaded join the context; never fetched here.
    const cases = report.match.parsed ? (deps.cases?.peek({ report, slot: body.slot }) ?? null) : null;
    const input = { report, slot: body.slot, lang: body.lang, question: body.question, history: body.history, cases };
    const providers = ask ? ask.providers(askMessages(input)) : [];
    // Budget is consumed only when a model will actually be called; a tripped
    // cost guard degrades to the report's own text instead of a 429.
    let useLlm = providers.length > 0;
    if (useLlm && ask.llm) {
      const g = ask.llm.acquire(req);
      if (!g.ok) {
        if (g.reason !== 'cost_guard') return ask.llm.respondRateLimited(req, res, g.retryAfterSec);
        useLlm = false;
      }
    }
    res.status(200);
    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
    const fallback = (reason) => {
      log(`ask fallback match=${q.matchId} reason=${reason}`);
      send({ text: fallbackAnswer(input), fallback: true });
      send({ notice: FALLBACK_NOTICE[body.lang] });
    };
    try {
      if (!useLlm) {
        fallback(providers.length ? 'cost_guard' : 'unconfigured');
      } else {
        let forwarded = false;
        const out = await ask.stream({
          providers,
          attemptMs: ask.attemptMs,
          signal: ac.signal,
          onText: (text) => { forwarded = true; send({ text }); },
          shouldStop: () => gone || res.writableEnded,
          onProviderError: ({ provider, error }) => log(`ask provider_error match=${q.matchId} provider=${provider} error=${error}`),
        });
        // Same classification as review follow-ups: text that stopped without
        // a terminal finish_reason is truncated, not done — append the
        // report's own answer and say so.
        const decision = decideFollowUpOutcome({ ...out, forwarded: out.forwarded ?? forwarded });
        if (decision.action === 'fallback') {
          if (decision.append) {
            log(`ask fallback match=${q.matchId} reason=${decision.reason}`);
            send({ text: `\n\n${fallbackAnswer(input)}`, fallback: true, incomplete: true });
            send({ notice: FALLBACK_NOTICE[body.lang], incomplete: true });
          } else {
            fallback('provider_failed');
          }
        }
      }
    } catch (error) {
      if (!gone) { log(`ask failed match=${q.matchId}: ${error?.name ?? 'error'}`); fallback('error'); }
    }
    send({ done: true });
    if (!res.writableEnded) res.end();
  });

  return router;
}
