/**
 * The dota2.ai coach API for terminals and agents (CLI, MCP stdio):
 *   GET  /api/coach/:id                      the full coach report
 *   GET  /api/coach/:id/cases?slot=          pro games on the same problem
 *   GET  /api/coach/players/:account/recent  a player's recent public games
 *   GET  /api/coach/matchup?hero=&vs=[&rank=]  hero vs hero: pro games + public games by rank (no match needed)
 *   POST /api/coach/:id/ask                  a follow-up question (SSE)
 * Origin: DOTA2AI_API_BASE, default https://dota2.ai. No keys needed.
 *
 * Errors carry `code`: INVALID_INPUT (exit 2), NOT_FOUND (exit 3: match or
 * account missing, or no data yet), UPSTREAM (exit 4).
 */

const STEAM64_BASE = 76561197960265728n;
const MAX_ACCOUNT = 2n ** 32n - 1n;
const PROFILE_HOSTS = ['steamcommunity.com', 'opendota.com', 'dotabuff.com', 'stratz.com'];

export function apiError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

export const EXIT = { INVALID_INPUT: 2, NOT_FOUND: 3, UPSTREAM: 4 };

function fromDigits(d) {
  if (!/^\d{1,20}$/.test(d)) return null;
  const n = BigInt(d);
  if (n >= 1n && n <= MAX_ACCOUNT) return n.toString();
  if (n > STEAM64_BASE && n - STEAM64_BASE <= MAX_ACCOUNT) return (n - STEAM64_BASE).toString();
  return null;
}

/**
 * A Steam friend code (32-bit account id), SteamID64, [U:1:n], or a Steam /
 * OpenDota / Dotabuff / STRATZ profile link -> the friend code. Vanity Steam
 * URLs (/id/name) need a Steam API call and are rejected with a hint.
 */
export function parseAccount(input) {
  const raw = String(input ?? '').trim();
  const bare = fromDigits(raw);
  if (bare) return bare;
  const u1 = raw.match(/^\[?U:1:(\d{1,10})\]?$/i);
  if (u1 && fromDigits(u1[1])) return fromDigits(u1[1]);
  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { url = null; }
  const host = url?.hostname.toLowerCase() ?? '';
  if (url && PROFILE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    if (/^\/id\/[^/]+/i.test(url.pathname) && host.endsWith('steamcommunity.com')) {
      throw apiError('INVALID_INPUT', 'Steam custom URLs (/id/name) cannot be resolved: use the friend code shown in Dota 2, or a /profiles/7656… link');
    }
    const m = url.pathname.match(/^\/(?:profiles|players)\/(\d{1,20})(?=\/|$)/i);
    const id = m ? fromDigits(m[1]) : null;
    if (id) return id;
  }
  throw apiError('INVALID_INPUT', `Not a Steam friend code or profile link: ${raw || '(empty)'}`);
}

export function parseMatchId(raw) {
  const s = String(raw ?? '');
  if (!/^[1-9]\d{0,12}$/.test(s)) throw apiError('INVALID_INPUT', `Not a match id: ${s || '(empty)'}`);
  return s;
}

/** Seat index (0-9) of a hero in a report: slug, English or Chinese name, or hero id. */
export function findSeat(report, hero) {
  if (hero == null || hero === '') return null;
  const q = String(hero).toLowerCase().replace(/[\s_-]/g, '');
  const p = report.players.find((x) => String(x.hero.id) === q || x.hero.slug.replace(/_/g, '') === q
    || x.hero.en.toLowerCase().replace(/[\s_-]/g, '') === q || x.hero.zh === hero);
  if (!p) throw apiError('INVALID_INPUT', `Hero not in this match: ${hero}`);
  return p.slot;
}

/**
 * @param {{ env?: Record<string, string|undefined>, fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 */
// A follow-up can take the server's whole provider chain (40 s per model,
// a second model, then the report fallback): give it room to finish.
export const ASK_TIMEOUT_MS = 180_000;

