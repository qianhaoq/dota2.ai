/**
 * Provider-agnostic token usage parsing, accumulation, and log formatting.
 *
 * Invariant ("unknown is not false"):
 * - Fields not reported by a provider (`input_uncached`, `cache_read`, `cache_write`, `source`)
 *   stay `null` and are NEVER coerced to `0`.
 * - When accumulating across steps or stages, a breakdown field remains a number ONLY if every
 *   contributing step/stage reported a finite non-negative number for it; otherwise it becomes `null`.
 */

/** @typedef {{ input: number, output: number, input_uncached: number | null, cache_read: number | null, cache_write: number | null, source: 'provider_usage' | null }} UsageBreakdown */

const nonNegNum = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * Empty usage snapshot with no provider report.
 * @returns {UsageBreakdown}
 */
export function emptyUsage() {
  return {
    input: 0,
    output: 0,
    input_uncached: null,
    cache_read: null,
    cache_write: null,
    source: null,
  };
}

/**
 * Parse DSH `@deepseek-ai/dsh-llm` `BlockAssembler.usage`:
 * `{ inputTokens?, cacheReadTokens?, cacheWriteTokens?, outputTokens? }`.
 *
 * In `@deepseek-ai/dsh-llm`, `inputTokens` holds the non-cached input tokens when cache
 * fields are reported, so total input is `inputTokens + cacheReadTokens + cacheWriteTokens`.
 * When cache fields are absent, cache breakdown stays `null` (never coerced to `0`).
 * @param {any} u
 * @returns {UsageBreakdown}
 */
