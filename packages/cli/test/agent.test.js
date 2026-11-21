import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createCoachRouter } from '../../../lib/coach/router.js';
import { buildCaseStudies } from '../../../lib/coach/cases.js';
import { buildCoachReport } from '../../../lib/coach/analyze.js';
import { run } from '../src/cli.js';
import { parseAccount } from '../src/coachApi.js';
import { readGoalState } from '../src/agent.js';
import { createCoachApi, ASK_TIMEOUT_MS } from '../src/coachApi.js';
import { writeFileSync } from 'node:fs';

/**
 * The CLI against the real coach router + engine on a local port, over the
 * parsed fixtures: what an agent runs is what the site serves.
 */
const express = createRequire(import.meta.url)('express');
const load = (f) => JSON.parse(readFileSync(new URL(`../../../src/fixtures/coach/${f}`, import.meta.url), 'utf8'));
const matches = new Map([[9091400302, load('match9091400302.parsed.json')], [9094562824, load('match9094562824.parsed.json')]]);
const profiles = load('cases.tidehunter-vs-ursa.profiles.json').profiles;
const ACCOUNT = 123456789;

let server; let env; let home;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(createCoachRouter({
    getMatchDetail: async (id) => {
      const m = matches.get(Number(id));
      if (!m) throw Object.assign(new Error('HTTP 404'), { status: 404, upstream: 'opendota' });
      const copy = structuredClone(m);
      // The later game names one player (Hoodwink, seat 3) for the identity checks.
      if (Number(id) === 9094562824) copy.players[3].account_id = 222;
      return copy;
    },
    resolveClientIp: () => 'test',
    mapError: (e) => ({ status: e.status === 404 ? 404 : 502, body: { error: e.message } }),
    limiter: { tryConsume: () => ({ ok: true, retryAfterSec: 0 }) },
    cases: { get: async ({ report, slot, match }) => buildCaseStudies({ report, slot, match, candidates: profiles }), peek: () => null },
    recent: {
      get: async (id) => ({
        account_id: id,
        matches: id === ACCOUNT ? [
          { match_id: 9094562824, start_time: matches.get(9094562824).start_time, duration: 2000, hero: { id: 123, en: 'Hoodwink', zh: '森海飞霞' }, slot: 3, radiant: true, won: false, kda: [1, 2, 3] },
          { match_id: 9091400302, start_time: matches.get(9091400302).start_time, duration: 2722, hero: { id: 29, en: 'Tidehunter', zh: '潮汐猎人' }, slot: 0, radiant: true, won: false, kda: [6, 12, 15] },
        ] : [],
        empty_hint: id === ACCOUNT ? null : 'private_or_no_matches',
      }),
    },
  }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  home = mkdtempSync(join(tmpdir(), 'dota2ai-home-'));
  env = { DOTA2AI_API_BASE: `http://127.0.0.1:${server.address().port}`, DOTA2AI_HOME: home };
});
afterAll(() => { server?.close(); rmSync(home, { recursive: true, force: true }); });

const sink = () => { let s = ''; return { write: (x) => { s += x; }, get text() { return s; } }; };
async function cli(...args) {
  const out = sink(); const err = sink();
  const code = await run(args, { stdout: out, stderr: err, env });
  return { code, out: out.text, err: err.text };
}

const report = buildCoachReport(load('match9091400302.parsed.json'));
const tideWhy = report.reviews[0].chapters.story.why;

