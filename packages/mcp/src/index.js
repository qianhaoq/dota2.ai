import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createReviewClient, invalid } from 'dota2ai/client';
import { createCoachApi, findSeat } from 'dota2ai/coach';
import { sectionJson, seatJson, SECTIONS } from 'dota2ai/render';
import { loadGoals } from 'dota2ai/agent';

/**
 * The coach for personal agents (stdio): recent games, the review with its
 * "why" causes and chapters, pro cases, follow-ups and goal checks — the same
 * public API and shapes as the `dota2ai` CLI. `coach` may be injected (tests).
 */
export function createCoachHandlers(options = {}) {
  const api = options.coach ?? createCoachApi(options);
  const seatOf = async (args) => {
    if (args?.hero == null || args.hero === '') throw invalid('hero is required: call coach_report without it to see the roster, then ask the user');
    const report = await api.report(args.match_id);
    return { report, seat: findSeat(report, args.hero) };
  };
  return {
    recent_matches: (args) => api.recent(args.account),
    async coach_report(args) {
      const report = await api.report(args.match_id);
      if (args.hero == null || args.hero === '') {
        return {
          schema: report.schema, match: report.match, data_gaps: report.data_gaps,
          roster: report.players.map((p) => ({ seat: p.slot, hero: p.hero, radiant: p.radiant, kda: p.kda })),
          note: 'Pick the user\'s hero (ask them; never guess), then call again with hero.',
        };
      }
      const seat = findSeat(report, args.hero);
      const section = args.section ?? 'summary';
      return section === 'all' ? seatJson(report, seat) : { section, value: sectionJson(report, seat, section), url: `https://dota2.ai/r/${report.match.id}?p=${seat}` };
    },
    async coach_cases(args) {
      const { seat } = await seatOf(args);
      return api.cases(args.match_id, seat, args.lang);
    },
    async coach_ask(args) {
      const { seat } = await seatOf(args);
      return api.ask(args.match_id, seat, String(args.question ?? ''), { lang: args.lang });
    },
    async goal_check(args) {
      const { report, seat } = await seatOf(args);
      const { evaluateGoal } = await loadGoals();
      return { match_id: report.match.id, seat, ...evaluateGoal(args.goal, report, seat) };
    },
    hero_matchup: (args) => api.matchup(args.hero, args.vs, args.rank),
  };
}

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
  // Coach tools: local (stdio) servers only by default. A shared HTTP endpoint
  // would send every agent's coach calls from one IP into one rate limit.
  if (options.coachTools !== false) {
    const coach = createCoachHandlers(options);
    const call = (name) => async (args) => {
      try {
        const result = await coach[name](args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const known = error.code === 'INVALID_INPUT' || error.code === 'NOT_FOUND';
        return { isError: true, content: [{ type: 'text', text: known ? error.message : 'Coach request failed' }] };
      }
    };
    const hero = z.union([z.string(), z.number()]);
    const base = { match_id: z.union([z.string(), z.number()]), lang: z.enum(['en', 'zh']).optional() };
    server.registerTool('recent_matches', {
      description: "A player's recent public Dota 2 games (match_id, hero, seat, K/D/A, won). account: Steam friend code or a Steam/OpenDota/Dotabuff/STRATZ profile link.",
      inputSchema: { account: z.string().min(1) },
    }, call('recent_matches'));
    server.registerTool('coach_report', {
      description: 'The dota2.ai coach review of one player in a match. Without hero: the roster (ask the user which hero). section: summary (default: the causes that decided the game, the player\'s first; what to practise; findings) | why (every cause with evidence and fix) | lane | deaths | items | fights | plan | all.',
      inputSchema: { ...base, hero: hero.optional(), section: z.enum(SECTIONS).optional() },
    }, call('coach_report'));
    server.registerTool('coach_cases', {
      description: 'Professional games on the same problem as this player: one that avoided it, one that repeated it, with the numbers compared. Parsed matches only.',
      inputSchema: { ...base, hero },
    }, call('coach_cases'));
    server.registerTool('coach_ask', {
      description: 'A follow-up question about this player\'s review, answered only from the report. fallback=true means no AI was available and the answer is the matching part of the report.',
      inputSchema: { ...base, hero, question: z.string().min(1).max(500) },
    }, call('coach_ask'));
    server.registerTool('goal_check', {
      description: "Judge a later game against a training goal: met | missed | no_opportunity | unknown, with evidence. goal: a finding's `goal` object from coach_report (section all). Only check the goal owner's own games.",
      inputSchema: { ...base, hero, goal: z.record(z.string(), z.unknown()) },
    }, call('goal_check'));
    server.registerTool('hero_matchup', {
      description: 'Hero vs hero from professional games, no match needed: pro win rate and lane gold at 10:00 (verdict only when the gap is real, always with the sample size), the finished items pros on each side build clearly more often against the other, and Valve data on the other hero\'s abilities (damage type, goes through spell immunity). `by_rank`: the same pair in public games per rank bracket (hg Herald–Guardian, ca Crusader–Archon, la Legend–Ancient, di Divine–Immortal) from STRATZ: win rate and same-lane won/even/lost; credit STRATZ (`rank_source.attribution`) when you quote it. `lines` has the same in plain English and Chinese (rank lines only for the `rank` asked). hero / vs: id, slug, English or Chinese name.',
      inputSchema: { hero, vs: hero, rank: z.string().max(20).optional().describe('Rank bracket: hg | ca | la | di, a medal name (e.g. legend) or an OpenDota rank_tier (e.g. 54)') },
    }, call('hero_matchup'));
  }
  return server;
}
/** Attach stateless Streamable HTTP; each request owns its server and cleanup. */
export function attachMcp(app, { path = '/mcp', reviewForRequest, ...options } = {}) {
  app.post(path, async (req, res, next) => {
    const server = createMcpServer({ coachTools: false, ...options, ...(reviewForRequest ? { review: reviewForRequest(req, res) } : {}) });
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
