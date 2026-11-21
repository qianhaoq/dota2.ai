/**
 * The rest of the coach for terminals and agents:
 *
 *   dota2ai recent <friend code | profile link> [--json]
 *   dota2ai cases  <matchId> --hero h [--lang en|zh] [--json]
 *   dota2ai ask    <matchId> --hero h "question" [--lang en|zh] [--json]
 *   dota2ai goal set   <matchId> --hero h [--finding id] [--json]
 *   dota2ai goal show  [--json]
 *   dota2ai goal check [matchId] [--hero h] [--account a] [--json]
 *   dota2ai matchup <hero> <vs> [--rank hg|ca|la|di|<medal>] [--lang en|zh] [--json]   (pro + public games by rank, no match needed)
 *
 * The training goal lives in $DOTA2AI_HOME/goal.json (default ~/.dota2ai),
 * on this machine only. `goal check` judges a later game with the same pure
 * function the web page uses (lib/coach/goals.js evaluateGoal).
 * Exit codes: 0 ok, 2 invalid input, 3 not found / nothing to check, 4 upstream.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createCoachApi, findSeat, apiError, EXIT } from './coachApi.js';

const tr = (lang) => (b) => (b ? b[lang] ?? b.en : '');
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`;
const date = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—');

/** Flags after the positional arguments: --name value, or boolean --json. */
export function parseFlags(args, { values = [], booleans = ['--json'] } = {}) {
  const pos = []; const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (booleans.includes(a)) flags[a.slice(2)] = true;
    else if (values.includes(a)) {
      const v = args[++i];
      if (v == null || v.startsWith('--')) throw apiError('INVALID_INPUT', `Missing value: ${a}`);
      flags[a.slice(2)] = v;
    } else if (a.startsWith('--')) throw apiError('INVALID_INPUT', `Unknown option: ${a}`);
    else pos.push(a);
  }
  if (flags.lang != null && !['en', 'zh'].includes(flags.lang)) throw apiError('INVALID_INPUT', 'Language must be en or zh');
  return { pos, flags };
}

export async function loadGoals() {
  // Packed tarball: vendored copy; repository checkout: the server's own module.
  try { return await import('./vendor/goals.js'); } catch { return import('../../../lib/coach/goals.js'); }
}

