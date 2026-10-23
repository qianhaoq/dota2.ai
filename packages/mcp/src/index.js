import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createReviewClient, invalid } from 'dota2ai/client';

export function createToolHandlers(options = {}) {
  const review = options.review ?? createReviewClient(options);
  return {
    review_match: args => review(args),
    async get_evidence(args) {
      if (args?.hero == null) throw invalid('Hero is required');
      const result = await review(args);
      const insight = result.insights.find(i => i.id === args.insight_id);
      if (!insight) throw invalid('Unknown insight_id');
      return {
        insight,
        facts: Object.fromEntries(insight.fact_ids.filter(id => Object.hasOwn(result.facts, id)).map(id => [id, result.facts[id]])),
        evidence: insight.evidence,
        citations: result.citations.filter(c => insight.citations.includes(c.id)),
        data_gap: insight.data_gap,
      };
    },
  };
}
export function createMcpServer(options = {}) {
  const server = new McpServer({ name: 'dota2ai', version: '0.1.0' });
  const handlers = createToolHandlers(options);
  const fields = { match_id: z.union([z.string(), z.number()]), hero: z.union([z.string(), z.number()]).optional(), lang: z.enum(['en', 'zh']).optional() };
  const invoke = name => async args => {
    try {
      const result = await handlers[name](args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.code === 'INVALID_INPUT' ? error.message : 'Review request failed' }] };
    }
  };
  server.registerTool('review_match', { description: 'Review a Dota 2 match using OpenDota evidence', inputSchema: fields }, invoke('review_match'));
  server.registerTool('get_evidence', { description: 'Get the facts and citations supporting one insight', inputSchema: { ...fields, hero: z.union([z.string(), z.number()]), insight_id: z.string().min(1) } }, invoke('get_evidence'));
  return server;
}
/** Attach stateless Streamable HTTP; each request owns its server and cleanup. */
export function attachMcp(app, { path = '/mcp', reviewForRequest, ...options } = {}) {
  app.post(path, async (req, res, next) => {
    const server = createMcpServer({ ...options, ...(reviewForRequest ? { review: reviewForRequest(req, res) } : {}) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => { void server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      await server.close().catch(() => {});
      if (!res.headersSent) next(error);
      else if (!res.writableEnded) res.end();
    }
  });
  // This stateless server does not open unsolicited SSE streams or sessions.
  app.get(path, (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Use POST for stateless MCP' }));
  app.delete(path, (_req, res) => res.status(405).set('Allow', 'POST').end());
  return app;
}
