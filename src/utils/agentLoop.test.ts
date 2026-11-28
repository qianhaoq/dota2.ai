import { describe, expect, it, vi } from 'vitest';
import { AGENT_DEFAULTS, openAiCompatible, runAgent, toolContent } from '../../lib/agent/loop.js';

const tools = [{ name: 'lookup', description: 'd', input_schema: { type: 'object' } }, { name: 'submit', description: 'd', input_schema: { type: 'object' } }];
/** A model that replays a script: one reply per call. */
const scripted = (replies: any[]) => { const seen: any[] = []; let i = 0; return { seen, complete: async (o: any) => { seen.push(JSON.parse(JSON.stringify(o))); return replies[Math.min(i++, replies.length - 1)]; } }; };
const call = (name: string, args: any = {}, id = `c${Math.random()}`) => ({ id, name, args });

describe('runAgent', () => {
  it('runs tool calls, feeds results back, and stops on plain text', async () => {
    const m = scripted([{ toolCalls: [call('lookup', { q: 1 }, 'a')], usage: { input: 10, output: 2 } }, { text: 'done', usage: { input: 20, output: 3 } }]);
    const runTool = vi.fn(async (_n: string, args: any) => ({ value: args.q * 2 }));
    const events: any[] = [];
    const r = await runAgent({ complete: m.complete, system: 's', messages: [{ role: 'user', content: 'hi' }], tools, runTool, onEvent: (e: any) => events.push(e) });
    expect(r).toMatchObject({ status: 'answered', text: 'done', steps: 2, usage: { input: 30, output: 5 } });
    expect(r.transcript).toEqual([{ name: 'lookup', args: { q: 1 }, result: { value: 2 } }]);
    expect(m.seen[1].messages.slice(1)).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }] },
      { role: 'tool', tool_call_id: 'a', content: '{"value":2}' },
    ]);
    expect(events).toEqual([{ type: 'tool_start', name: 'lookup', args: { q: 1 } }, { type: 'tool_end', name: 'lookup', ok: true }]);
  });

  it('returns a final tool call without running it', async () => {
    const m = scripted([{ toolCalls: [call('lookup')] }, { toolCalls: [call('submit', { answer: 42 })] }]);
    const runTool = vi.fn(async () => ({}));
    const r = await runAgent({ complete: m.complete, system: 's', messages: [], tools, runTool, isFinal: (c: any) => c.name === 'submit' });
    expect(r).toMatchObject({ status: 'final', final: { answer: 42 } });
    expect(runTool).toHaveBeenCalledTimes(1);
  });

  it('answers unknown tools, bad arguments and thrown tools with an error result', async () => {
    const m = scripted([{ toolCalls: [call('nope', {}, 'x'), { id: 'y', name: 'lookup', args: {}, argsError: true }, call('lookup', {}, 'z')] }, { text: 'ok' }]);
    const r = await runAgent({ complete: m.complete, system: 's', messages: [], tools, runTool: async () => { throw new Error('secret detail'); } });
    const results = r.messages.filter((x: any) => x.role === 'tool').map((x: any) => JSON.parse(x.content));
    expect(results).toEqual([{ error: 'unknown_tool', tools: ['lookup', 'submit'] }, { error: 'invalid_arguments', detail: 'arguments were not valid JSON' }, { error: 'tool_failed' }]);
    expect(JSON.stringify(r.messages)).not.toContain('secret detail');
  });

  it('spends the tool budget, then asks once more without tools', async () => {
    const m = scripted([{ toolCalls: [call('lookup'), call('lookup'), call('lookup')] }, { text: 'answer', toolCalls: [call('lookup')] }]);
    const runTool = vi.fn(async () => ({ ok: 1 }));
    const r = await runAgent({ complete: m.complete, system: 's', messages: [], tools, runTool, maxToolCalls: 2 });
    expect(runTool).toHaveBeenCalledTimes(2);
    expect(m.seen[1].tools).toEqual([]);
    expect(r).toMatchObject({ status: 'answered', text: 'answer' });
    expect(JSON.parse((r.messages.filter((x: any) => x.role === 'tool')[2] as any).content)).toEqual({ error: 'tool_budget_spent' });
  });

  it('tools that end the run stay available after the lookup budget is spent', async () => {
    const m = scripted([{ toolCalls: [call('lookup')] }, { toolCalls: [call('lookup'), call('submit', { answer: 1 })] }]);
    const runTool = vi.fn(async () => ({ ok: 1 }));
    const r = await runAgent({ complete: m.complete, system: 's', messages: [], tools, runTool, maxToolCalls: 1, isFinal: (c: any) => c.name === 'submit', finalTools: ['submit'] });
    expect(m.seen[1].tools.map((t: any) => t.name)).toEqual(['submit']);
    expect(r).toMatchObject({ status: 'final', final: { answer: 1 } });
    // The extra lookup the model asked for on that turn is not run.
    expect(runTool).toHaveBeenCalledTimes(1);
  });

  it('stops at the step budget and on abort', async () => {
    const m = scripted([{ toolCalls: [call('lookup')] }]);
    expect(await runAgent({ complete: m.complete, system: 's', messages: [], tools, runTool: async () => ({}), maxSteps: 3, maxToolCalls: 99 })).toMatchObject({ status: 'budget', steps: 3 });
    const ac = new AbortController(); ac.abort();
    await expect(runAgent({ complete: m.complete, system: 's', messages: [], tools, runTool: async () => ({}), signal: ac.signal })).rejects.toThrow();
  });

  it('cuts long tool results with a visible marker', () => {
    expect(toolContent({ a: 1 }, 100)).toBe('{"a":1}');
    const cut = toolContent('x'.repeat(50), 10);
    expect(cut.startsWith('xxxxxxxxxx…[truncated: 40 more characters')).toBe(true);
  });

  it('defaults allow deeper multi-tool investigations (28 steps / 60 tool calls)', () => {
    expect(AGENT_DEFAULTS).toEqual({ maxSteps: 28, maxToolCalls: 60, maxToolChars: 40_000 });
  });

  it('accumulates cache breakdown across steps and keeps fields null whenever any step omits them', async () => {
    const m = scripted([
      {
        toolCalls: [call('lookup', { q: 1 }, 'a')],
        usage: { input: 1000, output: 100, input_uncached: 400, cache_read: 600, cache_write: null, source: 'provider_usage' },
      },
      {
        text: 'done',
        usage: { input: 1500, output: 200, input_uncached: 300, cache_read: 1200, cache_write: null, source: 'provider_usage' },
      },
    ]);
    const r = await runAgent({ complete: m.complete, system: 's', messages: [{ role: 'user', content: 'hi' }], tools, runTool: async () => ({ v: 1 }) });
    expect(r.usage).toEqual({
      input: 2500,
      output: 300,
      input_uncached: 700,
      cache_read: 1800,
      cache_write: null,
      source: 'provider_usage',
    });

    // If any step lacks cache breakdown, the accumulated breakdown becomes null instead of treating missing as 0.
    const mixed = scripted([
      {
        toolCalls: [call('lookup', { q: 1 }, 'a')],
        usage: { input: 1000, output: 100, input_uncached: 400, cache_read: 600, cache_write: null, source: 'provider_usage' },
      },
      {
        text: 'done',
        usage: { input: 1500, output: 200, input_uncached: null, cache_read: null, cache_write: null, source: 'provider_usage' },
      },
    ]);
    const rMixed = await runAgent({ complete: mixed.complete, system: 's', messages: [{ role: 'user', content: 'hi' }], tools, runTool: async () => ({ v: 1 }) });
    expect(rMixed.usage).toEqual({
      input: 2500,
      output: 300,
      input_uncached: null,
      cache_read: null,
      cache_write: null,
      source: 'provider_usage',
    });

    // If any step omits usage altogether, source becomes null (never claims full provider telemetry).
    const noUsage = scripted([{ toolCalls: [call('lookup', { q: 1 }, 'a')], usage: { input: 100, output: 10 } }, { text: 'done' }]);
    const rNoUsage = await runAgent({ complete: noUsage.complete, system: 's', messages: [{ role: 'user', content: 'hi' }], tools, runTool: async () => ({ v: 1 }) });
    expect(rNoUsage.usage).toEqual({
      input: 100,
      output: 10,
      input_uncached: null,
      cache_read: null,
      cache_write: null,
      source: null,
    });
  });

  it('deduplicates repeated identical large tool calls in messages while preserving transcript and tool budget', async () => {
    const bigPayload = { ref: 'deaths:axe', summary: 'x'.repeat(500), events: [{ t: 100, detail: 'y'.repeat(500) }] };
    const m = scripted([
      { toolCalls: [call('lookup', { hero: 'axe', limit: 5 }, 'c1')] },
      // Identical canonical arguments with keys in reversed order:
      { toolCalls: [call('lookup', { limit: 5, hero: 'axe' }, 'c2')] },
      { text: 'finished' },
    ]);
    const runTool = vi.fn(async () => bigPayload);
    const events: any[] = [];
    const r = await runAgent({
      complete: m.complete,
      system: 's',
      messages: [{ role: 'user', content: 'check' }],
      tools,
      runTool,
      onEvent: (e: any) => events.push(e),
    });
    expect(r.status).toBe('answered');
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(r.duplicate_tool_calls).toBe(1);
    // Transcript keeps the full result intact for downstream verification.
    expect(r.transcript).toEqual([{ name: 'lookup', args: { hero: 'axe', limit: 5 }, result: bigPayload }]);
    const toolMsgs = r.messages.filter((msg: any) => msg.role === 'tool') as any[];
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0].content).toBe(JSON.stringify(bigPayload));
    const dup = JSON.parse(toolMsgs[1].content);
    expect(dup).toMatchObject({ duplicate_of: 'c1', tool: 'lookup' });
    expect(toolMsgs[1].content.length).toBeLessThan(toolMsgs[0].content.length / 4);
    expect(events.some((e) => e.type === 'tool_end' && e.duplicate === true)).toBe(true);

    // Pre-seeded messages (e.g. a repair round) also deduplicate against earlier results in context.
    const repairModel = scripted([
      { toolCalls: [call('lookup', { hero: 'axe', limit: 5 }, 'r1')] },
      { text: 'repaired' },
    ]);
    const repairRunTool = vi.fn(async () => bigPayload);
    const rRepair = await runAgent({
      complete: repairModel.complete,
      system: 's',
      messages: r.messages.slice(0, 3), // user + assistant(c1) + tool(bigPayload)
      tools,
      runTool: repairRunTool,
    });
    expect(repairRunTool).not.toHaveBeenCalled();
    expect(rRepair.duplicate_tool_calls).toBe(1);
    expect(JSON.parse((rRepair.messages.at(-2) as any).content)).toMatchObject({ duplicate_of: 'c1', tool: 'lookup' });

    // Failed tool results ({ error: ... }) are never cached/deduplicated so transient errors can be retried.
    let errCalls = 0;
    const retryErr = scripted([
      { toolCalls: [call('lookup', { hero: 'axe' }, 'e1')] },
      { toolCalls: [call('lookup', { hero: 'axe' }, 'e2')] },
      { text: 'ok' },
    ]);
    const rErr = await runAgent({
      complete: retryErr.complete,
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      tools,
      runTool: async () => {
        errCalls += 1;
        return errCalls === 1 ? { error: 'transient_failure', detail: 'z'.repeat(400) } : bigPayload;
      },
    });
    expect(errCalls).toBe(2);
    expect(rErr.duplicate_tool_calls).toBe(0);
    expect(rErr.transcript).toHaveLength(2);
  });
});

