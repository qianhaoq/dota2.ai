// Legacy /match/:id permalinks → the canonical /m/:id review page. Mounted in
// server.js BEFORE static/SPA so old links get one 301 instead of an HTML
// round-trip. Extracted here (not inline in server.js) so the redirect is
// unit-testable without booting the whole server.

const MAX_MATCH_ID = 2 ** 40; // same ceiling as the v1 matchId validation

/**
 * Redirect target for a /match/:id request, or null when the id is not a
 * plausible match id — callers let the SPA handle those instead of 301ing.
 * `search` must already start with '?' (or be empty); it is kept verbatim.
 */
export function matchRedirectLocation(id, search = '') {
  if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id) || Number(id) > MAX_MATCH_ID) return null;
  return `/m/${id}${search.startsWith('?') ? search : ''}`;
}

/**
 * Express route handler for `app.get('/match/:id', …)`. Query string is
 * preserved as-is. Historical hash routes (#/m/:id, #/match/:id) never reach
 * the server — the fragment is client/browser territory, so no server-side
 * hash 301 exists (by design).
 */
export function matchPathRedirect(req, res, next) {
  const url = req.originalUrl || req.url || '';
  const queryAt = url.indexOf('?');
  const search = queryAt === -1 ? '' : url.slice(queryAt);
  const location = matchRedirectLocation(req.params?.id, search);
  if (!location) return next();
  res.redirect(301, location);
}
