/**
 * GET /api/coach/:matchId — the coach report as JSON (same payload the web
 * page and the CLI render). Optional `slot` + `pos` override one player's
 * inferred position. All IO is injected so the route is testable offline.
 */
import express from 'express';
import { buildCoachReport } from './analyze.js';
import { parseAskBody, askMessages } from './ask.js';
import { createSlidingWindowLimiter } from '../rateLimiter.js';
import { rateLimitKey } from '../rateLimitKey.js';
import { createCoachLimiter, runCoachAsk } from './service.js';
import { GENERIC, injectMeta, previewMeta, shareUrl } from './sharePreview.js';
import { parseAccountId } from './recent.js';
import { matchupBrief, matchupLines } from './matchupBrief.js';
import { planKey } from '../agent/plans.js';
import { heroByKey } from '../../packages/review-engine/src/staticHeroes.js';
import { buildSurface } from './cards.js';

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
 *     review?: (matchId: number, hero: string, lang: 'en' | 'zh', plan: string | null) => Promise<{ verdict?: string } | null>,
 *   },
 * }} deps
 */
export function createCoachRouter(deps) {
  const { getMatchDetail, resolveClientIp, mapError } = deps;
  // Shared with the remote MCP coach tools when server.js passes one (lib/coach/service.js).
  const limiter = deps.limiter ?? createCoachLimiter();
  // Every gate keys on rateLimitKey: IPv6 callers share one bucket per /64.
  const gateFor = (req) => limiter.tryConsume(rateLimitKey(resolveClientIp(req)));
  const log = deps.log ?? (() => {});
  const router = express.Router();

  // Hero vs hero from the committed snapshots: no upstream call, so no rate
  // limit beyond the server's own. Before /:matchId, which would match it.
  router.get('/api/coach/matchup', (req, res) => {
    const hero = typeof req.query.hero === 'string' ? req.query.hero.slice(0, 40) : '';
    const vs = typeof req.query.vs === 'string' ? req.query.vs.slice(0, 40) : '';
    if (!hero || !vs) return res.status(400).json({ code: 'invalid_input', error: 'hero and vs are required' });
    const rank = typeof req.query.rank === 'string' ? req.query.rank.slice(0, 20) : null;
    const brief = matchupBrief(hero, vs, { rank });
    if (brief.error) return res.status(400).json({ code: 'invalid_input', error: brief.error });
    res.set('Cache-Control', 'public, max-age=3600');
    // Ready-made lines too, so terminals and agents never re-implement the wording.
    return res.json({ ...brief, lines: { en: matchupLines(brief, 'en'), zh: matchupLines(brief, 'zh') } });
  });

  // GET /api/coach/:matchId/cards?seat=0-9[&slot=&pos=] — one player's review
  // as `dota-coach-ui/2` cards (lib/coach/cards.js). Same data, limits and
  // caching as the report itself.
  router.get('/api/coach/:matchId/cards', async (req, res) => {
    const seat = Number(req.query.seat);
    if (!Number.isInteger(seat) || seat < 0 || seat > 9) return res.status(400).json({ code: 'invalid_seat', error: 'seat must be 0-9' });
    const report = await reportFor(req, res);
    if (!report) return undefined;
    return res.json(buildSurface(report, seat));
  });

  router.get('/api/coach/:matchId', async (req, res) => {
    const report = await reportFor(req, res);
    if (report) res.json(report);
  });

  /** Builds the report, or sends the error response and returns null. */
  async function reportFor(req, res) {
    const q = parseCoachQuery(req.params, req.query);
    const fail = (status, body) => { res.status(status).json(body); return null; };
    if (q.error) {
      return fail(400, { code: q.error, error: q.error === 'invalid_match_id' ? 'Invalid match id' : 'slot must be 0-9 and pos 1-5' });
    }
    const gate = gateFor(req);
    if (!gate.ok) {
      res.set('Retry-After', String(gate.retryAfterSec));
      return fail(429, { code: 'rate_limited', error: 'Too many requests', retryAfterSec: gate.retryAfterSec });
    }
    let match;
    try {
      match = await getMatchDetail(q.matchId);
    } catch (error) {
      const mapped = mapError(error, q.zh);
      return fail(mapped.status, { code: mapped.status === 404 ? 'not_found' : 'upstream', ...mapped.body });
    }
    try {
      const report = buildCoachReport(match, { overrides: q.overrides });
      res.set('Cache-Control', report.match.parsed ? 'public, max-age=300' : 'no-store');
      return report;
    } catch (error) {
      if (error?.code === 'INSUFFICIENT') {
        return fail(422, { code: 'insufficient', error: 'OpenDota has no player data for this match yet' });
      }
      log(`build failed match=${q.matchId}: ${error?.message ?? error}`);
      return fail(500, { code: 'internal', error: 'Could not build the report' });
    }
  }

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
    const gate = gateFor(req);
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
    const gate = gateFor(req);
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
    await runCoachAsk({
      input, ask, providers, useLlm, signal: ac.signal, send,
      isGone: () => gone || res.writableEnded,
      log, tag: `match=${q.matchId}`,
    });
    send({ done: true });
    if (!res.writableEnded) res.end();
  });

  // GET /api/coach/players/:accountId/recent — a player's recent games, so
  // they can start from a Steam friend code instead of a match ID.
  if (deps.recent) {
    router.get('/api/coach/players/:accountId/recent', async (req, res) => {
      const accountId = parseAccountId(req.params.accountId);
      if (accountId == null) return res.status(400).json({ code: 'invalid_account', error: 'Not a Steam friend code' });
      const gate = gateFor(req);
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
      // The review page names its player by hero (?hero=, ?plan=), which wins over an older ?p= seat.
      const hero = typeof req.query.hero === 'string' && /^[a-z][a-z0-9_]{1,39}$/.test(req.query.hero) ? req.query.hero : null;
      const plan = hero ? planKey(typeof req.query.plan === 'string' ? req.query.plan : null) : null;
      const url = q.error ? null : hero
        ? shareUrl(q.matchId, { hero, plan, lang: lang === 'zh' ? 'zh' : null })
        : shareUrl(q.matchId, { slot, pos, lang: lang === 'zh' ? 'zh' : null });
      let meta = { ...GENERIC[lang], image: null, url };
      if (!q.error && pageLimiter.tryConsume(rateLimitKey(resolveClientIp(req))).ok) {
        let timer; let verdictTimer;
        try {
          const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('preview timeout')), timeoutMs); });
          // The player's finished review, if there is one: its verdict leads the preview. Missing, failing or slow
          // (it gives up before the match's deadline), it is simply not used: it never costs the rest of the preview.
          const verdictOf = hero && deps.page.review
            ? Promise.race([
              Promise.resolve().then(() => deps.page.review(q.matchId, hero, lang, plan)).then((r) => (typeof r?.verdict === 'string' ? r.verdict : null), () => null),
              new Promise((r) => { verdictTimer = setTimeout(() => r(null), Math.floor(timeoutMs * 0.8)); }),
            ])
            : Promise.resolve(null);
          const [match, verdict] = await Promise.race([Promise.all([getMatchDetail(q.matchId), verdictOf]), deadline]);
          const report = buildCoachReport(match, hero ? {} : { overrides });
          // The link carries the replay's key (queen_of_pain), the scoreboard its own slug (queenofpain): match the
          // two by hero id. The stored review is still looked up by the link's key, which is what it is kept under.
          const heroId = hero ? heroByKey(hero)?.id ?? null : null;
          const seat = hero ? report.players.find((p) => (heroId != null && p.hero?.id === heroId) || p.hero?.slug === hero)?.slot ?? null : slot;
          meta = previewMeta(report, { slot: seat, lang, url, verdict: seat != null ? verdict : null });
        } catch {
          // Generic preview; the SPA reports the real error to the viewer.
        } finally {
          clearTimeout(timer);
          clearTimeout(verdictTimer);
        }
      }
      res.set('Cache-Control', 'no-cache');
      res.type('html').send(injectMeta(html, meta));
    });
  }

  return router;
}