describe('dota2ai coach sections', () => {
  it('summary leads with the causes on you, then what to practise', async () => {
    const r = await cli('coach', '9091400302', '--hero', 'tidehunter', '--lang', 'zh');
    expect(r.code).toBe(0);
    expect(r.out).toContain('== 决定这局的几件事 ==');
    const mine = tideWhy.filter((c) => c.mine).sort((a, b) => a.impact - b.impact);
    expect(r.out.indexOf(mine[0].title.zh)).toBeGreaterThan(-1);
    expect(r.out).toContain('== 下一局练这一件 ==');
    expect(r.out).toContain('https://dota2.ai/r/9091400302?p=0&lang=zh');
  });

  it('why lists every cause with evidence and fix; --json gives the same causes', async () => {
    const r = await cli('coach', '9091400302', '--hero', '29', '--section', 'why');
    expect(r.code).toBe(0);
    for (const c of tideWhy) expect(r.out).toContain(c.title.en);
    const j = JSON.parse((await cli('coach', '9091400302', '--hero', 'Tidehunter', '--section', 'why', '--json')).out);
    expect(j.section).toBe('why');
    expect(new Set(j.value.map((c) => c.id))).toEqual(new Set(tideWhy.map((c) => c.id)));
    expect(j.value[0].mine).toBe(true);
  });

  it('a seat as stable JSON, and chapters by name', async () => {
    const j = JSON.parse((await cli('coach', '9091400302', '--hero', 'tidehunter', '--json')).out);
    expect(Object.keys(j)).toEqual(['schema', 'engine', 'match', 'player', 'review', 'data_gaps', 'url']);
    expect(j.schema).toBe('dota2.ai/coach-report@1');
    expect(j.player.hero.id).toBe(29);
    const lane = await cli('coach', '9091400302', '--hero', 'tidehunter', '--section', 'lane', '--lang', 'zh');
    expect(lane.out).toContain(report.reviews[0].chapters.laning.takeaway.zh);
    expect((await cli('coach', '9091400302', '--section', 'why')).code).toBe(2); // needs --hero
  });
});

describe('dota2ai recent / cases / ask', () => {
  it('recent accepts a friend code or a profile link', async () => {
    expect(parseAccount('https://steamcommunity.com/profiles/76561198083722517')).toBe(String(76561198083722517n - 76561197960265728n));
    expect(() => parseAccount('https://steamcommunity.com/id/someone')).toThrow(/friend code/);
    const r = await cli('recent', String(ACCOUNT), '--json');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).matches.map((m) => m.match_id)).toEqual([9094562824, 9091400302]);
    const empty = await cli('recent', '42', '--lang', 'zh');
    expect(empty.out).toContain('没有公开比赛');
  });

  it('cases returns the pro games for the seat', async () => {
    const r = await cli('cases', '9091400302', '--hero', 'tidehunter', '--json');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).themes.map((t) => t.key)).toEqual(['deaths', 'fights', 'laning']);
    const text = await cli('cases', '9091400302', '--hero', 'tidehunter', '--lang', 'zh');
    expect(text.out).toContain('你死于熊战士 8 次');
  });

  it('ask streams the answer (report fallback without AI) and says so', async () => {
    const r = await cli('ask', '9091400302', '--hero', 'tidehunter', 'why', 'did', 'I', 'lose', 'fights', '--json');
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.question).toBe('why did I lose fights');
    expect(j.fallback).toBe(true);
    expect(j.text.length).toBeGreaterThan(20);
    expect(j.notice).toMatch(/AI follow-up is unavailable/);
  });

  it('maps errors to exit codes', async () => {
    expect((await cli('coach', '1234')).code).toBe(3);
    expect((await cli('cases', '9091400302', '--hero', 'axe')).code).toBe(2);
    expect((await cli('recent', 'nonsense')).code).toBe(2);
    expect((await cli('ask', '9091400302', '--hero', 'tidehunter')).code).toBe(2);
  });
});

describe('dota2ai goal', () => {
  it('sets a goal from a finding, then checks the next game on the saved account', async () => {
    const set = await cli('goal', 'set', '9091400302', '--hero', 'tidehunter', '--json');
    expect(set.code).toBe(0);
    const goal = JSON.parse(set.out);
    expect(goal.fromMatch).toBe(9091400302);
    expect(goal.goal.kind).toBeTruthy();
    // The fixtures are anonymous: attach the account the way a real report would carry it.
    const state = readGoalState(env);
    expect(state.goal.id).toBe(goal.id);
    const check = await cli('goal', 'check', '--account', String(ACCOUNT), '--json');
    expect(check.code).toBe(0);
    const c = JSON.parse(check.out);
    expect(c.matchId).toBe(9094562824);
    expect(['met', 'missed', 'no_opportunity', 'unknown']).toContain(c.result);
    expect(readGoalState(env).checks.map((x) => x.matchId)).toEqual([9094562824]);
    // The game the goal came from is never a check.
    expect((await cli('goal', 'check', '9091400302')).code).toBe(2);
    const show = await cli('goal', 'show', '--lang', 'zh');
    expect(show.out).toContain('9094562824');
  });
});

