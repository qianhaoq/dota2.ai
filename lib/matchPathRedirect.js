// Server-side redirects for URLs that are not pages any more. Mounted in
// server.js BEFORE static/SPA so old links get one 301 instead of an HTML
// round-trip. The coach is the only UI: /, /r/:id (review), /p/:id (player).
// Extracted here so the redirects are unit-testable without the server.

const MAX_MATCH_ID = 2 ** 40; // same ceiling as the v1 matchId validation

/** `?lang=en|zh|ru` from a search string (`?…` or empty), else ''. */
function langOnly(search = '') {
  const lang = new URLSearchParams(search.startsWith('?') ? search.slice(1) : '').get('lang');
  return lang === 'en' || lang === 'zh' || lang === 'ru' ? `?lang=${lang}` : '';
}

const searchOf = (req) => {
  const url = req.originalUrl || req.url || '';
  const at = url.indexOf('?');
  return at === -1 ? '' : url.slice(at);
};

/**
 * Redirect target for a /match/:id permalink — the review page — or null when
 * the id is not a plausible match id (callers let the SPA send it home).
 */
export function matchRedirectLocation(id, search = '') {
  if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id) || Number(id) > MAX_MATCH_ID) return null;
  return `/r/${id}${langOnly(search)}`;
}

/** `app.get('/match/:id', …)`: 301 to the review page; non-ids fall through. */
export function matchPathRedirect(req, res, next) {
  const location = matchRedirectLocation(req.params?.id, searchOf(req));
  if (!location) return next();
  res.redirect(301, location);
}

/** Retired surfaces (old conversational review and legacy tools). */
export const RETIRED_PREFIXES = Object.freeze(['/new', '/m', '/legacy']);

/** `app.use(retiredPathRedirect)`: /new, /m, /legacy and anything under them 301 home, keeping ?lang. */
export function retiredPathRedirect(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const p = (req.path || '').toLowerCase();
  if (!RETIRED_PREFIXES.some((x) => p === x || p === `${x}/` || p.startsWith(`${x}/`))) return next();
  res.redirect(301, `/${langOnly(searchOf(req))}`);
}
