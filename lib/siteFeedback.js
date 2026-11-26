/**
 * Homepage user feedback / suggestion box: POST /api/site-feedback.
 *
 * Accepts a short message, category (suggestion | bug | other), optional contact
 * (email / X / Discord / Steam) and UI language (en | zh | ru). Persists to
 * the configured blob store (GCS `site-feedback/` or local dir) when present
 * and writes a structured log line so feedback is never silently lost.
 * Client IP is used only for rate limiting and is never stored or logged.
 */
import express from 'express';
import { randomBytes } from 'node:crypto';
import { normalizeUiLang } from './aiLanguage.js';
import { createSlots } from './agent/slots.js';
import { rateLimitKey } from './rateLimitKey.js';

export const SITE_FEEDBACK_SCHEMA = 'dota2.ai/site-feedback@1';
export const SITE_FEEDBACK_CATEGORIES = Object.freeze(['suggestion', 'bug', 'other']);
export const SITE_FEEDBACK_MAX_MESSAGE = 1000;
export const SITE_FEEDBACK_MAX_CONTACT = 120;

/**
 * Validate and normalize a site feedback request body.
 * @returns {{ ok: true, value: { message: string, category: string, contact: string | null, lang: string } } | { ok: false, code: string }}
 */
export function parseSiteFeedback(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b) return { ok: false, code: 'invalid_body' };
  const message = typeof b.message === 'string' ? b.message.trim() : '';
  if (!message) return { ok: false, code: 'empty_message' };
  if (message.length > SITE_FEEDBACK_MAX_MESSAGE) return { ok: false, code: 'message_too_long' };
  const rawCat = b.category == null || b.category === '' ? 'suggestion' : b.category;
  if (typeof rawCat !== 'string' || !SITE_FEEDBACK_CATEGORIES.includes(rawCat)) return { ok: false, code: 'invalid_category' };
  const rawContact = b.contact == null ? '' : typeof b.contact === 'string' ? b.contact.trim() : null;
  if (rawContact === null || rawContact.length > SITE_FEEDBACK_MAX_CONTACT) return { ok: false, code: 'invalid_contact' };
  return {
    ok: true,
    value: {
      message,
      category: rawCat,
      contact: rawContact || null,
      lang: normalizeUiLang(b.lang),
    },
  };
}

/**
 * @param {{
 *   store?: { put: (key: string, value: any) => Promise<void> } | null,
 *   resolveClientIp: (req: object) => string,
 *   guard?: (req: object) => { ok: true } | { ok: false, status: number, error: string },
 *   limiter?: { tryConsume: Function, full?: Function, retryAfterSec?: Function },
 *   dailyMax?: number,
 *   now?: () => number,
 *   log?: (msg: string) => void,
 * }} deps
 */
export function createSiteFeedbackRouter(deps) {
  const { resolveClientIp, store = null } = deps;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const limiter = deps.limiter ?? createSlots({ limit: 10, windowMs: 600_000 });
  const daily = createSlots({ limit: deps.dailyMax ?? 500, windowMs: 86_400_000 });
  const router = express.Router();

  router.get('/api/site-feedback', (_req, res) => res.status(405).json({ code: 'method_not_allowed', error: 'Use POST' }));

  router.post('/api/site-feedback', async (req, res) => {
    const guard = deps.guard?.(req) ?? { ok: true };
    if (!guard.ok) return res.status(guard.status).json({ code: 'forbidden', error: guard.error });
    const parsed = parseSiteFeedback(req.body);
    if (!parsed.ok) return res.status(400).json({ code: parsed.code, error: 'Invalid feedback' });
    if (daily.full('all')) {
      const retryAfterSec = daily.retryAfterSec('all') ?? 3600;
      res.set('Retry-After', String(retryAfterSec));
      return res.status(503).json({ code: 'busy', error: 'At capacity; try again later', retryAfterSec });
    }
    const g = limiter.tryConsume(rateLimitKey(resolveClientIp(req)));
    if (!g.ok) {
      res.set('Retry-After', String(g.retryAfterSec));
      return res.status(429).json({ code: 'rate_limited', error: 'Too many requests', retryAfterSec: g.retryAfterSec });
    }
    daily.tryConsume('all');
    const ts = now();
    const id = `${ts.toString(36)}-${randomBytes(4).toString('hex')}`;
    const record = {
      schema: SITE_FEEDBACK_SCHEMA,
      id,
      at: new Date(ts).toISOString(),
      ...parsed.value,
    };
    if (store) {
      try {
        await store.put(`${id}.json`, record);
      } catch {
        log(`site-feedback store failed id=${id}`);
        return res.status(503).json({ code: 'unavailable', error: 'Could not save feedback right now' });
      }
    }
    log(JSON.stringify({ type: 'site_feedback', ...record }));
    return res.status(201).json({ status: 'ok', id });
  });

  return router;
}
