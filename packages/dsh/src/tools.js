import { TOOL_DOCS, COACH_TOOLS } from 'dota2ai/tools';
import { SECTIONS } from 'dota2ai/render';
import { coachErrorText } from 'dota2ai/handlers';
import { PREFIX, TOOL_NAMES } from './toolNames.js';

export { PREFIX, TOOL_NAMES };

const idOrName = (description) => ({ oneOf: [{ type: 'string' }, { type: 'integer' }], ...(description ? { description } : {}) });
const LANG = { type: 'string', enum: ['en', 'zh'], description: 'Answer language; follow the user (en | zh)' };
const MATCH = { ...idOrName('Dota 2 match ID'), required: true };

/** dsh-tools parameter DSL per tool (`required: true` marks a required argument). */
export const PARAMETERS = {
  replay_review: {
    match_id: MATCH,
    hero: idOrName(TOOL_DOCS.replay_review.params.hero),
    lang: LANG,
    retry: { type: 'boolean', description: TOOL_DOCS.replay_review.params.retry },
  },
  recent_matches: {
    account: { type: 'string', required: true, description: 'Steam friend code or a Steam/OpenDota/Dotabuff/STRATZ profile link' },
  },
  coach_report: {
    match_id: MATCH,
    hero: idOrName('The hero the user played; omit to get the roster'),
    lang: LANG,
    section: { type: 'string', enum: [...SECTIONS] },
  },
  coach_cases: { match_id: MATCH, hero: { ...idOrName(), required: true }, lang: LANG },
  coach_ask: {
    match_id: MATCH,
    hero: { ...idOrName(), required: true },
    lang: LANG,
    question: { type: 'string', required: true, description: 'The follow-up question (at most 500 characters)' },
  },
  goal_check: {
    match_id: MATCH,
    hero: { ...idOrName(), required: true },
    lang: LANG,
    goal: { type: 'object', additionalProperties: true, required: true, description: "A finding's `goal` object from coach_report (section all)" },
  },
  hero_matchup: {
    hero: { ...idOrName(), required: true },
    vs: { ...idOrName(), required: true },
    rank: { type: 'string', description: TOOL_DOCS.hero_matchup.params.rank },
  },
};

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
};

/** A thrown error whose message is safe to show the model (never raw upstream data). */
export class ToolFailure extends Error {}

/**
 * @param {{ coach: Record<string, Function>, replay: { review: Function }, lang?: 'en' | 'zh' }} deps
 *   coach: dota2ai/handlers createCoachHandlers(); replay: ./replay.js createReplayClient().
 *   lang: the plugin's default answer language when a call names none.
 * @returns {Array<object>} options for dsh-tools `defineTool`
 */
export function toolOptions({ coach, replay, lang = 'en' }) {
  const withLang = (args) => (args?.lang ? args : { ...args, lang });
  const coachTool = (name) => ({
    name: PREFIX + name,
    description: TOOL_DOCS[name].description,
    parameters: PARAMETERS[name],
    output: OUTPUT,
    timeoutMs: name === 'coach_ask' ? 200_000 : 60_000,
    async execute(args, exec) {
      try {
        return await coach[name](withLang(args), exec?.signal);
      } catch (error) {
        throw new ToolFailure(coachErrorText(error));
      }
    },
  });
  return [
    {
      name: PREFIX + 'replay_review',
      description: TOOL_DOCS.replay_review.description,
      parameters: PARAMETERS.replay_review,
      output: OUTPUT,
      timeoutMs: 90_000,
      async execute(args, exec) {
        try {
          return await replay.review(withLang(args), { signal: exec?.signal });
        } catch (error) {
          // REMOTE_TOOL: the hosted tool's own fixed wording (rate limit, bad input).
          const known = ['INVALID_INPUT', 'RATE_LIMITED', 'REMOTE_TOOL'].includes(error?.code);
          throw new ToolFailure(known ? error.message : 'Replay review request failed (temporary; retry later)');
        }
      },
    },
    ...COACH_TOOLS.map(coachTool),
  ];
}
