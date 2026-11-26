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
