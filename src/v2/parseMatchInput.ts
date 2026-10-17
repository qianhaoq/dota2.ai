/**
 * v2 match-input parser (QA P2: match IDs stay strings). Returns the id as a
 * STRING — never Number()/parseInt'd. The server does Number(req.params.matchId),
 * so ids above Number.MAX_SAFE_INTEGER (9007199254740991 — effectively 16
 * digits) are rejected here (BigInt compare, no float coercion). Accepts pure
 * digits (1–20, within the safe range) or match URLs whose protocol is ONLY
 * http/https (javascript:, data:, ftp: … are rejected; scheme-less hosts are
 * treated as https) on opendota.com / dotabuff.com / stratz.com (exact host
 * or subdomain — lookalikes like opendota.com.evil.test fail the host check).
 */

const MATCH_URL_HOSTS = ['opendota.com', 'dotabuff.com', 'stratz.com'];
const BARE_ID_RE = /^\d{1,20}$/;
// The id must end at a path boundary, so a 21-digit id is rejected outright
// instead of being silently truncated to its first 20 digits.
const URL_ID_RE = /\/matches\/(\d{1,20})(?=\/|$)/i;
const MAX_SAFE_ID = BigInt(Number.MAX_SAFE_INTEGER);

/** True when a bare digit id is well-formed AND within the server's safe numeric range. */
export function isSafeMatchId(raw: string): boolean {
  return BARE_ID_RE.test(raw) && BigInt(raw) <= MAX_SAFE_ID;
}

export function parseMatchInput(input: unknown): string | null {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (isSafeMatchId(trimmed)) return trimmed;

  // An explicit scheme must be present only as http(s). `javascript:` and
  // friends (with or without //) never reach the URL parser as https.
  let candidate: string;
  if (trimmed.includes('://')) {
    candidate = trimmed;
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return null;
  } else if (trimmed.startsWith('//')) {
    candidate = `https:${trimmed}`;
  } else {
    candidate = `https://${trimmed}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!MATCH_URL_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))) return null;

  const match = url.pathname.match(URL_ID_RE);
  return match && isSafeMatchId(match[1]) ? match[1] : null;
}
