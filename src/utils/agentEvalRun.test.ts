import { describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET, DEFAULT_FLOOR, REVIEW_COST_ESTIMATE, parseRunArgs, planRuns, reviewsAlreadyIn, runAll, runFileName, spendVerdict } from '../../lib/agent/evalRun.js';
import { DEFAULT_BALANCE_FLOOR } from '../../lib/agent/modelBalance.js';
import { evaluate, parseName } from '../../scripts/eval-review.mjs';

/** Reviewing the rubric games again costs money on the account production bills: what guards a run. */

/** A balance as lib/agent/modelBalance.js reads it (its own tests cover the reading). */
const known = (total: number, available = true) => ({ known: true as const, available, total, currency: 'CNY' });
const unknown = (reason: string) => ({ known: false as const, reason });

describe('parseRunArgs', () => {
  it('needs where the traces are and where to write; the rest has defaults that spend little', () => {
    expect(parseRunArgs(['--traces', 't', '--out', 'o'])).toEqual({ traces: 't', out: 'o', matches: null, rubrics: 'evals/reviews', games: null, runs: 1, lang: 'zh', budget: DEFAULT_BUDGET, floor: DEFAULT_FLOOR, dryRun: false });
    expect(parseRunArgs(['--traces', 't', '--out', 'o', '--matches', 'm', '--games', '9100904020.beastmaster, 9091400302.tidehunter', '--runs', '3', '--lang', 'en', '--budget', '2.5', '--floor', '60', '--dry-run']))
      .toMatchObject({ matches: 'm', games: [{ match_id: 9100904020, hero: 'beastmaster' }, { match_id: 9091400302, hero: 'tidehunter' }], runs: 3, lang: 'en', budget: 2.5, floor: 60, dryRun: true });
  });

  it('refuses what it cannot read: a run that spends money is not started on a guess', () => {
    const base = ['--traces', 't', '--out', 'o'];
    for (const bad of [[], ['--traces', 't'], ['--out', 'o'], [...base, '--runs', '0'], [...base, '--runs', '100'], [...base, '--runs', 'many'], [...base, '--lang', 'fr'], [...base, '--budget', '-1'], [...base, '--budget', 'lots'], [...base, '--floor'],
      [...base, '--games', 'beastmaster'], [...base, '--games', '9100904020.Beast Master'], [...base, '--games', ''], [...base, '--yes'], [...base, 'stray'], [...base, '--out', '--dry-run']]) expect([bad, parseRunArgs(bad)]).toEqual([bad, null]);
  });
});

describe('planRuns', () => {
  const games = [{ match_id: 9100904020, hero: 'beastmaster' }, { match_id: 9091400302, hero: 'tidehunter' }, { match_id: 7, hero: 'axe' }, { match_id: 9100904020, hero: 'beastmaster' }];
  it('lists every review to write, game by game, says which games have a match record, and names the games it has no trace for', () => {
    const p = planRuns({ games, runs: 2, lang: 'zh', version: 38, hasTrace: (id) => id !== 7, hasMatch: (id) => id === 9100904020 });
    expect(p.jobs.map((j) => [j.file, j.match_record])).toEqual([
      ['9100904020.beastmaster.zh.p38.r1.review.json', true], ['9100904020.beastmaster.zh.p38.r2.review.json', true],
      ['9091400302.tidehunter.zh.p38.r1.review.json', false], ['9091400302.tidehunter.zh.p38.r2.review.json', false],
    ]);
    expect(p.missing).toEqual([{ match_id: 7, hero: 'axe' }]);
    expect(p.estimate).toBe(4 * REVIEW_COST_ESTIMATE);
    expect(planRuns({ games: [], runs: 3, lang: 'zh', version: 38, hasTrace: () => true })).toEqual({ jobs: [], missing: [], estimate: 0 });
  });

  it('writes files the scorer reads as runs of that game and version', () => {
    const file = runFileName({ match_id: 9100904020, hero: 'beastmaster', lang: 'zh', version: 38, run: 2 });
    expect(parseName(file)).toEqual({ file, match_id: 9100904020, hero: 'beastmaster', lang: 'zh', version: 38, plan: null, run: 2 });
    // A stored review's name is still read, as no run.
    expect(parseName('9100904020.beastmaster.zh.p38.review.json')).toMatchObject({ version: 38, run: null });
    expect(parseName('9100904020.beastmaster.zh.p38.plan-push.r3.review.json')).toMatchObject({ plan: 'push', run: 3 });
    expect(parseName('9100904020.beastmaster.zh.p38.r0.review.json')).toBeNull();
  });
});