function goalFile(env) {
  const dir = env.DOTA2AI_HOME || join(homedir(), '.dota2ai');
  return { dir, file: join(dir, 'goal.json') };
}
export function readGoalState(env) {
  try { return JSON.parse(readFileSync(goalFile(env).file, 'utf8')); } catch { return { goal: null, checks: [] }; }
}
function writeGoalState(env, state) {
  const { dir, file } = goalFile(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

async function runRecent(args, io) {
  const { pos, flags } = parseFlags(args.slice(1), { values: ['--lang'] });
  if (!pos[0]) throw apiError('INVALID_INPUT', 'Usage: dota2ai recent <friend code | profile link> [--json]');
  const body = await io.api.recent(pos[0]);
  if (flags.json) return io.out(body);
  const L = tr(flags.lang ?? 'en');
  const zh = flags.lang === 'zh';
  if (!body.matches.length) return io.say(zh ? '没有公开比赛：资料可能未公开（Dota 2 设置 → 公开比赛数据）。' : 'No public games: the profile may hide match data (Dota 2 settings → Expose Public Match Data).');
  for (const m of body.matches) {
    io.say(`${m.match_id}  ${date(m.start_time)}  ${L(m.hero).padEnd(12)} ${m.kda.join('/').padEnd(9)} ${m.won == null ? '?' : m.won ? (zh ? '胜' : 'W') : (zh ? '负' : 'L')}  ${m.duration ? clock(m.duration) : ''}`);
  }
  io.say('', zh ? `复盘某一局：dota2ai coach <比赛ID> --hero <英雄>` : 'Review one: dota2ai coach <matchId> --hero <hero>');
}

async function seatFor(io, matchId, hero) {
  if (hero == null) throw apiError('INVALID_INPUT', '--hero is required');
  const report = await io.api.report(matchId);
  return { report, seat: findSeat(report, hero) };
}

async function runCases(args, io) {
  const { pos, flags } = parseFlags(args.slice(1), { values: ['--hero', '--lang'] });
  if (!pos[0]) throw apiError('INVALID_INPUT', 'Usage: dota2ai cases <matchId> --hero h [--lang en|zh] [--json]');
  const { seat } = await seatFor(io, pos[0], flags.hero);
  const body = await io.api.cases(pos[0], seat, flags.lang);
  if (flags.json) return io.out(body);
  const L = tr(flags.lang ?? 'en');
  const zh = flags.lang === 'zh';
  for (const th of body.themes ?? []) {
    io.say('', `== ${L(th.title)} ==`);
    for (const [label, c] of [[zh ? '做到了' : 'Did it', th.positive], [zh ? '没做到' : 'Did not', th.negative]]) {
      if (!c) continue;
      io.say(`${label}: ${c.match_id} ${c.won ? (zh ? '赢' : 'won') : (zh ? '输' : 'lost')}${c.teams ? ` · ${L(c.teams)}` : ''}  https://dota2.ai/r/${c.match_id}`);
    }
    for (const a of th.analysis ?? []) io.say(`  - ${L(a)}`);
  }
  if (body.note) io.say('', L(body.note));
}

async function runAsk(args, io) {
  const { pos, flags } = parseFlags(args.slice(1), { values: ['--hero', '--lang'] });
  const [matchId, ...words] = pos;
  const question = words.join(' ').trim();
  if (!matchId || !question) throw apiError('INVALID_INPUT', 'Usage: dota2ai ask <matchId> --hero h "question" [--lang en|zh] [--json]');
  const { seat } = await seatFor(io, matchId, flags.hero);
  const answer = await io.api.ask(matchId, seat, question, { lang: flags.lang, onText: flags.json ? () => {} : (t) => io.write(t) });
  if (flags.json) return io.out({ question, ...answer });
  io.say('');
  if (answer.notice) io.say(`(${typeof answer.notice === 'string' ? answer.notice : tr(flags.lang ?? 'en')(answer.notice)})`);
}

/** The same goal record the web page keeps (src/coach/goalStore.ts goalFromFinding). */
export function goalRecord(report, seat, finding) {
  const m = report.match;
  return {
    id: `${m.id}:${seat}:${finding.id}`,
    goal: finding.goal, action: finding.action ?? finding.ask ?? finding.title, findingId: finding.id,
    fromMatch: m.id, fromStart: m.start_time ?? 0,
    accountId: report.players[seat]?.account_id ?? null,
    heroId: report.players[seat]?.hero.id ?? 0,
    setAt: Date.now(),
  };
}

async function runGoal(args, io) {
  const sub = args[1];
  const { pos, flags } = parseFlags(args.slice(2), { values: ['--hero', '--finding', '--account', '--lang'] });
  const L = tr(flags.lang ?? 'en');
  const zh = flags.lang === 'zh';
  const state = readGoalState(io.env);
  if (sub === 'show') {
    if (flags.json) return io.out(state);
    if (!state.goal) return io.say(zh ? '还没有训练目标：dota2ai goal set <比赛ID> --hero <英雄>' : 'No goal yet: dota2ai goal set <matchId> --hero <hero>');
    io.say(`${L(state.goal.goal.label)} — ${L(state.goal.action)}`);
    const mine = state.checks.filter((c) => c.goalId === state.goal.id);
    for (const c of mine) io.say(`  ${c.matchId}  ${c.result}  ${L(c.evidence)}`);
    return;
  }
  if (sub === 'set') {
    if (!pos[0]) throw apiError('INVALID_INPUT', 'Usage: dota2ai goal set <matchId> --hero h [--finding id]');
    const { report, seat } = await seatFor(io, pos[0], flags.hero);
    const findings = report.reviews[seat].findings.filter((f) => f.goal);
    const f = flags.finding ? findings.find((x) => x.id === flags.finding) : findings.find((x) => x.tone === 'fix') ?? findings[0];
    if (!f) throw apiError('NOT_FOUND', flags.finding ? `No finding with a goal: ${flags.finding} (have: ${findings.map((x) => x.id).join(', ') || 'none'})` : 'No finding in this review has a checkable goal');
    const goal = goalRecord(report, seat, f);
    writeGoalState(io.env, { goal, checks: state.checks ?? [] });
    if (flags.json) return io.out(goal);
    return io.say(`${zh ? '已设为下局目标' : 'Next-game goal set'}: ${L(goal.goal.label)}`, `${zh ? '下一局之后检查' : 'After your next game'}: dota2ai goal check`);
  }
  if (sub === 'check') {
    const goal = state.goal;
    if (!goal) throw apiError('NOT_FOUND', 'No goal set: dota2ai goal set <matchId> --hero h');
    // Same identity rule as the web page (goalStore.checkGoal): a game counts
    // only when it is the goal owner's. Known accounts must match; a seat is
    // never guessed from the hero the goal came from.
    const owner = goal.accountId ?? null;
    if (flags.account != null && owner != null && String(flags.account) !== String(owner)) {
      throw apiError('INVALID_INPUT', `This goal belongs to account ${owner}, not ${flags.account}`);
    }
    let matchId = pos[0] ?? null;
    let seat = null;
    if (!matchId) {
      const account = flags.account ?? owner;
      if (account == null) throw apiError('INVALID_INPUT', 'Give a match id and --hero, or --account <friend code> (this goal has no account)');
      const recent = await io.api.recent(String(account));
      const next = recent.matches.filter((m) => m.match_id !== goal.fromMatch && (m.start_time ?? 0) > goal.fromStart)
        .sort((a, b) => b.start_time - a.start_time)[0];
      if (!next) throw apiError('NOT_FOUND', 'No public game after the one the goal came from yet');
      matchId = String(next.match_id);
      seat = next.slot;
    }
    const report = await io.api.report(matchId);
    if (report.match.id === goal.fromMatch || !(report.match.start_time > goal.fromStart)) throw apiError('INVALID_INPUT', 'That game is not after the one the goal came from');
    if (seat == null) {
      if (flags.hero != null) seat = findSeat(report, flags.hero);
      else if (owner != null) {
        seat = report.players.findIndex((p) => p.account_id === owner);
        if (seat < 0) throw apiError('INVALID_INPUT', 'Your account is not in this match (or it is anonymous): add --hero to say which hero was you');
      } else throw apiError('INVALID_INPUT', 'Which hero were you? Add --hero');
    }
    const acct = report.players[seat]?.account_id ?? null;
    if (owner != null && acct != null && acct !== owner) {
      throw apiError('INVALID_INPUT', `That seat is account ${acct}; this goal belongs to account ${owner}`);
    }
    const { evaluateGoal } = await loadGoals();
    const r = evaluateGoal(goal.goal, report, seat);
    const check = { goalId: goal.id, matchId: report.match.id, result: r.result, evidence: r.evidence };
    const checks = [...(state.checks ?? []).filter((c) => !(c.goalId === goal.id && c.matchId === check.matchId)), check].slice(-30);
    writeGoalState(io.env, { goal, checks });
    if (flags.json) return io.out(check);
    const word = { met: zh ? '做到了' : 'met', missed: zh ? '没做到' : 'missed', no_opportunity: zh ? '这局没有机会' : 'no opportunity', unknown: zh ? '无法判断' : 'unknown' }[r.result];
    return io.say(`${report.match.id}: ${word} — ${L(r.evidence)}`);
  }
  throw apiError('INVALID_INPUT', 'Usage: dota2ai goal set|show|check …');
}

/** Hero vs hero: pro lane baseline, win rate, counter items both ways, Valve ability facts; public games at a rank (STRATZ). */
async function runMatchup(args, io) {
  const { pos, flags } = parseFlags(args.slice(1), { values: ['--lang', '--rank'] });
  const [hero, vs] = pos;
  if (!hero || !vs) throw apiError('INVALID_INPUT', 'Usage: dota2ai matchup <hero> <vs> [--rank hg|ca|la|di|<medal>] [--lang en|zh] [--json]');
  const brief = await io.api.matchup(hero, vs, flags.rank);
  if (flags.json) return io.out(brief);
  return io.say(...(brief.lines?.[flags.lang ?? 'en'] ?? []));
}

const COMMANDS = { recent: runRecent, cases: runCases, ask: runAsk, goal: runGoal, matchup: runMatchup };
export const AGENT_COMMANDS = Object.keys(COMMANDS);

export async function runAgentCommand(args, { stdout, stderr, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const io = {
    env,
    api: createCoachApi({ env, fetchImpl }),
    write: (s) => stdout.write(s),
    say: (...lines) => stdout.write(`${lines.join('\n')}\n`),
    out: (obj) => stdout.write(`${JSON.stringify(obj)}\n`),
  };
  try {
    await COMMANDS[args[0]](args, io);
    return 0;
  } catch (e) {
    stderr.write(`${e.message}\n`);
    return EXIT[e.code] ?? 4;
  }
}
