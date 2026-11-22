const error = { type: 'object', required: ['code', 'retryable', 'message_key'], properties: { code: { enum: ['MATCH_NOT_FOUND', 'UPSTREAM_TIMEOUT', 'RATE_LIMITED', 'INVALID_INPUT', 'INTERNAL'] }, retryable: { type: 'boolean' }, message_key: { type: 'string' } } };
const parameters = [
  { name: 'matchId', in: 'path', required: true, schema: { type: 'integer', minimum: 1, maximum: 2 ** 40 } },
  { name: 'hero', in: 'query', schema: { type: 'string' }, description: 'Whitelisted hero slug or numeric ID' },
  { name: 'lang', in: 'query', schema: { enum: ['en', 'zh'], default: 'en' } },
];
const responses = content => ({
  200: { description: 'Success', content },
  ...Object.fromEntries([400, 404, 429, 500, 504].map(status => [status, { description: 'Unified error; streams emit a terminal error event', ...(status === 429 ? { headers: { 'Retry-After': { schema: { type: 'integer', minimum: 1 }, description: 'Seconds until retry' } } } : {}), content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }])),
});
const sse = { 'text/event-stream': { schema: { type: 'string' }, example: 'retry: 3000\n\nid: 1\nevent: done\ndata: {"state":"parsed"}\n\n' } };
export const openapi = {
  openapi: '3.1.0', info: { title: 'dota2.ai Review API', version: '1.0.0' },
  paths: {
    '/api/v1/review/{matchId}': { get: { parameters, responses: responses({ 'application/json': { schema: { $ref: './schema/review.v1.json' } } }) } },
    '/api/v1/review/{matchId}/stream': { get: { parameters: [...parameters, { name: 'Last-Event-ID', in: 'header', schema: { type: 'integer', minimum: 0 } }], description: 'Ordered progress, hero_pick, card, token, done/error events. IDs increase; heartbeat every 15 seconds. Cached replay resumes after Last-Event-ID. done.review is the complete JSON review.', responses: responses(sse) } },
    '/api/v1/review/{matchId}/ask': { post: { parameters: [parameters[0]], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['hero'], properties: { hero: { type: ['string', 'integer'] }, lang: { enum: ['en', 'zh'] }, followup_id: { type: 'string' }, question: { type: 'string', maxLength: 300 } }, anyOf: [{ required: ['followup_id'] }, { required: ['question'] }] } } } }, responses: responses(sse) } },
    '/mcp': { post: { description: 'Stateless Streamable HTTP MCP. Tools: review_match({match_id,hero?,lang?}), get_evidence({match_id,hero,insight_id}), recent_matches({account}), coach_report({match_id,hero?,section?,lang?}), coach_cases({match_id,hero,lang?}), coach_ask({match_id,hero,question,lang?}), goal_check({match_id,hero,goal}), hero_matchup({hero,vs,rank?}). Coach tools share the per-caller rate limit of the web coach; a rate-limited call returns isError with the wait. Send Accept: application/json, text/event-stream.', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' }, example: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } } } }, responses: { 200: { description: 'MCP JSON-RPC response', content: { 'application/json': { schema: { type: 'object' } } } }, 202: { description: 'Notification accepted' } } }, get: { description: 'Stateless transport has no SSE subscription', responses: { 405: { description: 'Use POST' } } } },
    '/api/v1/config': { get: { responses: responses({ 'application/json': { schema: { type: 'object' } } }) } },
    '/llms.txt': { get: { responses: responses({ 'text/plain': { schema: { type: 'string' } } }) } },
  }, components: { schemas: { Error: error } },
};
export const llms = `# dota2.ai
Dota 2 match reviews grounded in OpenDota facts. Never invent numbers; all displayed numbers come from match evidence. Five-minute adverse gold windows determine turning points; death minutes use floor(time/60). Missing data is disclosed.

Coach (the main review, deterministic, bilingual en/zh objects):
- Page: /r/{matchId}?p={seat 0-9}&lang=zh
- GET /api/coach/{matchId} returns dota2.ai/coach-report@1: match, players[10], reviews[10] (findings, chapters: story.why causes {id, phase, mine, impact, title, evidence[], fix}, laning, deaths, items, fights, plan), data_gaps.
- GET /api/coach/{matchId}/cases?slot={seat} returns pro games on the same problem (parsed matches only).
- POST /api/coach/{matchId}/ask with {question, slot, lang} streams SSE data frames {text}, then {done:true}; {fallback:true} marks an answer taken from the report.
- GET /api/coach/players/{friendCode}/recent returns a player's recent public games with their seat.
- GET /api/coach/matchup?hero={hero}&vs={hero}[&rank=hg|ca|la|di|medal|tier] returns hero vs hero (no match needed); by_rank = public games per rank bracket (data: STRATZ, credit rank_source.attribution); from pro games: win_rate, lane (gold at 10:00), your_items_vs_them / their_items_vs_you (items pros build clearly more often), their_abilities (Valve: damage type, pierces spell immunity), lines {en, zh}. Verdicts only on real gaps; null means too few pro games.
- CLI: node packages/cli/bin/dota2ai.js help — recent, coach --section why|lane|deaths|items|fights|plan, cases, ask, goal set|show|check, matchup <hero> <vs> [--rank]; --json everywhere.
- Agent skill: packages/cli/skills/dota2ai-coach/SKILL.md
- Remote MCP (no install): claude mcp add --transport http dota2ai https://dota2.ai/mcp — all 8 tools: review_match, get_evidence, recent_matches, coach_report({match_id,hero?,section?}), coach_cases, coach_ask, goal_check, hero_matchup({hero,vs,rank?}).
Coach rate limit: 40 requests/minute/IP. Respect Retry-After.

Review page: /r/{matchId}?p={seat 0-9}&lang=en (also zh). Player page: /p/{friend code}.
GET /api/v1/review/{matchId}?hero=pudge&lang=en returns Review JSON; omit hero for roster selection.
GET /api/v1/review/{matchId}/stream returns SSE v1 with cached Last-Event-ID replay.
POST /api/v1/review/{matchId}/ask accepts {hero,lang,followup_id?,question?}. Presets include death_list, laning_0_10 and item_timings. Unsupported questions receive a data-gap refusal.
GET /api/v1/config exposes flags and versions. GET /openapi.json documents the API.
POST /mcp provides stateless Streamable HTTP MCP with all 8 tools: review_match({match_id,hero?,lang?}), get_evidence({match_id,hero,insight_id}), recent_matches({account}), coach_report, coach_cases, coach_ask, goal_check, hero_matchup. Coach tools are rate-limited per caller (IPv6 by /64), like the web coach.
CLI (repository checkout after npm ci): node packages/cli/bin/dota2ai.js review 9035042364 --hero pudge --json (add --offline for OpenDota + template engine).
Packages dota2ai, @dota2ai/mcp and @dota2ai/review-engine are not published on npm yet.
Stdio MCP (repository checkout after npm ci): node packages/mcp/bin/dota2ai-mcp.js [--offline]; DOTA2AI_OFFLINE=1 also enables offline mode.
DOTA2AI_API_BASE overrides the public API origin for CLI and stdio MCP.
No API key needed. Review misses: 30/10 minutes/IP; ask: 20/hour/IP. Respect Retry-After.
Example: /api/v1/review/9035042364?hero=pudge&lang=en
`;
