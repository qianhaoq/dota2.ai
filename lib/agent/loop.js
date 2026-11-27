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

export const AGENT_DEFAULTS = { maxSteps: 24, maxToolCalls: 40, maxToolChars: 40_000 };

/** A tool result as the string the model reads, cut at `max` characters with a visible marker. */
export function toolContent(result, max) {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated: ${text.length - max} more characters; ask for a narrower slice]`;
}

/**
 * @param {{
 *   complete: (o: { system: string, messages: object[], tools: object[], signal?: AbortSignal }) => Promise<{ text?: string, reasoning?: string, toolCalls?: { id: string, name: string, args: any, argsError?: boolean }[], usage?: { input?: number, output?: number } }>,
 *   system: string,
 *   messages: object[],
 *   tools: { name: string, description: string, input_schema: object }[],
 *   runTool: (name: string, args: any) => any | Promise<any>,
 *   isFinal?: (call: { name: string, args: any }) => boolean,
 *   finalTools?: string[],
 *   maxSteps?: number, maxToolCalls?: number, maxToolChars?: number,
 *   signal?: AbortSignal,
 *   onEvent?: (e: object) => void,
 *   resume?: { steps: number, calls: number, usage: { input: number, output: number }, transcript: { name: string, args: any, result: any }[] },
 *   onCheckpoint?: (s: { messages: object[], steps: number, calls: number, usage: { input: number, output: number }, transcript: { name: string, args: any, result: any }[] }) => void,
 * }} o
 * `resume` continues a run that was cut off: `messages` is then the conversation as it stood after a finished
 * round of tool calls, and the counts and transcript are what that run had used and gathered by then.
 * `onCheckpoint` is told that state after every finished round (copies: the caller may keep them).
 * `isFinal` marks a tool call that ends the run (a "submit" tool): its
 * arguments are returned as `final` and it is not executed. `finalTools`
 * names the tools that stay available after the lookup budget is spent.
 * @returns {Promise<{ status: 'answered' | 'final' | 'budget', text: string, final: any, messages: object[], transcript: { name: string, args: any, result: any }[], steps: number, usage: { input: number, output: number } }>}
 */
export async function runAgent(o) {
  const { complete, system, tools, runTool, isFinal = () => false, signal, onEvent = () => {} } = o;
  const maxSteps = o.maxSteps ?? AGENT_DEFAULTS.maxSteps;
  const maxToolCalls = o.maxToolCalls ?? AGENT_DEFAULTS.maxToolCalls;
  const maxToolChars = o.maxToolChars ?? AGENT_DEFAULTS.maxToolChars;
  const messages = [...o.messages];
  const transcript = [...(o.resume?.transcript ?? [])];
  const usage = { input: o.resume?.usage?.input ?? 0, output: o.resume?.usage?.output ?? 0 };
  const known = new Set(tools.map((t) => t.name));
  const finalTools = new Set(o.finalTools ?? []);
  let steps = o.resume?.steps ?? 0; let calls = o.resume?.calls ?? 0;

  while (steps < maxSteps) {
    signal?.throwIfAborted();
    // Out of lookup budget: one last turn with only the tools that end the run (a "submit" tool), so the
    // model can still hand in what it has; with none, it must answer in text.
    const spent = calls >= maxToolCalls;
    const reply = await complete({ system, messages, tools: spent ? tools.filter((t) => finalTools.has(t.name)) : tools, signal });
    steps += 1;
    usage.input += reply.usage?.input ?? 0; usage.output += reply.usage?.output ?? 0;
    const toolCalls = (reply.toolCalls ?? []).filter((c) => !spent || finalTools.has(c.name));
    if (!toolCalls.length) {
      messages.push({ role: 'assistant', content: reply.text ?? '' });
      return { status: 'answered', text: reply.text ?? '', final: null, messages, transcript, steps, usage };
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
    if (done) return { status: 'final', text: reply.text ?? '', final: done.args, messages, transcript, steps, usage };
    for (const call of toolCalls) {
      signal?.throwIfAborted();
      let result;
      if (calls >= maxToolCalls) result = { error: 'tool_budget_spent' };
      else if (call.argsError) result = { error: 'invalid_arguments', detail: 'arguments were not valid JSON' };
      else if (!known.has(call.name)) result = { error: 'unknown_tool', tools: [...known] };
      else {
        calls += 1;
        onEvent({ type: 'tool_start', name: call.name, args: call.args });
        try { result = await runTool(call.name, call.args ?? {}); } catch { result = { error: 'tool_failed' }; }
        onEvent({ type: 'tool_end', name: call.name, ok: !result?.error });
        transcript.push({ name: call.name, args: call.args ?? {}, result });
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: toolContent(result, maxToolChars) });
    }
    // Every call of the round has its result: the conversation can be picked up again from exactly here.
    o.onCheckpoint?.({ messages: [...messages], steps, calls, usage: { ...usage }, transcript: [...transcript] });
  }
  return { status: 'budget', text: '', final: null, messages, transcript, steps, usage };
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
    const msg = res?.choices?.[0]?.message ?? {};
    const toolCalls = (msg.tool_calls ?? []).filter((c) => c?.function?.name).map((c, i) => {
      let args = {}; let argsError = false;
      try { args = c.function.arguments ? JSON.parse(c.function.arguments) : {}; } catch { argsError = true; }
      if (args == null || typeof args !== 'object' || Array.isArray(args)) { args = {}; argsError = true; }
      return { id: c.id ?? `call_${i}`, name: c.function.name, args, ...(argsError ? { argsError } : {}) };
    });
    return { text: typeof msg.content === 'string' ? msg.content : '', ...(typeof msg.reasoning_content === 'string' && msg.reasoning_content ? { reasoning: msg.reasoning_content } : {}), toolCalls, usage: { input: res?.usage?.prompt_tokens ?? 0, output: res?.usage?.completion_tokens ?? 0 } };
  };
}
