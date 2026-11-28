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
  dota2ai trace  [<tool> --trace file …]               ask a parsed replay: deaths, ability casts, fights (JSON; no tool = list them)

Every command takes --lang en|zh and --json (stable machine output).
Exit codes: 0 ok · 2 invalid input · 3 not found / no data yet · 4 upstream.
Origin: DOTA2AI_API_BASE (default https://dota2.ai). No keys needed.`;

export async function run(args, { stdout = process.stdout, stderr = process.stderr, ...dependencies } = {}) {
  if (args[0] === 'coach') return runCoach(args, { stdout, stderr, env: dependencies.env, fetchImpl: dependencies.fetchImpl });
  if (args[0] === 'trace') return runTrace(args, { stdout, stderr });
  if (AGENT_COMMANDS.includes(args[0])) return runAgentCommand(args, { stdout, stderr, env: dependencies.env, fetchImpl: dependencies.fetchImpl });
  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h' || args.length === 0) { stdout.write(`${HELP}\n`); return 0; }
  stderr.write(`Unknown command: ${args[0]}\nRun "dota2ai help" to see available commands.\n`);
  return 2;
}
