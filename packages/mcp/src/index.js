import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createReviewClient, invalid } from 'dota2ai/client';
import { SECTIONS } from 'dota2ai/render';
import { createCoachHandlers, coachErrorText } from 'dota2ai/handlers';
import { TOOL_DOCS } from 'dota2ai/tools';

/** Moved to dota2ai/handlers (shared with the DSH plugin); re-exported for existing callers. */
export { createCoachHandlers };

export function createToolHandlers(options = {}) {
  const review = options.review ?? createReviewClient(options);
  return {
    review_match: args => review(args),
    async get_evidence(args) {
      if (args?.hero == null) throw invalid('Hero is required');
      const result = await review(args);
      const insight = result.insights.find(i => i.id === args.insight_id);
      if (!insight) throw invalid('Unknown insight_id');
      const learningCitations = new Set(result.citations.filter(c => c.provider === 'kb' && insight.citations.includes(c.id)).map(c => c.id));
      const contextualFacts = Object.fromEntries(Object.entries(result.facts).filter(([,fact]) => learningCitations.has(fact.citation)));
      return {
        insight,
        facts: Object.fromEntries(insight.fact_ids.filter(id => Object.hasOwn(result.facts, id)).map(id => [id, result.facts[id]])),
        evidence: insight.evidence,
        citations: result.citations.filter(c => insight.citations.includes(c.id)),
        data_gap: insight.data_gap,
        // Context is material-linked and unverified, separate from match facts.
        ...(Object.keys(contextualFacts).length ? {contextual_facts:contextualFacts} : {}),
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
  // The deep replay review (dota2.ai's own), only where the server has it in process: attachMcp's
  // replayForRequest gives one per caller, under that caller's limits. It never blocks for minutes: it starts
  // what is missing and the agent polls (lib/agent/replayTool.js).
  if (options.replay) {
    server.registerTool('replay_review', {
      description: TOOL_DOCS.replay_review.description,
      inputSchema: { match_id: z.union([z.string(), z.number()]), hero: z.union([z.string(), z.number()]).optional().describe(TOOL_DOCS.replay_review.params.hero), lang: z.enum(['en', 'zh']).optional(), retry: z.boolean().optional().describe(TOOL_DOCS.replay_review.params.retry) },
    }, async (args) => {
      try {
        const result = await options.replay.review(args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const known = ['INVALID_INPUT', 'RATE_LIMITED'].includes(error?.code);
        return { isError: true, content: [{ type: 'text', text: known ? error.message : 'Replay review request failed (temporary; retry later)' }] };
      }
    });
  }
  // Coach tools: on for local (stdio) servers, which call dota2.ai over HTTP as
  // the user. A remote HTTP endpoint turns them on only with an in-process coach
  // per request (attachMcp's coachForRequest), rate-limited as that caller —
  // never by calling the site over HTTP, which would put every agent behind
  // one IP and one bucket.
  if (options.coachTools !== false) {
    const coach = createCoachHandlers(options);
    const call = (name) => async (args) => {
      try {
        const result = await coach[name](args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        // Known codes carry our own fixed wording (never raw upstream data); see coachErrorText.
        const text = coachErrorText(error);
        return { isError: true, content: [{ type: 'text', text }] };
      }
    };
    const hero = z.union([z.string(), z.number()]);
    const base = { match_id: z.union([z.string(), z.number()]), lang: z.enum(['en', 'zh']).optional() };
    server.registerTool('recent_matches', {
      description: TOOL_DOCS.recent_matches.description,
      inputSchema: { account: z.string().min(1) },
    }, call('recent_matches'));
    server.registerTool('coach_report', {
      description: TOOL_DOCS.coach_report.description,
      inputSchema: { ...base, hero: hero.optional(), section: z.enum(SECTIONS).optional() },
    }, call('coach_report'));
    server.registerTool('coach_cases', {
      description: TOOL_DOCS.coach_cases.description,
      inputSchema: { ...base, hero },
    }, call('coach_cases'));
    server.registerTool('coach_ask', {
      description: TOOL_DOCS.coach_ask.description,
      inputSchema: { ...base, hero, question: z.string().min(1).max(500) },
    }, call('coach_ask'));
    server.registerTool('goal_check', {
      description: TOOL_DOCS.goal_check.description,
      inputSchema: { ...base, hero, goal: z.record(z.string(), z.unknown()) },
    }, call('goal_check'));
    server.registerTool('hero_matchup', {
      description: TOOL_DOCS.hero_matchup.description,
      inputSchema: { hero, vs: hero, rank: z.string().max(20).optional().describe(TOOL_DOCS.hero_matchup.params.rank) },
    }, call('hero_matchup'));
  }
  return server;
}
/** Attach stateless Streamable HTTP; each request owns its server and cleanup. */
export function attachMcp(app, { path = '/mcp', reviewForRequest, coachForRequest, replayForRequest, ...options } = {}) {
  app.post(path, async (req, res, next) => {
    const server = createMcpServer({
      coachTools: false,
      ...options,
      ...(reviewForRequest ? { review: reviewForRequest(req, res) } : {}),
      // All 8 tools only with an in-process coach for this caller (lib/coach/service.js).
      ...(coachForRequest ? { coachTools: true, coach: coachForRequest(req, res) } : {}),
      ...(replayForRequest ? { replay: replayForRequest(req, res) } : {}),
    });
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