export function createCoachApi({ env = process.env, fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = 30000, askTimeoutMs = ASK_TIMEOUT_MS } = {}) {
  const base = env.DOTA2AI_API_BASE || 'https://dota2.ai';
  const url = (path) => new URL(path, base);

  async function request(path, init = {}, ms = timeoutMs) {
    let res;
    try {
      res = await fetchImpl(url(path), { ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(ms) });
    } catch {
      throw apiError('UPSTREAM', 'dota2.ai request failed');
    }
    return res;
  }
  async function getJson(path) {
    const res = await request(path);
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = body?.error ?? `HTTP ${res.status}`;
      if (res.status === 400) throw apiError('INVALID_INPUT', msg);
      if (res.status === 404 || res.status === 422) throw apiError('NOT_FOUND', msg, { reason: body?.code ?? null });
      throw apiError('UPSTREAM', msg, { status: res.status, retryAfterSec: Number(res.headers?.get?.('retry-after')) || undefined });
    }
    if (!body || typeof body !== 'object') throw apiError('UPSTREAM', 'dota2.ai returned no JSON');
    return body;
  }

  return {
    base,
    /** The full coach report (every seat). */
    report: (matchId) => getJson(`/api/coach/${parseMatchId(matchId)}`),
    /** Pro games on the same problem, for one seat (parsed matches only). */
    cases: (matchId, seat, lang = 'en') => getJson(`/api/coach/${parseMatchId(matchId)}/cases?slot=${Number(seat)}&lang=${lang === 'zh' ? 'zh' : 'en'}`),
    /** A player's recent public games; `account` is a friend code or profile link. */
    recent: (account) => getJson(`/api/coach/players/${parseAccount(account)}/recent`),
    /** Hero vs hero from pro games: lane baseline, win rate, counter items both ways, Valve ability facts. */
    matchup: (hero, vs, rank) => getJson(`/api/coach/matchup?hero=${encodeURIComponent(String(hero ?? ''))}&vs=${encodeURIComponent(String(vs ?? ''))}${rank ? `&rank=${encodeURIComponent(String(rank))}` : ''}`),
    /**
     * Ask a follow-up about one seat. Streams text to onText, resolves with the
     * whole answer, whether it came from the report fallback (no AI), and the
     * notice the server sent with it.
     */
    async ask(matchId, seat, question, { lang = 'en', onText = () => {} } = {}) {
      const res = await request(`/api/coach/${parseMatchId(matchId)}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ question, slot: Number(seat), lang: lang === 'zh' ? 'zh' : 'en' }),
      }, askTimeoutMs);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const msg = body?.error ?? `HTTP ${res.status}`;
        throw apiError(res.status === 400 ? 'INVALID_INPUT' : res.status === 404 || res.status === 422 ? 'NOT_FOUND' : 'UPSTREAM', msg);
      }
      let text = '';
      let fallback = false;
      let notice = null;
      let done = false;
      let buf = '';
      const decoder = new TextDecoder();
      const take = (frame) => {
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) return;
        let msg;
        try { msg = JSON.parse(line.slice(6)); } catch { return; }
        if (typeof msg.text === 'string') { text += msg.text; onText(msg.text); }
        if (msg.fallback) fallback = true;
        if (msg.notice) notice = msg.notice;
        if (msg.done) done = true;
        if (msg.error) throw apiError('UPSTREAM', String(msg.error));
      };
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { take(buf.slice(0, i)); buf = buf.slice(i + 2); }
      }
      if (buf.trim()) take(buf);
      // A stream that ends without the terminal frame was cut off: never
      // hand a truncated answer over as a complete one (same as the web client).
      if (!done) throw apiError('UPSTREAM', 'The answer was cut off before it finished; ask again', { partial: text });
      return { text, fallback, notice };
    },
  };
}
