/**
 * Ask a list of probes and grade the answers, stopping as soon as the model account should not be spent from any
 * further (lib/agent/modelBalance.js). Pure of any provider: the caller hands in how to ask, how to grade and how
 * to judge the balance, so the stopping rule is tested without a model.
 *
 * What is not asked is not a wrong answer: a probe the run did not reach, or one the provider failed to answer
 * (an API error), is kept with `pass: null` and stays out of the score (scoreProbes counts graded rows only).
 */

/** A balance check after every this many questions sent, answered or failed. */
export const BALANCE_EVERY = 20;
/** The provider saying the account has no credit: every further call would fail the same way. */
export const OUT_OF_CREDIT = /\b402\b|insufficient balance/i;

/**
 * @param {{
 *   jobs: { probe: { id: string, kind: string, question: string, expect: object, source: { tool: string } } }[],
 *   ask: (job: any) => Promise<{ status: string, text?: string, error?: string, tool_calls?: { name: string }[], unverified?: { length: number }, usage?: object }>,
 *   grade: (job: any, answer: string) => { pass: boolean, missing: string[], wrong: string[], also_named?: string[] },
 *   guard?: (() => Promise<{ go: boolean, reason: string }>) | null,
 *   live?: boolean, every?: number, concurrency?: number, onRow?: (row: any) => void,
 * }} o
 *   live: false when the answers come from an earlier run's file (a re-grade): nothing is spent, so nothing stops
 *   the run — a saved "no credit" error is one row without an answer, and every other saved answer is graded.
 * @returns {Promise<{ rows: any[], stopped: string | null }>} stopped: why the run ended early, or null.
 */
export async function runProbes({ jobs, ask, grade, guard = null, live = true, every = BALANCE_EVERY, concurrency = 3, onRow = () => {} }) {
  const rows = new Array(jobs.length);
  let next = 0; let attempted = 0; let stopped = null;
  // The balance check in flight, shared by every worker: while it is pending nobody knows whether the run may go
  // on, so no worker sends a new question until it has answered.
  let checking = null;
  const check = () => (checking ??= (async () => {
    try { const v = await guard(); if (!v.go) stopped ??= v.reason; } catch (e) { stopped ??= `the balance check failed (${e?.name ?? 'error'})`; } finally { checking = null; }
  })());
  const one = async (job) => {
    const { probe } = job;
    const base = { id: probe.id, kind: probe.kind, question: probe.question, expect: probe.expect };
    while (checking) await checking;
    if (stopped) return { ...base, status: 'not_asked', pass: null };
    let r;
    try { r = await ask(job); } catch (e) { r = { status: 'error', error: String(e?.message ?? e).slice(0, 200) }; }
    if (r.status === 'not_asked') return { ...base, status: 'not_asked', pass: null };
    if (live) {
      // Every question sent counts toward the next check, a failed one too: a call can fail after the model has
      // already been paid for earlier steps of the same answer.
      attempted += 1;
      // An empty account answers every call the same way: stop asking instead of collecting failures.
      if (r.status === 'error' && OUT_OF_CREDIT.test(r.error ?? '')) stopped ??= 'the provider refused a call for lack of credit';
      else if (guard && !stopped && attempted % every === 0) await check();
    }
    if (r.status === 'error') return { ...base, status: 'error', ...(r.error ? { error: r.error } : {}), pass: null };
    const answer = r.text ?? '';
    // The model was asked and gave nothing usable: that is a failed answer, unlike a call that never got through.
    const graded = r.status === 'ok' ? grade(job, answer) : { pass: false, missing: ['(no answer)'], wrong: [], also_named: [] };
    const calls = r.tool_calls ?? [];
    return { ...base, status: r.status, ...graded, asked_source_tool: calls.some((c) => c.name === probe.source.tool), tool_calls: calls.map((c) => c.name), unverified: (r.unverified ?? []).length, answer, usage: r.usage };
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, async () => {
    while (next < jobs.length) { const i = next; next += 1; rows[i] = await one(jobs[i]); onRow(rows[i]); }
  }));
  return { rows, stopped };
}