describe('openAiCompatible', () => {
  it('sends tools as functions and reads tool calls back', async () => {
    const create = vi.fn(async () => ({ choices: [{ message: { content: null, tool_calls: [{ id: 't1', function: { name: 'lookup', arguments: '{"q":2}' } }, { id: 't2', function: { name: 'lookup', arguments: '{bad' } }, { id: 't3', function: { name: 'lookup', arguments: '[1]' } }] } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
    const complete = openAiCompatible({ client: { chat: { completions: { create } } }, model: 'deepseek-flash', extraBody: { thinking: { type: 'disabled' } } });
    const signal = new AbortController().signal;
    const out = await complete({ system: 'sys', messages: [{ role: 'user', content: 'u' }], tools, signal });
    expect(create).toHaveBeenCalledWith({
      model: 'deepseek-flash',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }],
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
      thinking: { type: 'disabled' },
    }, { signal });
    expect(out).toEqual({
      text: '',
      toolCalls: [{ id: 't1', name: 'lookup', args: { q: 2 } }, { id: 't2', name: 'lookup', args: {}, argsError: true }, { id: 't3', name: 'lookup', args: {}, argsError: true }],
      usage: { input: 7, output: 3, input_uncached: null, cache_read: null, cache_write: null, source: 'provider_usage' },
    });
  });

  it('extracts DeepSeek, OpenAI, and Anthropic-compatible cache token breakdowns without fabricating zeros', async () => {
    const runWith = async (usage: any) => openAiCompatible({
      client: { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'ok' } }], usage }) } } },
      model: 'm',
    })({ system: 's', messages: [], tools: [] });

    // DeepSeek: prompt_cache_hit_tokens + prompt_cache_miss_tokens (cache_write stays null)
    expect((await runWith({ prompt_tokens: 10_000, completion_tokens: 1200, prompt_cache_hit_tokens: 7200, prompt_cache_miss_tokens: 2800 })).usage).toEqual({
      input: 10_000, output: 1200, input_uncached: 2800, cache_read: 7200, cache_write: null, source: 'provider_usage',
    });

    // OpenAI: prompt_tokens_details.cached_tokens (input_uncached derived cleanly, cache_write stays null)
    expect((await runWith({ prompt_tokens: 8000, completion_tokens: 900, prompt_tokens_details: { cached_tokens: 5000 } })).usage).toEqual({
      input: 8000, output: 900, input_uncached: 3000, cache_read: 5000, cache_write: null, source: 'provider_usage',
    });

    // Anthropic-compatible proxy: cached_tokens + cache_creation_input_tokens
    expect((await runWith({ prompt_tokens: 9000, completion_tokens: 600, prompt_tokens_details: { cached_tokens: 4000 }, cache_creation_input_tokens: 1500 })).usage).toEqual({
      input: 9000, output: 600, input_uncached: 3500, cache_read: 4000, cache_write: 1500, source: 'provider_usage',
    });

    // Cache write reported without cache_read -> cache_read & input_uncached remain null (unknown is not 0)
    expect((await runWith({ prompt_tokens: 5000, completion_tokens: 400, cache_creation_input_tokens: 1000 })).usage).toEqual({
      input: 5000, output: 400, input_uncached: null, cache_read: null, cache_write: 1000, source: 'provider_usage',
    });
  });

  it('a thinking model\'s reasoning travels back with its tool calls', async () => {
    const replies = [
      { choices: [{ message: { content: '', reasoning_content: 'look it up first', tool_calls: [{ id: 't1', function: { name: 'lookup', arguments: '{}' } }] } }] },
      { choices: [{ message: { content: 'done', reasoning_content: 'now answer' } }] },
    ];
    let i = 0;
    const create = vi.fn(async (_body: any) => replies[i++]);
    const complete = openAiCompatible({ client: { chat: { completions: { create } } }, model: 'deepseek-flash', extraBody: { thinking: { type: 'enabled' } } });
    const r = await runAgent({ complete, system: 's', messages: [{ role: 'user', content: 'u' }], tools, runTool: async () => ({ ok: 1 }) });
    expect(r.text).toBe('done');
    // The second request carries the first reply's reasoning on the assistant message that made the tool call.
    const second = (create.mock.calls[1] as any[])[0].messages;
    expect(second[2]).toEqual({ role: 'assistant', content: '', reasoning_content: 'look it up first', tool_calls: [{ id: 't1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] });
    // The final answer's reasoning is not stored: a new turn starts without it.
    expect(r.messages.at(-1)).toEqual({ role: 'assistant', content: 'done' });
  });

  it('omits tools when there are none and tolerates an empty reply', async () => {
    const create = vi.fn(async () => ({}));
    const out = await openAiCompatible({ client: { chat: { completions: { create } } }, model: 'm' })({ system: 's', messages: [], tools: [] });
    expect((create.mock.calls[0] as any[])[0]).not.toHaveProperty('tools');
    expect(out).toEqual({
      text: '',
      toolCalls: [],
      usage: { input: 0, output: 0, input_uncached: null, cache_read: null, cache_write: null, source: null },
    });
  });
});
