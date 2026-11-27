/**
 * web_search: DeepSeek's Search API (POST https://api.deepseek.com/v1/tools/search) as one more lookup tool of the
 * review and the chat. The replay and the site's data say what happened and what the numbers are; a page on the
 * web can say how an ability works or how players handle a hero, which no table here holds (owner, 2026-11-27).
 *
 * What comes back is not this game's data and the site has not checked it, so it is reading for the model only:
 * - no `ref`: nothing in the review can cite it;
 * - the review's and the chat's checks leave it out of the facts they accept (isWebSearchResult), so a number or a
 *   clock from a web page never passes as one a tool stated;
 * - each page keeps its date, for the model to set against the game's patch.
 *
 * The query is the model's: one with a long run of digits (a match or account id) is refused, never sent.
 * A few calls per review or chat answer (MAX_CALLS); the API bills $0.75 per 1000 searches that return results.
 */

const ENDPOINT = 'https://api.deepseek.com/v1/tools/search';
/** Searches one toolkit (one review, or one chat answer) may make. */
export const MAX_CALLS = 4;
const RESULTS = 5;
const TIMEOUT_MS = 15000;
const SUMMARY_CHARS = 800;

export const WEB_SEARCH_TOOL = {
  name: 'web_search',
  description: 'Search the web (DeepSeek Search) for how something in Dota 2 works or how players deal with it — an ability\'s mechanics, what beats a hero, why an item is built against it. Pages come back with title, url, site, date and a summary. They are not this game\'s data and the site has not checked them: they cannot be cited (no ref) and a number from them cannot be stated in the review; a page from before this game\'s patch (data_patch) may be out of date. Ask about heroes, abilities and items, never about this match or its players. At most 4 searches.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'What to search for, at most 128 characters, e.g. "Ursa Fury Swipes counter items" or "熊战士 克制 装备".' } },
    required: ['query'],
    additionalProperties: false,
  },
};

/** A web_search answer: left out of the facts a review or a chat answer may state. */
export const isWebSearchResult = (r) => r?.tool === 'web_search';

const NOTE = 'Pages from the web, not this game\'s data and not checked by the site. Read them to understand a mechanic or a matchup; cite only the lookup tools, and state no number from these pages. Check each page\'s date against the game\'s patch.';

/**
 * @param {{ apiKey?: string | null, fetchImpl?: typeof fetch, maxCalls?: number, timeoutMs?: number }} [o]
 * @returns {(args: { query?: unknown }) => Promise<object>}  one per toolkit: the call count is its own
 */
export function createWebSearch({ apiKey = null, fetchImpl = globalThis.fetch, maxCalls = MAX_CALLS, timeoutMs = TIMEOUT_MS } = {}) {
  let calls = 0;
  return async (args = {}) => {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const base = { tool: 'web_search', query };
    if (!apiKey) return { ...base, error: 'web_search_not_configured' };
    if (query.length < 2 || [...query].length > 128) return { ...base, error: 'query_must_be_2_to_128_characters' };
    // A match id, an account id or a Steam id is never sent out.
    if (/\d{6,}/.test(query)) return { ...base, error: 'query_has_an_id: search for heroes, abilities and items, not this match or its players' };
    if (calls >= maxCalls) return { ...base, error: `web_search_limit_reached: ${maxCalls} searches` };
    calls += 1;
    let res;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, count: RESULTS }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ...base, error: 'web_search_unreachable' };
    }
    if (!res.ok) return { ...base, error: `web_search_failed_${res.status}` };
    let body;
    try { body = await res.json(); } catch { return { ...base, error: 'web_search_bad_answer' }; }
    if (!Array.isArray(body?.results)) return { ...base, error: 'web_search_bad_answer' };
    const results = body.results.slice(0, RESULTS).map((r) => ({
      title: String(r?.title ?? ''),
      url: String(r?.url ?? ''),
      ...(r?.site_name ? { site: String(r.site_name) } : {}),
      // Null when the page does not say: not "recent".
      date: typeof r?.date === 'string' ? r.date.slice(0, 10) : null,
      summary: String(r?.summary || r?.snippet || '').replace(/\s+/g, ' ').slice(0, SUMMARY_CHARS),
    })).filter((r) => r.url);
    return { ...base, source: 'DeepSeek Search', results, note: NOTE };
  };
}

/** The search of a review or chat run, from the server's environment: DEEPSEEK_API_KEY, off with AGENT_WEB_SEARCH=0. */
export function webSearchFromEnv(env = process.env) {
  return createWebSearch({ apiKey: env.AGENT_WEB_SEARCH === '0' ? null : env.DEEPSEEK_API_KEY || null });
}
