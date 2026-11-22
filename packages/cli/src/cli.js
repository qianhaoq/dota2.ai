import { createReviewClient, invalid, normalizeInput } from './client.js';
import { runCoach } from './coach.js';
import { AGENT_COMMANDS, runAgentCommand } from './agent.js';
import { runTrace } from './trace.js';

export const HELP = `dota2ai — the dota2.ai coach in your terminal (and for your agent)

  dota2ai recent <friend code | profile link>          your recent public games
  dota2ai coach  <matchId> --hero h [--section s]      the review: summary, why, lane, deaths, items, fights, plan, all
  dota2ai cases  <matchId> --hero h                    pro games on the same problem
  dota2ai ask    <matchId> --hero h "question"         a follow-up, answered from the report
  dota2ai goal   set <matchId> --hero h | show | check  a next-game goal, checked on your next game
  dota2ai matchup <hero> <vs> [--rank di]              hero vs hero: pro games + public games at a rank (no match needed)
  dota2ai review <matchId> [--hero h] [--offline]      the v1 evidence review (dota2.ai/review@1)
  dota2ai trace  [<tool> --trace file …]               ask a parsed replay: deaths, ability casts, fights (JSON; no tool = list them)

Every command takes --lang en|zh and --json (stable machine output).
Exit codes: 0 ok · 2 invalid input · 3 not found / no data yet · 4 upstream.
Origin: DOTA2AI_API_BASE (default https://dota2.ai). No keys needed.`;

export function parseArgs(args) {
  if (args[0] !== 'review' || !args[1]) throw invalid('Usage: dota2ai review <matchId> [--hero slug|id] [--lang en|zh] [--json] [--offline]');
  const options = { match_id: args[1], lang: 'en', json: false, offline: false };
  const seen = new Set();
  for (let i = 2; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw invalid(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === '--json' || flag === '--offline') options[flag.slice(2)] = true;
    else if (flag === '--hero' || flag === '--lang') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw invalid(`Missing value: ${flag}`);
      options[flag.slice(2)] = value;
    } else throw invalid(`Unknown option: ${flag}`);
  }
  normalizeInput(options);
  return options;
}
export async function run(args, { stdout = process.stdout, stderr = process.stderr, ...dependencies } = {}) {
  if (args[0] === 'coach') return runCoach(args, { stdout, stderr, env: dependencies.env, fetchImpl: dependencies.fetchImpl });
  if (args[0] === 'trace') return runTrace(args, { stdout, stderr });
  if (AGENT_COMMANDS.includes(args[0])) return runAgentCommand(args, { stdout, stderr, env: dependencies.env, fetchImpl: dependencies.fetchImpl });
  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h' || args.length === 0) { stdout.write(`${HELP}\n`); return 0; }
  try {
    const options = parseArgs(args);
    const review = await createReviewClient({ ...dependencies, offline: options.offline })(options);
    stdout.write(options.json ? `${JSON.stringify(review)}\n` : `${review.player?.hero ?? 'Select a hero'}: ${review.player?.result ?? review.state}\n${review.insights.slice(0, 3).map(i => i.claim.text).join('\n')}\n`);
    return review.state === 'insufficient' ? 3 : 0;
  } catch (error) {
    stderr.write(`${error.code === 'INVALID_INPUT' ? error.message : 'Review request failed'}\n`);
    return error.code === 'INVALID_INPUT' ? 2 : 4;
  }
}
