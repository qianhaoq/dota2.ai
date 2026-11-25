import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBalance, balanceVerdict, DEFAULT_BALANCE_FLOOR } from '../../lib/agent/modelBalance.js';
import { runProbes, BALANCE_EVERY, OUT_OF_CREDIT } from '../../lib/agent/probeRun.js';
import { scoreProbes } from '../../lib/agent/probes.js';

/** DeepSeek's answer as read live on 2026-11-25. */
const LIVE = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '99.88', granted_balance: '0.00', topped_up_balance: '99.88' }] };
const answering = (body: any, status = 200) => { const seen: any[] = []; return { seen, fetchFn: (async (url: string, init: any) => { seen.push({ url, init }); return { ok: status >= 200 && status < 300, status, json: async () => body }; }) as any }; };

describe('model balance: what the account a run spends from has left', () => {
  it('reads DeepSeek\'s balance with the run\'s own key', async () => {
    const f = answering(LIVE);
    expect(await readBalance({ provider: 'deepseek', apiKey: 'sk-test', fetchFn: f.fetchFn })).toEqual({ known: true, available: true, total: 99.88, currency: 'CNY' });
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0].url).toBe('https://api.deepseek.com/user/balance');
    expect(f.seen[0].init.headers.Authorization).toBe('Bearer sk-test');
  });

  it('an account holding two currencies: the larger balance', async () => {
    const f = answering({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '3.10' }, { currency: 'CNY', total_balance: '40.00' }] });
    expect(await readBalance({ provider: 'deepseek', apiKey: 'k', fetchFn: f.fetchFn })).toMatchObject({ known: true, total: 40, currency: 'CNY' });
  });

  it('a balance that cannot be read is unknown, never zero and never enough; the key is not in the reason', async () => {
    const key = 'sk-very-secret';
    const refused = await readBalance({ provider: 'deepseek', apiKey: key, fetchFn: answering({ error: { message: `bad key ${key}` } }, 401).fetchFn });
    expect(refused).toEqual({ known: false, reason: 'the balance endpoint answered 401' });
    const down = await readBalance({ provider: 'deepseek', apiKey: key, fetchFn: (async () => { throw Object.assign(new Error(`connect failed for ${key}`), { name: 'TypeError' }); }) as any });
    expect(down).toEqual({ known: false, reason: 'the balance endpoint could not be read (TypeError)' });
    for (const body of [{}, { is_available: true, balance_infos: [] }, { is_available: 'yes', balance_infos: LIVE.balance_infos }, { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: 'n/a' }] }]) {
      expect(await readBalance({ provider: 'deepseek', apiKey: key, fetchFn: answering(body).fetchFn })).toEqual({ known: false, reason: 'the balance endpoint answered in a shape not known here' });
    }
    // No endpoint known for the provider, or no key: nothing is fetched.
    const f = answering(LIVE);
    expect(await readBalance({ provider: 'glm', apiKey: key, fetchFn: f.fetchFn })).toEqual({ known: false, reason: 'no balance endpoint is known for glm' });
    expect(await readBalance({ provider: 'deepseek', apiKey: '', fetchFn: f.fetchFn })).toEqual({ known: false, reason: 'no API key' });
    expect(f.seen).toHaveLength(0);
    for (const r of [refused, down]) expect(JSON.stringify(r)).not.toContain(key);
  });

  it('a run may spend only with a known balance, an open account and the floor still under it', () => {
    expect(DEFAULT_BALANCE_FLOOR).toBe(50);
    expect(balanceVerdict({ known: true, available: true, total: 99.88, currency: 'CNY' })).toEqual({ go: true, reason: 'balance 99.88 CNY, floor 50' });
    expect(balanceVerdict({ known: true, available: true, total: 50, currency: 'CNY' }).go).toBe(true);
    expect(balanceVerdict({ known: true, available: true, total: 49.99, currency: 'CNY' })).toEqual({ go: false, reason: 'the balance, 49.99 CNY, is under the floor of 50' });
    expect(balanceVerdict({ known: true, available: true, total: 49.99, currency: 'CNY' }, 10).go).toBe(true);
    expect(balanceVerdict({ known: true, available: false, total: 0, currency: 'CNY' }, 0)).toEqual({ go: false, reason: 'the account is not open for calls (no credit left)' });
    expect(balanceVerdict({ known: false, reason: 'the balance endpoint answered 401' })).toEqual({ go: false, reason: 'the balance is not known: the balance endpoint answered 401' });
    expect(balanceVerdict(null).go).toBe(false);
  });
});