describe('a run writes into a directory of its own', () => {
  it('finds the reviews an earlier run left, and nothing else', () => {
    // After a three-review run, a one-review run would overwrite r1 and leave r2 and r3 to be scored with it.
    expect(reviewsAlreadyIn(['9100904020.beastmaster.zh.p38.r3.review.json', 'notes.txt', '9100904020.beastmaster.zh.p38.r2.review.json', 'before.json', '9100904020.beastmaster.zh.p38.review.json']))
      .toEqual(['9100904020.beastmaster.zh.p38.r2.review.json', '9100904020.beastmaster.zh.p38.r3.review.json', '9100904020.beastmaster.zh.p38.review.json']);
    expect(reviewsAlreadyIn([])).toEqual([]);
    expect(reviewsAlreadyIn(['summary.json', '.DS_Store'])).toEqual([]);
    expect(reviewsAlreadyIn(undefined as any)).toEqual([]);
  });

  it('the script refuses such a directory before it reads the balance or calls a model', async () => {
    const { mkdtempSync, writeFileSync, rmSync, readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'eval-run-'));
    try {
      writeFileSync(join(dir, '1.axe.zh.p38.r2.review.json'), '{}');
      let code = 0; let err = '';
      // A key that reaches nothing: were the balance read or a model called, the run would fail another way.
      try { execFileSync(process.execPath, ['scripts/eval-run.mjs', '--traces', dir, '--out', dir, '--games', '1.axe'], { env: { ...process.env, DEEPSEEK_API_KEY: 'k-test-not-a-key', EVAL_DEEPSEEK_API_KEY: '', HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9' }, stdio: 'pipe', timeout: 60_000 }); } catch (e: any) { code = e.status; err = String(e.stderr); }
      expect(code).toBe(3);
      expect(err).toContain('already holds 1 review(s) (1.axe.zh.p38.r2.review.json)');
      expect(readdirSync(dir)).toEqual(['1.axe.zh.p38.r2.review.json']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('spendVerdict', () => {
  it('goes only with a known balance on an open account, inside the budget, leaving the floor', () => {
    expect(DEFAULT_FLOOR).toBe(DEFAULT_BALANCE_FLOOR);
    expect(spendVerdict({ balance: known(93.59), estimate: 1.5, floor: 50, budget: 5 })).toEqual({ go: true, reason: 'ok' });
    // Not known, closed, or already under the floor: the probe run's verdict, in its words.
    expect(spendVerdict({ balance: unknown('the balance endpoint answered 401'), estimate: 0.25, floor: 50, budget: 5 })).toEqual({ go: false, reason: 'the balance is not known: the balance endpoint answered 401' });
    expect(spendVerdict({ balance: known(93.59, false), estimate: 0.25, floor: 50, budget: 5 })).toMatchObject({ go: false, reason: expect.stringContaining('not open for calls') });
    expect(spendVerdict({ balance: known(49), estimate: 0.25, floor: 50, budget: 5 })).toMatchObject({ go: false, reason: expect.stringContaining('under the floor of 50') });
    // What a run of reviews adds: the budget, and the floor counted after the spend.
    expect(spendVerdict({ balance: known(93.59), estimate: 5.25, floor: 50, budget: 5 })).toEqual({ go: false, reason: 'over the budget: 5.25 against 5' });
    expect(spendVerdict({ balance: known(51), estimate: 1.5, floor: 50, budget: 5 })).toEqual({ go: false, reason: 'it would leave less than the floor: 51 CNY less 1.5 against a floor of 50' });
    // Exactly the floor left, exactly the budget spent: still inside.
    expect(spendVerdict({ balance: known(51.5), estimate: 1.5, floor: 50, budget: 1.5 }).go).toBe(true);
    // What the run has already cost counts against the budget.
    expect(spendVerdict({ balance: known(90), estimate: 0.25, floor: 50, budget: 1, spent: 0.8 })).toMatchObject({ go: false, reason: expect.stringContaining('over the budget') });
    expect(spendVerdict({ balance: known(90), estimate: 0.25, floor: 50, budget: 1, spent: 0.75 }).go).toBe(true);
  });
});

describe('runAll', () => {
  const jobs = planRuns({ games: [{ match_id: 1, hero: 'axe' }, { match_id: 2, hero: 'lina' }], runs: 2, lang: 'zh', version: 38, hasTrace: () => true }).jobs;
  /** An account that loses `cost` with each review written, plus what production spends meanwhile. */
  const account = (start: number, cost = 0.2, elsewhere = 0) => { let total = start; let reads = 0; return { reads: () => reads, charge: () => { total -= cost + elsewhere; }, balance: async () => { reads += 1; return known(Math.round(total * 100) / 100); } }; };
  const harness = (acct: ReturnType<typeof account>, status: (file: string) => string = () => 'ok') => {
    const order: string[] = []; const written: string[] = [];
    return { order, written, generate: async (job: any) => { order.push(job.file); acct.charge(); return { status: status(job.file), review: {} }; }, write: async (job: any) => { written.push(job.file); } };
  };

  it('writes every review, one after another, and reports what the account lost', async () => {
    const acct = account(93.59); const h = harness(acct);
    const out = await runAll({ jobs, floor: 50, budget: 5, balance: acct.balance, generate: h.generate, write: h.write });
    expect(h.order).toEqual(jobs.map((j) => j.file));
    expect(out).toMatchObject({ started: true, reason: 'done', written: jobs.map((j) => j.file), failed: [], not_run: [], spent: 0.8 });
    expect(out.before).toEqual(known(93.59));
    expect(out.after).toEqual(known(92.79));
    // The balance is read before the first review and after each one.
    expect(acct.reads()).toBe(5);
  });

  it('does not start without a balance, over the budget, or when the plan would cross the floor — and calls no model', async () => {
    const never = { generate: async () => { throw new Error('a model was called'); }, write: async () => {} };
    const blind = await runAll({ jobs, floor: 50, budget: 5, balance: async () => unknown('the balance endpoint could not be read (TimeoutError)'), ...never });
    expect(blind).toMatchObject({ started: false, reason: 'the balance is not known: the balance endpoint could not be read (TimeoutError)', written: [], not_run: jobs.map((j) => j.file) });
    expect(await runAll({ jobs, floor: 50, budget: 0.5, balance: async () => known(93.59), ...never })).toMatchObject({ started: false, reason: 'over the budget: 1 against 0.5' });
    expect(await runAll({ jobs, floor: 50, budget: 5, balance: async () => known(50.9), ...never })).toMatchObject({ started: false, reason: expect.stringContaining('it would leave less than the floor') });
    expect(await runAll({ jobs, floor: 50, budget: 5, balance: async () => known(93.59, false), ...never })).toMatchObject({ started: false, reason: expect.stringContaining('not open for calls') });
    expect(await runAll({ jobs: [], floor: 50, budget: 5, balance: async () => known(93.59), ...never })).toMatchObject({ started: false, reason: 'nothing_to_run' });
  });

  it('stops between reviews when the account nears the floor — production spends there too', async () => {
    // 51.3 to start: the plan (1.00) fits above the floor. Each review then takes 0.2 and production 0.4 more.
    const acct = account(51.3, 0.2, 0.4); const h = harness(acct);
    const out = await runAll({ jobs, floor: 50, budget: 5, balance: acct.balance, generate: h.generate, write: h.write });
    // After two reviews 50.1 is left: another would go under the floor.
    expect(h.order).toEqual(jobs.slice(0, 2).map((j) => j.file));
    expect(out).toMatchObject({ started: true, reason: expect.stringContaining('it would leave less than the floor'), written: jobs.slice(0, 2).map((j) => j.file), not_run: jobs.slice(2).map((j) => j.file), spent: 1.2 });
  });

  it('stops when what the account has lost reaches the budget, whoever spent it', async () => {
    const acct = account(93.59, 0.6); const h = harness(acct);
    const out = await runAll({ jobs, floor: 50, budget: 1.2, balance: acct.balance, generate: h.generate, write: h.write });
    // 0.6 gone after one review; a second (estimated 0.25) fits in 1.2; after it 1.2 is gone and no third is written.
    expect(out).toMatchObject({ reason: 'over the budget: 1.45 against 1.2', written: jobs.slice(0, 2).map((j) => j.file), not_run: jobs.slice(2).map((j) => j.file), spent: 1.2 });
  });

  it('a review the model could not make is reported, not written, and the run goes on; a thrown error is one such', async () => {
    const acct = account(93.59);
    const h = harness(acct, (file) => (file.includes('.r2.') ? 'unverified' : 'ok'));
    const out = await runAll({ jobs, floor: 50, budget: 5, balance: acct.balance, generate: h.generate, write: h.write });
    expect(out.written).toEqual(jobs.filter((j) => j.run === 1).map((j) => j.file));
    expect(out.failed).toEqual(jobs.filter((j) => j.run === 2).map((j) => ({ file: j.file, status: 'unverified' })));
    expect(out.not_run).toEqual([]);
    expect(h.written).toEqual(out.written);
    const thrown = await runAll({ jobs: jobs.slice(0, 1), floor: 50, budget: 5, balance: async () => known(93.59), generate: async () => { throw new Error('socket hang up'); }, write: async () => {} });
    expect(thrown.failed).toEqual([{ file: jobs[0].file, status: 'error:socket hang up' }]);
  });

  it('stops rather than go on blind when the balance can no longer be read', async () => {
    let reads = 0;
    const balance = async () => ((reads += 1) <= 2 ? known(93.59) : unknown('the balance endpoint answered 503'));
    const h = harness(account(93.59));
    const out = await runAll({ jobs, floor: 50, budget: 5, balance, generate: h.generate, write: h.write });
    expect(out).toMatchObject({ reason: 'the balance is not known: the balance endpoint answered 503', written: jobs.slice(0, 2).map((j) => j.file), not_run: jobs.slice(2).map((j) => j.file), spent: null });
  });
});

describe('scoring a run: every review written of a game counts', () => {
  const review = (title: string, reason: string) => ({ review: { schema: 'dota2.ai/deep-review@1', lang: 'zh', verdict: '结论。', mainline: [], findings: [{ title, claim: '说法。', evidence: [{ refs: ['death:axe:1'], fact: '事实。' }], fix: '改法。' }], game_plan: { main_reason: reason, why: '因为。', evidence: [] }, blind_spots: [] }, verification: { repaired: false, dropped: 0 } });
  const entry = (file: string, stored: any) => ({ ...parseName(file)!, stored });
  it('three runs of one version are three reviews of that game, and its stability is read over them', () => {
    const entries = [
      entry('1.axe.zh.p38.r1.review.json', review('甲', 'your_play')), entry('1.axe.zh.p38.r2.review.json', review('乙', 'your_play')), entry('1.axe.zh.p38.r3.review.json', review('丙', 'team_play')),
      entry('1.axe.zh.p37.review.json', review('旧', 'enemy_play')),
    ];
    const out: any = evaluate(entries, new Map());
    // The three of p38, not the older one.
    expect(out.games.map((g: any) => g.file)).toEqual(['1.axe.zh.p38.r1.review.json', '1.axe.zh.p38.r2.review.json', '1.axe.zh.p38.r3.review.json']);
    expect(out.latest.reviews).toBe(3);
    expect(out.stability.games).toBe(1);
  });

  it('a stored review alone is still the one review of its game', () => {
    const out: any = evaluate([entry('1.axe.zh.p37.review.json', review('旧', 'enemy_play')), entry('1.axe.zh.p38.review.json', review('新', 'your_play'))], new Map());
    expect(out.games.map((g: any) => g.file)).toEqual(['1.axe.zh.p38.review.json']);
  });
});
