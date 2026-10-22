/** Process-local spend accounting. Shared storage is an adapter responsibility. */
export function createBudget({ limit = Number(process.env.LLM_DAILY_BUDGET_USD ?? 5), inputPerMillion = 0.3, outputPerMillion = 1.2, now = Date.now } = {}) {
  let day = '', spent = 0;
  const reset = () => { const current = new Date(now()).toISOString().slice(0, 10); if (day !== current) { day = current; spent = 0; } };
  return {
    enabled() { reset(); return Number.isFinite(limit) && spent < limit; },
    record(usage) { reset(); spent += (Math.max(0, usage.prompt_tokens ?? 0) * inputPerMillion + Math.max(0, usage.completion_tokens ?? 0) * outputPerMillion) / 1e6; return spent; },
    get spent() { reset(); return spent; },
  };
}
export const dailyBudget = createBudget();