describe('probe run: stops before the account runs dry', () => {
  const jobs = (n: number) => Array.from({ length: n }, (_, i) => ({ probe: { id: `p${i}`, kind: i % 2 ? 'b' : 'a', question: `q${i}`, expect: {}, source: { tool: 'lane_report' } } }));
  const ok = async () => ({ status: 'ok', text: 'right', tool_calls: [{ name: 'lane_report' }], unverified: { length: 0 }, usage: { input: 10, output: 1 } });
  const grade = (_job: any, answer: string) => ({ pass: answer === 'right', missing: answer === 'right' ? [] : ['x'], wrong: [], also_named: [] });

  it('asks every probe, in order, and grades the answers', async () => {
    const seen: string[] = [];
    const r = await runProbes({ jobs: jobs(7), ask: async (j: any) => { seen.push(j.probe.id); return j.probe.id === 'p3' ? { ...(await ok()), text: 'wrong' } : ok(); }, grade, concurrency: 3 });
    expect(r.stopped).toBeNull();
    expect(r.rows.map((x) => x.id)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    expect(seen.sort()).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
    expect(r.rows.map((x) => x.pass)).toEqual([true, true, true, false, true, true, true]);
    expect(r.rows[0]).toMatchObject({ status: 'ok', asked_source_tool: true, tool_calls: ['lane_report'], unverified: 0, answer: 'right' });
  });

  it('checks the balance every so many answers and stops asking when it says no', async () => {
    expect(BALANCE_EVERY).toBe(20);
    const asked: string[] = []; let checks = 0;
    const guard = async () => { checks += 1; return checks < 2 ? { go: true, reason: 'balance 60 CNY, floor 50' } : { go: false, reason: 'the balance, 49.2 CNY, is under the floor of 50' }; };
    const r = await runProbes({ jobs: jobs(10), ask: async (j: any) => { asked.push(j.probe.id); return ok(); }, grade, guard, every: 3, concurrency: 1 });
    // Checked after the 3rd answer (go) and after the 6th (no): six asked, four never sent.
    expect(checks).toBe(2);
    expect(asked).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
    expect(r.stopped).toBe('the balance, 49.2 CNY, is under the floor of 50');
    expect(r.rows.slice(6)).toEqual(jobs(10).slice(6).map((j) => ({ id: j.probe.id, kind: j.probe.kind, question: j.probe.question, expect: {}, status: 'not_asked', pass: null })));
    // Not asked is not wrong: the score is over the six answers.
    expect(scoreProbes(r.rows)).toMatchObject({ probes: 6, passed: 6, not_graded: 4 });
  });

  it('a balance that cannot be read mid-run stops it too', async () => {
    const r = await runProbes({ jobs: jobs(5), ask: ok, grade, guard: async () => ({ go: false, reason: 'the balance is not known: the balance endpoint answered 503' }), every: 2, concurrency: 1 });
    expect(r.stopped).toBe('the balance is not known: the balance endpoint answered 503');
    expect(r.rows.map((x) => x.status)).toEqual(['ok', 'ok', 'not_asked', 'not_asked', 'not_asked']);
  });

  it('the provider refusing a call for lack of credit stops the run at once, and is not a wrong answer', async () => {
    expect(OUT_OF_CREDIT.test('402 Insufficient Balance (request_id: a686b1b7)')).toBe(true);
    const asked: string[] = [];
    const r = await runProbes({ jobs: jobs(6), ask: async (j: any) => { asked.push(j.probe.id); if (j.probe.id === 'p2') throw new Error('402 Insufficient Balance (request_id: a686b1b7)'); return ok(); }, grade, concurrency: 1 });
    expect(asked).toEqual(['p0', 'p1', 'p2']);
    expect(r.stopped).toBe('the provider refused a call for lack of credit');
    expect(r.rows[2]).toEqual({ id: 'p2', kind: 'a', question: 'q2', expect: {}, status: 'error', error: '402 Insufficient Balance (request_id: a686b1b7)', pass: null });
    expect(r.rows.slice(3).map((x) => x.status)).toEqual(['not_asked', 'not_asked', 'not_asked']);
    expect(scoreProbes(r.rows)).toMatchObject({ probes: 2, passed: 2, not_graded: 4 });
  });

  it('any other failed call is left ungraded and the run goes on; a model that gave no answer did fail', async () => {
    const r = await runProbes({ jobs: jobs(4), ask: async (j: any) => { if (j.probe.id === 'p1') throw new Error('Request timed out.'); if (j.probe.id === 'p2') return { status: 'no_answer', usage: { input: 5, output: 0 } }; return ok(); }, grade, concurrency: 1 });
    expect(r.stopped).toBeNull();
    expect(r.rows.map((x) => [x.status, x.pass])).toEqual([['ok', true], ['error', null], ['no_answer', false], ['ok', true]]);
    expect(r.rows[2].missing).toEqual(['(no answer)']);
    expect(scoreProbes(r.rows)).toEqual({ probes: 3, passed: 2, not_graded: 1, by_kind: { a: { probes: 2, passed: 1 }, b: { probes: 1, passed: 1 } } });
  });

  it('a re-grade keeps a row that never had an answer without one', async () => {
    const saved = [{ status: 'ok', text: 'right' }, { status: 'error', error: '402 Insufficient Balance' }, { status: 'not_asked' }];
    const r = await runProbes({ jobs: jobs(3), ask: async (j: any) => saved[Number(j.probe.id.slice(1))] as any, grade, concurrency: 1 });
    expect(r.rows.map((x) => [x.status, x.pass])).toEqual([['ok', true], ['error', null], ['not_asked', null]]);
  });
});

describe('probe-chat.mjs: the balance options', () => {
  const run = (...a: string[]) => { try { return { code: 0, err: execFileSync('node', ['scripts/probe-chat.mjs', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } }) }; } catch (e: any) { return { code: e.status, err: String(e.stderr) }; } };
  it('rejects a floor that is not a number, and says how to call it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-'));
    const bad = run(dir, '--min-balance', 'lots');
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/--min-balance <amount>.*--no-balance-check/);
    expect(run(dir, '--min-balance').code).toBe(2);
  });
});
