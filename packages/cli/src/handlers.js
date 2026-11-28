import { invalid } from './client.js';
import { createCoachApi, findSeat } from './coachApi.js';
import { sectionJson, seatJson } from './coach.js';
import { loadGoals } from './agent.js';

/**
 * The coach for personal agents: recent games, the review with its "why"
 * causes and chapters, pro cases, follow-ups and goal checks — the same public
 * API and shapes as the `dota2ai` CLI. Shared by the stdio MCP server
 * (@dota2ai/mcp) and the DSH plugin (packages/dsh). `coach` may be injected
 * (tests, or an in-process coach on the server).
 */
export function createCoachHandlers(options = {}) {
  const api = options.coach ?? createCoachApi(options);
  const surface = options.surface ?? null;
  const toolPrefix = typeof options.toolPrefix === 'string' ? options.toolPrefix : '';
  const replayTool = `${toolPrefix}replay_review`;
  const reportTool = `${toolPrefix}coach_report`;
  const replayAvailability = typeof options.replayAvailability === 'function'
    ? options.replayAvailability
    : (typeof api.replayAvailability === 'function' ? api.replayAvailability : null);

  const seatOf = async (args) => {
    if (args?.hero == null || args.hero === '') throw invalid(`hero is required: call ${reportTool} without it to see the roster, then ask the user`);
    const report = await api.report(args.match_id);
    return { report, seat: findSeat(report, args.hero) };
  };

  async function noParsedMatchCases(report, seat) {
    let avail = null;
    if (replayAvailability) {
      try { avail = await replayAvailability(String(report.match.id)); } catch { avail = null; }
    }
    const hasTrace = typeof avail?.trace === 'boolean' ? avail.trace : null;
    const canReplayReview = hasTrace === true
      ? true
      : typeof avail?.can_parse === 'boolean'
        ? avail.can_parse
        : null;
    const message = hasTrace === true
      ? `Pro case studies need an OpenDota-parsed match (OpenDota currently has basic scoreboard data only), but this match's Valve replay trace is already available. Call ${replayTool} for a full replay review, or ${reportTool} for the basic scoreboard summary.`
      : `Pro case studies need an OpenDota-parsed match (OpenDota currently has basic scoreboard data only). Call ${replayTool} to parse the Valve replay directly for a full replay review, or ${reportTool} for the basic scoreboard summary.`;
    return {
      status: 'no_parsed_match',
      reason: 'needs_parse',
      ...(surface ? { surface } : {}),
      match_id: String(report.match.id),
      seat,
      hero: report.players?.[seat]?.hero?.slug ?? null,
      match_parsed: false,
      basic_report_available: true,
      replay_trace_available: hasTrace,
      replay_review_available: canReplayReview,
      next_tool: replayTool,
      message,
    };
  }

  return {
    recent_matches: (args) => api.recent(args.account),
    async coach_report(args) {
      const report = await api.report(args.match_id);
      const parsed = Boolean(report.match?.parsed);
      const reportScope = parsed ? 'parsed_scoreboard' : 'basic_scoreboard_only';
      if (args.hero == null || args.hero === '') {
        return {
          schema: report.schema, match: report.match, data_gaps: report.data_gaps,
          report_scope: reportScope,
          ...(surface ? { surface } : {}),
          roster: report.players.map((p) => ({ seat: p.slot, hero: p.hero, radiant: p.radiant, kda: p.kda })),
          note: parsed
            ? 'Pick the user\'s hero (ask them; never guess), then call again with hero.'
            : `Pick the user's hero (ask them; never guess), then call again with hero. OpenDota currently has basic scoreboard data only for this match; use ${replayTool} for full Valve replay analysis.`,
        };
      }
      const seat = findSeat(report, args.hero);
      const section = args.section ?? 'summary';
      if (section === 'all') return seatJson(report, seat);
      return {
        section,
        value: sectionJson(report, seat, section),
        report_scope: reportScope,
        ...(surface ? { surface } : {}),
        ...(!parsed ? {
          parsed: false,
          data_gaps: report.data_gaps,
          next_tool: replayTool,
          note: `OpenDota has not parsed this match yet (basic scoreboard only; lane/deaths/items/fights timelines are missing here). Call ${replayTool} to analyze the full Valve replay directly.`,
        } : {}),
        url: `https://dota2.ai/r/${report.match.id}?p=${seat}`,
      };
    },
    async coach_cases(args) {
      const { report, seat } = await seatOf(args);
      if (report.match?.parsed === false) {
        return noParsedMatchCases(report, seat);
      }
      try {
        return await api.cases(args.match_id, seat, args.lang);
      } catch (error) {
        if (error?.reason === 'needs_parse') {
          return noParsedMatchCases(report, seat);
        }
        throw error;
      }
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

/** Codes whose message is our own fixed wording (never raw upstream data). */
export const KNOWN_COACH_ERRORS = ['INVALID_INPUT', 'NOT_FOUND', 'RATE_LIMITED', 'UPSTREAM'];

/**
 * What an agent is told when a coach tool fails: "retry later" (UPSTREAM,
 * RATE_LIMITED with its wait) vs "fix the input" (INVALID_INPUT) vs "no such
 * match/player" (NOT_FOUND). Anything else is a fixed generic line.
 */
export function coachErrorText(error) {
  if (!KNOWN_COACH_ERRORS.includes(error?.code)) return 'Coach request failed';
  return error.code === 'UPSTREAM' ? `${error.message} (temporary; retry later)` : error.message;
}
