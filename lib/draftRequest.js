import { createRequire } from 'node:module';
import { normalizeUiLang } from './aiLanguage.js';
import { createSlidingWindowLimiter } from './rateLimiter.js';
import { rateLimitKey } from './rateLimitKey.js';

// Local catalog only: validation must never fetch hero metadata.
const heroes = createRequire(import.meta.url)('./data/constants/heroes.json');
const knownHero = (id) => Number.isInteger(id) && Object.hasOwn(heroes, id);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = new Set(['name', 'nameZh', 'nameEn', 'attribute', 'img', 'imgFallback', 'icon']);
const suggestionRoles = new Set(['Carry', 'Support', 'Nuker', 'Disabler', 'Initiator', 'Durable']);
const lists = new Set(['aliases', 'roles', 'rolesZh']);

function validHero(hero) {
  if (!object(hero) || !knownHero(hero.id)) return false;
  return Object.entries(hero).every(([key, value]) => {
    if (key === 'id') return true;
    if (strings.has(key)) return typeof value === 'string' && value.length <= 512;
    if (lists.has(key)) return Array.isArray(value) && value.length <= 32
      && value.every((s) => typeof s === 'string' && s.length <= 128);
    return false;
  });
}

export function validateDraftRequest(body, kind) {
  if (!['analyze', 'playbook', 'suggestions'].includes(kind) || !object(body)) return false;
  const teams = kind === 'analyze' ? ['radiant', 'dire'] : ['allies', 'enemies'];
  const fields = new Set([...teams, 'lang', ...(kind === 'analyze' ? ['userContext'] : ['side', ...(kind === 'suggestions' ? ['limit', 'role'] : ['focusHeroId'])])]);
  if (Object.keys(body).some((key) => !fields.has(key))) return false;
  if (body.lang !== undefined && !['en', 'zh'].includes(body.lang)) return false;
  const seen = new Set();
  for (const key of teams) {
    const team = body[key] === undefined ? [] : body[key];
    if (!Array.isArray(team) || team.length > 5) return false;
    for (const hero of team) {
      if (!validHero(hero) || seen.has(hero.id)) return false;
      seen.add(hero.id);
    }
  }
  if (kind === 'analyze') {
    return body.userContext === undefined
      || (typeof body.userContext === 'string' && body.userContext.length <= 2000);
  }
  if (kind === 'suggestions') {
    return (body.side === undefined || ['radiant', 'dire'].includes(body.side))
      && (body.limit === undefined || (Number.isInteger(body.limit) && body.limit >= 1 && body.limit <= 8))
      && (body.role === undefined || suggestionRoles.has(body.role));
  }
  return (body.side === undefined || ['radiant', 'dire'].includes(body.side))
    && (body.focusHeroId === undefined || (knownHero(body.focusHeroId)
      && (body.allies ?? []).some((hero) => hero.id === body.focusHeroId)));
}

/** Shared draft schema and pre-grounding work admission, separate from completion accounting.
 * Synchronous tryConsume checks and reserves both budgets before next() can
 * start IO; concurrent requests cannot all pass a check-before-await race.
 * Valid fallback requests consume work budget, but never LLM budget here.
 * Per-process sliding window (like the existing LLM limiter).
 */
export function createDraftRequestBoundary({
  resolveClientIp,
  limiter = createSlidingWindowLimiter({ limit: 12, globalLimit: 600, windowMs: 60_000 }),
  // Suggestions refresh on draft/side/role changes: isolate them from the
  // Analyze/Playbook budget while bounding even unavailable-data requests.
  suggestionsLimiter = createSlidingWindowLimiter({ limit: 60, globalLimit: 600, windowMs: 60_000 }),
}) {
  return (kind) => (req, res, next) => {
    const lang = normalizeUiLang(req.body?.lang);
    if (!validateDraftRequest(req.body, kind)) {
      return res.status(400).json({
        error: 'invalid_draft',
        message: lang === 'zh' ? '无效的阵容请求' : 'Invalid draft request',
      });
    }
    const workLimiter = kind === 'suggestions' ? suggestionsLimiter : limiter;
    const gate = workLimiter.tryConsume(rateLimitKey(resolveClientIp(req)));
    if (!gate.ok) {
      res.setHeader('Retry-After', String(gate.retryAfterSec));
      return res.status(429).json({
        error: 'rate_limited',
        message: lang === 'zh' ? '请求过于频繁，请稍后再试' : 'Too many requests, please retry later',
        retryAfter: gate.retryAfterSec,
      });
    }
    return next();
  };
}
