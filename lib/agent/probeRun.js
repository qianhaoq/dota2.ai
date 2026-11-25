/**
 * Ask a list of probes and grade the answers, stopping as soon as the model account should not be spent from any
 * further (lib/agent/modelBalance.js). Pure of any provider: the caller hands in how to ask, how to grade and how
 * to judge the balance, so the stopping rule is tested without a model.
 *
 * What is not asked is not a wrong answer: a probe the run did not reach, or one the provider failed to answer
 * (an API error), is kept with `pass: null` and stays out of the score (scoreProbes counts graded rows only).
 */

/** A balance check after every this many answers. */
export const BALANCE_EVERY = 20;
/** The provider saying the account has no credit: every further call would fail the same way. */
export const OUT_OF_CREDIT = /\b402\b|insufficient balance/i;

/**
 * @param {{
 *   jobs: { probe: { id: string, kind: string, question: string, expect: object, source: { tool: string } } }[],
 *   ask: (job: any) => Promise<{ status: string, text?: string, error?: string, tool_calls?: { name: string }[], unverified?: { length: number }, usage?: object }>,
 *   grade: (job: any, answer: string) => { pass: boolean, missing: string[], wrong: string[], also_named?: string[] },
 *   guard?: (() => Promise<{ go: boolean, reason: string }>) | null,
 *   every?: number, concurrency?: number, onRow?: (row: any) => void,
 * }} o
 * @returns {Promise<{ rows: any[], stopped: string | null }>} stopped: why the run ended early, or null.
 */
export async function runProbes({ jobs, ask, grade, guard = null, every = BALANCE_EVERY, concurrency = 3, onRow = () => {} }) {
  const rows = new Array(jobs.length);
  let next = 0; let answered = 0; let stopped = null;
  const one = async (job) => {
    const { probe } = job;
    const base = { id: probe.id, kind: probe.kind, question: probe.question, expect: probe.expect };
    if (stopped) return { ...base, status: 'not_asked', pass: null };
    let r;
    try { r = await ask(job); } catch (e) { r = { status: 'error', error: String(e?.message ?? e).slice(0, 200) }; }
    if (r.status === 'not_asked') return { ...base, status: 'not_asked', pass: null };
    if (r.status === 'error') {
      // An empty account answers every call the same way: stop asking instead of collecting failures.
      if (OUT_OF_CREDIT.test(r.error ?? '')) stopped ??= 'the provider refused a call for lack of credit';
      return { ...base, status: 'error', ...(r.error ? { error: r.error } : {}), pass: null };
    }
    answered += 1;
    if (guard && !stopped && answered % every === 0) { const v = await guard(); if (!v.go) stopped ??= v.reason; }
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
