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
    '/mcp': { post: { description: 'Stateless Streamable HTTP MCP. Tools: review_match({match_id,hero?,lang?}) and get_evidence({match_id,hero,insight_id}). Send Accept: application/json, text/event-stream.', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' }, example: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } } } }, responses: { 200: { description: 'MCP JSON-RPC response', content: { 'application/json': { schema: { type: 'object' } } } }, 202: { description: 'Notification accepted' } } }, get: { description: 'Stateless transport has no SSE subscription', responses: { 405: { description: 'Use POST' } } } },
    '/api/v1/config': { get: { responses: responses({ 'application/json': { schema: { type: 'object' } } }) } },
    '/llms.txt': { get: { responses: responses({ 'text/plain': { schema: { type: 'string' } } }) } },
  }, components: { schemas: { Error: error } },
};
export const llms = `# dota2.ai
Dota 2 match reviews grounded in OpenDota facts. Never invent numbers; all displayed numbers come from match evidence. Five-minute adverse gold windows determine turning points; death minutes use floor(time/60). Missing data is disclosed.

Review page: /m/{matchId}?hero=pudge&lang=en (also zh).
GET /api/v1/review/{matchId}?hero=pudge&lang=en returns Review JSON; omit hero for roster selection.
GET /api/v1/review/{matchId}/stream returns SSE v1 with cached Last-Event-ID replay.
POST /api/v1/review/{matchId}/ask accepts {hero,lang,followup_id?,question?}. Presets include death_list, laning_0_10 and item_timings. Unmatched free questions and permanent gaps receive a soft refusal with up to two answerable follow-up suggestions.
GET /api/v1/config exposes flags and versions. GET /openapi.json documents the API.
POST /mcp provides stateless Streamable HTTP MCP: review_match({match_id,hero?,lang?}), get_evidence({match_id,hero,insight_id}).
CLI: npx dota2ai review 9035042364 --hero pudge --json (add --offline for OpenDota + template engine).
Stdio MCP: npx -p @dota2ai/mcp dota2ai-mcp [--offline]; DOTA2AI_OFFLINE=1 also enables offline mode.
DOTA2AI_API_BASE overrides the public API origin for CLI and stdio MCP.
No API key needed. Review misses: 30/10 minutes/IP; ask: 20/hour/IP. Respect Retry-After.
Example: /api/v1/review/9035042364?hero=pudge&lang=en
`;