describe('dota2ai goal identity', () => {
  const save = (accountId) => {
    const goal = { id: `9091400302:0:x`, goal: report.reviews[0].findings.find((f) => f.goal).goal, action: { en: 'a', zh: 'a' }, findingId: 'x', fromMatch: 9091400302, fromStart: matches.get(9091400302).start_time, accountId, heroId: 29, setAt: 0 };
    writeFileSync(join(home, 'goal.json'), JSON.stringify({ goal, checks: [] }));
  };

  it('never records another account\'s game as yours', async () => {
    save(111);
    // A different --account than the goal's owner.
    expect((await cli('goal', 'check', '--account', '222')).code).toBe(2);
    // An explicit seat that belongs to someone else.
    const r = await cli('goal', 'check', '9094562824', '--hero', 'hoodwink');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/belongs to account 111/);
    // The owner is not in the match: ask which hero, never guess from the old hero.
    expect((await cli('goal', 'check', '9094562824')).err).toMatch(/add --hero/);
    expect(readGoalState(env).checks).toEqual([]);
  });

  it('without a known account, a seat must be named', async () => {
    save(null);
    expect((await cli('goal', 'check', '9094562824')).err).toMatch(/Which hero were you/);
    expect((await cli('goal', 'check', '9094562824', '--hero', 'hoodwink')).code).toBe(0);
  });
});

describe('ask timeout', () => {
  it('outlives the JSON timeout: the server may run its whole provider chain', async () => {
    expect(ASK_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    const slow = (ms) => async (_url, init) => {
      await new Promise((r, reject) => { const t = setTimeout(r, ms); init.signal.addEventListener('abort', () => { clearTimeout(t); reject(init.signal.reason); }); });
      const body = new TextEncoder().encode('data: {"text":"ok"}\n\ndata: {"done":true}\n\n');
      return { ok: true, status: 200, body: (async function* () { yield body; })(), json: async () => ({}) };
    };
    const api = createCoachApi({ env: { DOTA2AI_API_BASE: 'http://x' }, fetchImpl: slow(60), timeoutMs: 10, askTimeoutMs: 1000 });
    expect((await api.ask(1, 0, 'q')).text).toBe('ok');
    await expect(api.report(1)).rejects.toMatchObject({ code: 'UPSTREAM' });
  });

  it('a stream cut off before its terminal frame is an error, not an answer', async () => {
    const cut = async () => {
      const body = new TextEncoder().encode('data: {"text":"You should buy"}\n\n');
      return { ok: true, status: 200, body: (async function* () { yield body; })(), json: async () => ({}) };
    };
    const api = createCoachApi({ env: { DOTA2AI_API_BASE: 'http://x' }, fetchImpl: cut });
    await expect(api.ask(1, 0, 'q')).rejects.toMatchObject({ code: 'UPSTREAM', partial: 'You should buy' });
  });
});

describe('dota2ai matchup', () => {
  it('prints the pro matchup brief from the server, no match needed', async () => {
    const out = sink(); const err = sink();
    const code = await run(['matchup', 'tidehunter', '熊战士', '--lang', 'zh'], { stdout: out, stderr: err, env });
    expect(code).toBe(0);
    expect(out.text).toContain('潮汐猎人 对 熊战士（职业比赛，7.41 以来）');
    expect(out.text).toContain('职业潮汐猎人对上熊战士时更常出：Eul的神圣法杖 37%（平时 8%）');
    expect(out.text).toContain('怒意狂击: 物理伤害，无视技能免疫');
  });

  it('--json returns the structured brief', async () => {
    const out = sink();
    expect(await run(['matchup', '29', 'ursa', '--json'], { stdout: out, stderr: sink(), env })).toBe(0);
    const b = JSON.parse(out.text);
    expect(b.lane.verdict).toBe('unfavoured');
    expect(b.source.since).toBe('7.41');
    for (const a of b.their_abilities) expect(a).not.toHaveProperty('dispel');
  });

  it('exits 2 on a missing or unknown hero', async () => {
    const err = sink();
    expect(await run(['matchup', 'tidehunter'], { stdout: sink(), stderr: err, env })).toBe(2);
    expect(err.text).toContain('Usage: dota2ai matchup');
    const err2 = sink();
    expect(await run(['matchup', 'tidehunter', 'nobody'], { stdout: sink(), stderr: err2, env })).toBe(2);
    expect(err2.text).toContain('Unknown hero: nobody');
  });
});
