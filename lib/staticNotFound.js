// Missing build files must 404, not fall through to the SPA index.html.
// Mounted in server.js right after express.static(dist) and before the
// SPA catch-all. Without it, a request for a JS/CSS chunk that no longer
// exists (an open tab or a mixed-revision response during a deploy) gets
// 200 text/html, the browser fails to run "<!DOCTYPE html>" as a script, and
// the page stays blank until a hard reload. Extracted here (not inline in
// server.js) so it is unit-testable without booting the whole server.

/**
 * Path prefixes that never route to the SPA index.html: Vite build / public/
 * files, plus RFC 8615 `.well-known/*` discovery probes (e.g. MCP OAuth
 * metadata checks that expect 404 when no auth server is configured, and
 * fail to parse 200 text/html).
 */
export const STATIC_FILE_PREFIXES = Object.freeze(['/assets/', '/home-scene/', '/.well-known/']);

/**
 * Express middleware: 404 (plain text, not cached) for GET/HEAD requests under
 * a static-only prefix that express.static did not serve. Everything else
 * passes through to the next handler (the SPA fallback).
 */
export function staticNotFound(prefixes = STATIC_FILE_PREFIXES) {
  return function staticNotFoundHandler(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const p = req.path || '';
    if (!prefixes.some((prefix) => p.startsWith(prefix))) return next();
    res.status(404).set('Cache-Control', 'no-store').type('text/plain').send('Not found');
  };
}
