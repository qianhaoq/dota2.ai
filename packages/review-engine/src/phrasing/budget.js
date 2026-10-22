/** Process-local spend accounting. Shared storage is an adapter responsibility. */
export function createBudget({ limit = Number(process.env.LLM_DAILY_BUDGET_USD ?? 5), inputPerMillion = 0.3, outputPerMillion = 1.2, now = Date.now } = {}) {
  let day = '';
  let spent = 0;
  const reservations = new Map();
  const cost = usage => (Math.max(0, usage.prompt_tokens ?? 0) * inputPerMillion
    + Math.max(0, usage.completion_tokens ?? 0) * outputPerMillion) / 1e6;
  const reset = () => {
    const current = new Date(now()).toISOString().slice(0, 10);
    if (day !== current) {
      day = current;
      spent = 0;
    }
  };
  return {
    reserve(usage) {
      reset();
      const amount = cost(usage);
      if (!Number.isFinite(limit) || spent + [...reservations.values()].reduce((a, b) => a + b, 0) + amount > limit) return null;
      const token = Symbol();
      reservations.set(token, amount);
      return {
        settle(actual) {
          if (!reservations.delete(token)) return;
          reset();
          spent += cost(actual);
        },
        release() { reservations.delete(token); },
      };
    },
    enabled() {
      reset();
      return Number.isFinite(limit) && spent < limit;
    },
    record(usage) {
      reset();
      spent += cost(usage);
      return spent;
    },
    get spent() {
      reset();
      return spent;
    },
  };
}
export const dailyBudget = createBudget();