export function parseDshUsage(u) {
  if (!u || typeof u !== 'object') return emptyUsage();
  const rawInput = nonNegNum(u.inputTokens);
  const cacheRead = nonNegNum(u.cacheReadTokens);
  const cacheWrite = nonNegNum(u.cacheWriteTokens);
  const rawOutput = nonNegNum(u.outputTokens);
  const reported = rawInput != null || cacheRead != null || cacheWrite != null || rawOutput != null;
  if (!reported) return emptyUsage();
  const hasCacheSplit = cacheRead != null || cacheWrite != null;
  return {
    input: (rawInput ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
    output: rawOutput ?? 0,
    input_uncached: hasCacheSplit ? rawInput : null,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    source: 'provider_usage',
  };
}

/**
 * Parse OpenAI / DeepSeek / Anthropic-compatible `res.usage`:
 * - DeepSeek: `prompt_tokens`, `completion_tokens`, `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`
 * - OpenAI: `prompt_tokens`, `completion_tokens`, `prompt_tokens_details?.cached_tokens`
 * - Anthropic-compatible proxies: `cache_read_input_tokens`, `cache_creation_input_tokens`,
 *   `prompt_tokens_details?.cache_write_tokens`
 * @param {any} u
 * @returns {UsageBreakdown}
 */
export function parseOpenAiUsage(u) {
  if (!u || typeof u !== 'object') return emptyUsage();
  const prompt = nonNegNum(u.prompt_tokens);
  const completion = nonNegNum(u.completion_tokens);
  const dsHit = nonNegNum(u.prompt_cache_hit_tokens);
  const dsMiss = nonNegNum(u.prompt_cache_miss_tokens);
  const oaiCached = nonNegNum(u.prompt_tokens_details?.cached_tokens);
  const anthRead = nonNegNum(u.cache_read_input_tokens);
  const cacheWrite = nonNegNum(u.cache_creation_input_tokens)
    ?? nonNegNum(u.prompt_tokens_details?.cache_write_tokens);
  const cacheRead = dsHit ?? oaiCached ?? anthRead;

  const reported = prompt != null || completion != null || dsHit != null || dsMiss != null || cacheRead != null || cacheWrite != null;
  if (!reported) return emptyUsage();

  const totalInput = prompt ?? (dsMiss != null || cacheRead != null || cacheWrite != null
    ? (dsMiss ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
    : 0);

  let inputUncached = null;
  if (dsMiss != null) {
    inputUncached = dsMiss;
  } else if (prompt != null && cacheRead != null) {
    const rem = prompt - cacheRead - (cacheWrite ?? 0);
    inputUncached = rem >= 0 ? rem : null;
  }

  return {
    input: totalInput,
    output: completion ?? 0,
    input_uncached: inputUncached,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    source: 'provider_usage',
  };
}

/**
 * Normalize one `complete()` step's `reply.usage` into the standard breakdown shape.
 * @param {any} u
 * @returns {UsageBreakdown}
 */
export function normalizeStepUsage(u) {
  if (!u || typeof u !== 'object') return emptyUsage();
  const input = nonNegNum(u.input);
  const output = nonNegNum(u.output);
  const inputUncached = nonNegNum(u.input_uncached);
  const cacheRead = nonNegNum(u.cache_read);
  const cacheWrite = nonNegNum(u.cache_write);
  const explicitSource = u.source === 'provider_usage' ? /** @type {'provider_usage'} */ ('provider_usage') : u.source === null ? null : undefined;
  const hasCounts = input != null || output != null || inputUncached != null || cacheRead != null || cacheWrite != null;
  /** @type {'provider_usage' | null} */
  const source = explicitSource !== undefined ? explicitSource : (hasCounts ? 'provider_usage' : null);
  return {
    input: input ?? 0,
    output: output ?? 0,
    input_uncached: inputUncached,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    source,
  };
}

/**
 * Stateful accumulator for multi-step agent loops and checkpoint resumes.
 * Preserves `null` whenever any contributing step lacked a breakdown field or usage report.
 * @param {any} [initial]
 * @param {number} [initialSteps]
 * @returns {{ add: (stepUsage: any) => void, snapshot: () => UsageBreakdown }}
 */
export function createUsageAccumulator(initial = null, initialSteps = 0) {
  let calls = 0;
  let input = 0;
  let output = 0;
  let inputUncached = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let inputUncachedKnown = true;
  let cacheReadKnown = true;
  let cacheWriteKnown = true;
  let sourceKnown = true;

  if (initial && typeof initial === 'object' && initialSteps > 0) {
    calls = initialSteps;
    input = nonNegNum(initial.input) ?? 0;
    output = nonNegNum(initial.output) ?? 0;
    const iu = nonNegNum(initial.input_uncached);
    const cr = nonNegNum(initial.cache_read);
    const cw = nonNegNum(initial.cache_write);
    if (iu != null) inputUncached = iu; else inputUncachedKnown = false;
    if (cr != null) cacheRead = cr; else cacheReadKnown = false;
    if (cw != null) cacheWrite = cw; else cacheWriteKnown = false;
    if (initial.source === 'provider_usage') sourceKnown = true;
    else if (initial.source === null) sourceKnown = false;
    else sourceKnown = (nonNegNum(initial.input) != null && nonNegNum(initial.output) != null && (input > 0 || output > 0));
  }

  return {
    add(stepUsage) {
      const u = normalizeStepUsage(stepUsage);
      calls += 1;
      input += u.input;
      output += u.output;
      if (inputUncachedKnown && u.input_uncached != null) inputUncached += u.input_uncached;
      else inputUncachedKnown = false;
      if (cacheReadKnown && u.cache_read != null) cacheRead += u.cache_read;
      else cacheReadKnown = false;
      if (cacheWriteKnown && u.cache_write != null) cacheWrite += u.cache_write;
      else cacheWriteKnown = false;
      if (u.source !== 'provider_usage') sourceKnown = false;
    },
    snapshot() {
      if (calls === 0) return emptyUsage();
      return {
        input,
        output,
        input_uncached: inputUncachedKnown ? inputUncached : null,
        cache_read: cacheReadKnown ? cacheRead : null,
        cache_write: cacheWriteKnown ? cacheWrite : null,
        source: sourceKnown ? 'provider_usage' : null,
      };
    },
  };
}

/**
 * Merge multiple non-empty stage usages (e.g. `first`, `repair`, `translate`) without coercing
 * unknown breakdown fields to `0`.
 * @param {any[]} list
 * @returns {UsageBreakdown}
 */
export function mergeUsages(list) {
  const acc = createUsageAccumulator();
  for (const item of list ?? []) {
    if (!item || typeof item !== 'object') continue;
    acc.add(item);
  }
  return acc.snapshot();
}

/**
 * Format usage for single-line server/DSH logs. Emits cache stats ONLY when reported.
 */
export function formatUsageLog(u) {
  if (!u || typeof u !== 'object') return 'in=0 out=0';
  const parts = [`in=${u.input ?? 0}`];
  if (typeof u.input_uncached === 'number') parts.push(`uncached=${u.input_uncached}`);
  if (typeof u.cache_read === 'number') {
    const pct = typeof u.input === 'number' && u.input > 0 ? Math.round((u.cache_read / u.input) * 100) : null;
    parts.push(`cache_read=${u.cache_read}${pct != null ? `(${pct}%)` : ''}`);
  }
  if (typeof u.cache_write === 'number') parts.push(`cache_write=${u.cache_write}`);
  parts.push(`out=${u.output ?? 0}`);
  return parts.join(' ');
}
