/**
 * The agent loop: a model that may call tools, run until it answers.
 * Provider-agnostic — `complete` is the only thing that knows a vendor
 * (openAiCompatible below covers DeepSeek and every OpenAI-shaped API).
 *
 * No IO of its own, no clock: budgets are counts, cancellation is the
 * caller's AbortSignal. Tool results are data for the model, never
 * instructions to this loop.
 *
 * Messages use the OpenAI chat shape as the neutral format:
 *   { role: 'user' | 'assistant' | 'tool', content, tool_calls?, tool_call_id? }
 */

import { createUsageAccumulator, parseOpenAiUsage } from './usage.js';

export const AGENT_DEFAULTS = { maxSteps: 28, maxToolCalls: 60, maxToolChars: 40_000 };
/** Sent once on an in-place retry when a model hits its output cap mid-tool-call. Pinned in agentPromptPin.test.ts. */
export const TRUNCATION_RETRY_INSTRUCTION = 'Your previous response hit the output token limit before finishing its tool call. Keep your reasoning brief and call the tool directly now.';

/** A tool result as the string the model reads, cut at `max` characters with a visible marker. */
export function toolContent(result, max) {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated: ${text.length - max} more characters; ask for a narrower slice]`;
}

/** Deterministic JSON serialization (sorted object keys) for identifying identical tool calls. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function toolCallKey(name, args) {
  return `${name}\0${canonicalJson(args ?? {})}`;
}

/**
 * Scan existing conversation messages (for resume or repair rounds) to find non-error tool
 * results already present in context, keyed by canonical `(name, args)`.
 */
function seedPriorToolCalls(messages) {
  const callById = new Map();
  const prior = new Map();
  for (const m of messages) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (!tc?.id || !tc?.function?.name) continue;
        let args = {};
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          continue;
        }
        if (args == null || typeof args !== 'object' || Array.isArray(args)) continue;
        callById.set(tc.id, toolCallKey(tc.function.name, args));
      }
    } else if (m?.role === 'tool' && m.tool_call_id) {
      const key = callById.get(m.tool_call_id);
      const content = String(m.content ?? '');
      if (key && !prior.has(key) && !content.startsWith('{"error":') && !content.startsWith('{"duplicate_of":')) {
        prior.set(key, { id: m.tool_call_id, chars: content.length });
      }
    }
  }
  return prior;
}

/**
 * @param {{
 *   complete: (o: { system: string, messages: object[], tools: object[], signal?: AbortSignal }) => Promise<{ text?: string, reasoning?: string, toolCalls?: { id: string, name: string, args: any, argsError?: boolean }[], usage?: { input?: number, output?: number, input_uncached?: number | null, cache_read?: number | null, cache_write?: number | null, source?: 'provider_usage' | null } }>,
 *   system: string,
 *   messages: object[],
 *   tools: { name: string, description: string, input_schema: object }[],
 *   runTool: (name: string, args: any) => any | Promise<any>,
 *   isFinal?: (call: { name: string, args: any }) => boolean,
 *   finalTools?: string[],
 *   maxSteps?: number, maxToolCalls?: number, maxToolChars?: number,
 *   signal?: AbortSignal,
 *   onEvent?: (e: object) => void,
 *   resume?: { steps: number, calls: number, truncation_retries?: number, duplicate_tool_calls?: number, usage: { input: number, output: number, input_uncached?: number | null, cache_read?: number | null, cache_write?: number | null, source?: 'provider_usage' | null }, transcript: { name: string, args: any, result: any }[] },
 *   onCheckpoint?: (s: { messages: object[], steps: number, calls: number, truncation_retries: number, duplicate_tool_calls: number, usage: { input: number, output: number, input_uncached: number | null, cache_read: number | null, cache_write: number | null, source: 'provider_usage' | null }, transcript: { name: string, args: any, result: any }[] }) => void,
 * }} o
 * `resume` continues a run that was cut off: `messages` is then the conversation as it stood after a finished
 * round of tool calls, and the counts and transcript are what that run had used and gathered by then.
 * `onCheckpoint` is told that state after every finished round (copies: the caller may keep them).
 * `isFinal` marks a tool call that ends the run (a "submit" tool): its
 * arguments are returned as `final` and it is not executed. `finalTools`
 * names the tools that stay available after the lookup budget is spent.
 * @returns {Promise<{ status: 'answered' | 'final' | 'budget' | 'truncated', text: string, final: any, messages: object[], transcript: { name: string, args: any, result: any }[], steps: number, truncation_retries: number, duplicate_tool_calls: number, usage: { input: number, output: number, input_uncached: number | null, cache_read: number | null, cache_write: number | null, source: 'provider_usage' | null } }>}
 */
export async function runAgent(o) {
  const { complete, system, tools, runTool, isFinal = () => false, signal, onEvent = () => {} } = o;
  const maxSteps = o.maxSteps ?? AGENT_DEFAULTS.maxSteps;
  const maxToolCalls = o.maxToolCalls ?? AGENT_DEFAULTS.maxToolCalls;
  const maxToolChars = o.maxToolChars ?? AGENT_DEFAULTS.maxToolChars;
  const maxTruncationRetries = o.maxTruncationRetries ?? 1;
  const messages = [...o.messages];
  const transcript = [...(o.resume?.transcript ?? [])];
  const usageAcc = createUsageAccumulator(o.resume?.usage, o.resume?.steps ?? 0);
  const priorToolCalls = seedPriorToolCalls(messages);
  const known = new Set(tools.map((t) => t.name));
  const finalTools = new Set(o.finalTools ?? []);
  let steps = o.resume?.steps ?? 0; let calls = o.resume?.calls ?? 0;
  let truncationRetries = o.resume?.truncation_retries ?? 0;
  let duplicateToolCalls = o.resume?.duplicate_tool_calls ?? 0;
  let retryNudge = null;

  while (steps < maxSteps) {
    signal?.throwIfAborted();
    // Out of lookup budget: one last turn with only the tools that end the run (a "submit" tool), so the
    // model can still hand in what it has; with none, it must answer in text.
    const spent = calls >= maxToolCalls;
    const callMessages = retryNudge ? [...messages, { role: 'user', content: retryNudge }] : messages;
    retryNudge = null;
    const reply = await complete({ system, messages: callMessages, tools: spent ? tools.filter((t) => finalTools.has(t.name)) : tools, signal });
    steps += 1;
    usageAcc.add(reply.usage);
    const toolCalls = (reply.toolCalls ?? []).filter((c) => !spent || finalTools.has(c.name));
    const truncatedIncomplete = Boolean(reply.truncated) && (!toolCalls.length || toolCalls.some((c) => c.argsError));
    if (truncatedIncomplete) {
      if (truncationRetries < maxTruncationRetries && steps < maxSteps) {
        truncationRetries += 1;
        onEvent({ type: 'truncated_retry', step: steps, attempt: truncationRetries });
        retryNudge = TRUNCATION_RETRY_INSTRUCTION;
        continue;
      }
      messages.push({ role: 'assistant', content: reply.text ?? '' });
      return { status: 'truncated', text: reply.text ?? '', final: null, messages, transcript, steps, truncation_retries: truncationRetries, duplicate_tool_calls: duplicateToolCalls, usage: usageAcc.snapshot() };
    }
    if (!toolCalls.length) {
      messages.push({ role: 'assistant', content: reply.text ?? '' });
      return { status: 'answered', text: reply.text ?? '', final: null, messages, transcript, steps, truncation_retries: truncationRetries, duplicate_tool_calls: duplicateToolCalls, usage: usageAcc.snapshot() };
    }
    // A thinking model's reasoning goes back with its tool calls: DeepSeek's tool-call protocol rejects the
    // next request without it (https://api-docs.deepseek.com/guides/thinking_mode/#tool-calls). Adapters with
    // opaque replay metadata (such as DSH's multi-provider reasoning signatures) round-trip it on `provider_state`.
    messages.push({
      role: 'assistant',
      content: reply.text ?? '',
      ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}),
      ...(reply.providerState !== undefined ? { provider_state: reply.providerState } : {}),
      tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
    });
    const done = toolCalls.find((c) => !c.argsError && known.has(c.name) && isFinal(c));
    if (done) return { status: 'final', text: reply.text ?? '', final: done.args, messages, transcript, steps, truncation_retries: truncationRetries, duplicate_tool_calls: duplicateToolCalls, usage: usageAcc.snapshot() };
    for (const call of toolCalls) {
      signal?.throwIfAborted();
      let content;
      if (calls >= maxToolCalls) content = toolContent({ error: 'tool_budget_spent' }, maxToolChars);
      else if (call.argsError) content = toolContent({ error: 'invalid_arguments', detail: 'arguments were not valid JSON' }, maxToolChars);
      else if (!known.has(call.name)) content = toolContent({ error: 'unknown_tool', tools: [...known] }, maxToolChars);
      else {
        const args = call.args ?? {};
        const key = toolCallKey(call.name, args);
        const prior = priorToolCalls.get(key);
        const dupPointer = prior ? JSON.stringify({ duplicate_of: prior.id, tool: call.name, note: 'Identical tool result already returned earlier in this conversation; reuse that result.' }) : null;
        if (prior && dupPointer && prior.chars > dupPointer.length) {
          calls += 1;
          duplicateToolCalls += 1;
          onEvent({ type: 'tool_start', name: call.name, args, duplicate: true });
          onEvent({ type: 'tool_end', name: call.name, ok: true, duplicate: true });
          content = dupPointer;
        } else {
          calls += 1;
          onEvent({ type: 'tool_start', name: call.name, args });
          let result;
          try { result = await runTool(call.name, args); } catch { result = { error: 'tool_failed' }; }
          onEvent({ type: 'tool_end', name: call.name, ok: !result?.error });
          transcript.push({ name: call.name, args, result });
          content = toolContent(result, maxToolChars);
          if (!result?.error && !priorToolCalls.has(key)) {
            priorToolCalls.set(key, { id: call.id, chars: content.length });
          }
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
    // Every call of the round has its result: the conversation can be picked up again from exactly here.
    o.onCheckpoint?.({ messages: [...messages], steps, calls, truncation_retries: truncationRetries, duplicate_tool_calls: duplicateToolCalls, usage: usageAcc.snapshot(), transcript: [...transcript] });
  }
  return { status: 'budget', text: '', final: null, messages, transcript, steps, truncation_retries: truncationRetries, duplicate_tool_calls: duplicateToolCalls, usage: usageAcc.snapshot() };
}

/**
 * `complete` for an OpenAI-compatible chat API (DeepSeek, …).
 * @param {{ client: { chat: { completions: { create: Function } } }, model: string, extraBody?: object, maxTokens?: number }} o
 */
export function openAiCompatible({ client, model, extraBody = {}, maxTokens }) {
  /** @param {{ system: string, messages: object[], tools: any[], signal?: AbortSignal }} o */
  return async ({ system, messages, tools, signal }) => {
    const body = {
      model,
      messages: [{ role: 'system', content: system }, ...messages],
      ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}),
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...extraBody,
    };
    const res = await client.chat.completions.create(body, { signal });
    const choice = res?.choices?.[0];
    const msg = choice?.message ?? {};
    const toolCalls = (msg.tool_calls ?? []).filter((c) => c?.function?.name).map((c, i) => {
      let args = {}; let argsError = false;
      try { args = c.function.arguments ? JSON.parse(c.function.arguments) : {}; } catch { argsError = true; }
      if (args == null || typeof args !== 'object' || Array.isArray(args)) { args = {}; argsError = true; }
      return { id: c.id ?? `call_${i}`, name: c.function.name, args, ...(argsError ? { argsError } : {}) };
    });
    return {
      text: typeof msg.content === 'string' ? msg.content : '',
      ...(typeof msg.reasoning_content === 'string' && msg.reasoning_content ? { reasoning: msg.reasoning_content } : {}),
      ...(choice?.finish_reason === 'length' ? { truncated: true } : {}),
      toolCalls,
      usage: parseOpenAiUsage(res?.usage),
    };
  };
}
