/**
 * GET /api/coach/:matchId — the coach report as JSON (same payload the web
 * page and the CLI render). Optional `slot` + `pos` override one player's
 * inferred position. All IO is injected so the route is testable offline.
 */
import express from 'express';
import { buildCoachReport } from './analyze.js';
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

  return router;
}
