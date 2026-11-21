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
import { GENERIC, injectMeta, previewMeta, shareUrl } from './sharePreview.js';
import { parseAccountId } from './recent.js';
import { matchupBrief, matchupLines } from './matchupBrief.js';

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
 *   recent?: { get: (accountId: number) => Promise<object> },
 *   page?: {
 *     html: () => string | null,
 *     timeoutMs?: number,
 *     limiter?: { tryConsume: (key: string) => { ok: boolean, retryAfterSec: number } },
 *   },
 * }} deps
 */
export function createCoachRouter(deps) {
  const { getMatchDetail, resolveClientIp, mapError } = deps;
  const limiter = deps.limiter ?? createSlidingWindowLimiter({ limit: 40, globalLimit: 1200, windowMs: 60_000 });
  const log = deps.log ?? (() => {});
  const router = express.Router();

  // Hero vs hero from the committed snapshots: no upstream call, so no rate
  // limit beyond the server's own. Before /:matchId, which would match it.
  router.get('/api/coach/matchup', (req, res) => {
    const hero = typeof req.query.hero === 'string' ? req.query.hero.slice(0, 40) : '';
    const vs = typeof req.query.vs === 'string' ? req.query.vs.slice(0, 40) : '';
    if (!hero || !vs) return res.status(400).json({ code: 'invalid_input', error: 'hero and vs are required' });
    const brief = matchupBrief(hero, vs);
    if (brief.error) return res.status(400).json({ code: 'invalid_input', error: brief.error });
    res.set('Cache-Control', 'public, max-age=3600');
    // Ready-made lines too, so terminals and agents never re-implement the wording.
    return res.json({ ...brief, lines: { en: matchupLines(brief, 'en'), zh: matchupLines(brief, 'zh') } });
  });

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

  // GET /api/coach/players/:accountId/recent — a player's recent games, so
  // they can start from a Steam friend code instead of a match ID.
  if (deps.recent) {
    router.get('/api/coach/players/:accountId/recent', async (req, res) => {
      const accountId = parseAccountId(req.params.accountId);
      if (accountId == null) return res.status(400).json({ code: 'invalid_account', error: 'Not a Steam friend code' });
      const gate = limiter.tryConsume(resolveClientIp(req));
      if (!gate.ok) {
        res.set('Retry-After', String(gate.retryAfterSec));
        return res.status(429).json({ code: 'rate_limited', error: 'Too many requests', retryAfterSec: gate.retryAfterSec });
      }
      try {
        const body = await deps.recent.get(accountId);
        res.set('Cache-Control', 'private, max-age=60');
        return res.json(body);
      } catch (error) {
        const mapped = mapError(error, req.query.lang === 'zh');
        return res.status(mapped.status === 404 ? 404 : 502).json({ code: mapped.status === 404 ? 'not_found' : 'upstream', ...mapped.body });
      }
    });
  }

  // GET /r/:matchId — the SPA shell with a link preview for this match
  // (crawlers do not run JS). The match lookup is bounded and best-effort:
  // slow, unknown or rate-limited requests get the generic preview, never an
  // error, and the page itself always loads.
  if (deps.page) {
    const pageLimiter = deps.page.limiter ?? createSlidingWindowLimiter({ limit: 30, globalLimit: 600, windowMs: 60_000 });
    const timeoutMs = deps.page.timeoutMs ?? 2500;
    router.get('/r/:matchId', async (req, res, next) => {
      const html = deps.page.html();
      if (!html) return next();
      const lang = req.query.lang === 'zh' ? 'zh' : 'en';
      const q = parseCoachQuery(req.params, {});
      const ref = typeof req.query.ref === 'string' && /^(team|share)$/.test(req.query.ref) ? req.query.ref : null;
      if (ref && !q.error) log(`share-visit ref=${ref} match=${q.matchId}`);
      const rawSlot = Number(req.query.p);
      const slot = req.query.p !== undefined && Number.isInteger(rawSlot) && rawSlot >= 0 && rawSlot <= 9 ? rawSlot : null;
      // Same role override the page applies (?pos=), so the preview matches the shared review.
      const rawPos = Number(req.query.pos);
      const pos = slot != null && req.query.pos !== undefined && Number.isInteger(rawPos) && rawPos >= 1 && rawPos <= 5 ? rawPos : null;
      const overrides = pos != null ? { [slot]: pos } : {};
      let meta = { ...GENERIC[lang], image: null, url: q.error ? null : shareUrl(q.matchId, { slot, pos, lang: lang === 'zh' ? 'zh' : null }) };
      if (!q.error && pageLimiter.tryConsume(resolveClientIp(req)).ok) {
        let timer;
        try {
          const match = await Promise.race([
            getMatchDetail(q.matchId),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('preview timeout')), timeoutMs); }),
          ]);
          meta = previewMeta(buildCoachReport(match, { overrides }), { slot, lang, url: meta.url });
        } catch {
          // Generic preview; the SPA reports the real error to the viewer.
        } finally {
          clearTimeout(timer);
        }
      }
      res.set('Cache-Control', 'no-cache');
      res.type('html').send(injectMeta(html, meta));
    });
  }

  return router;
}
