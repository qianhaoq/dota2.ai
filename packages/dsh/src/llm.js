/**
 * Bridge between DSH's host model service (`ctx.llm` / `agentDefaultModel`) and
 * dota2.ai's vendor-neutral `runAgent` `complete` contract (lib/agent/loop.js).
 *
 * Pure of static `@deepseek-ai/*` imports so unit tests run in Node 20 without a
 * DSH installation; `index.js` passes the `@deepseek-ai/dsh-llm` helpers in.
 */

const esc = (s) => String(s ?? '').replace(/[^A-Za-z0-9-]/g, (ch) => `_${ch.codePointAt(0).toString(16)}_`);
const unesc = (s) => String(s ?? '').replace(/_([0-9a-f]+)_/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));

/**
 * Encode `{ provider, model }` into a reversible ID starting with `dsh.` that
 * satisfies `lib/agent/stores.js` (`KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/`).
 */
export function encodeModelKey(provider, model) {
  const raw = `dsh.${esc(provider)}.${esc(model)}`;
  return raw.length <= 180 ? raw : raw.slice(0, 180);
}

/** Decode a `dsh.<provider>.<model>` ID back to `{ provider, model }`, or null. */
export function decodeModelKey(key) {
  if (typeof key !== 'string' || !key.startsWith('dsh.')) return null;
  const parts = key.split('.');
  if (parts.length !== 3 || !parts[1] || !parts[2]) return null;
  return { provider: unesc(parts[1]), model: unesc(parts[2]) };
}

/** Minimal fallback message/assembler builders when `@deepseek-ai/dsh-llm` is mocked in unit tests. */
const fallbackPrimitives = {
  createUserMessage: ({ content, source }) => ({ id: 'u', role: 'user', content, source }),
  createAssistantMessage: ({ content, source }) => ({ id: 'a', role: 'assistant', content, source: { kind: 'model', ...source } }),
  createToolResultMessage: ({ callId, content, isError }) => ({ id: 't', role: 'tool', toolCallId: callId, content, isError, source: { kind: 'tool', callId } }),
  BlockAssembler: class FallbackBlockAssembler {
    constructor() {
      this._blocks = new Map();
      this._order = [];
      this.usage = undefined;
      this.finish = { kind: 'stop' };
      this.replayState = undefined;
    }
    push(chunk) {
      if (chunk.type === 'usage') { this.usage = chunk.usage; return; }
      if (chunk.type === 'finish') { this.finish = chunk.reason; this.replayState = chunk.replayState; return; }
      const idx = chunk.index ?? 0;
      if (!this._blocks.has(idx)) { this._blocks.set(idx, { type: chunk.blockType ?? 'text', text: '', arguments: '' }); this._order.push(idx); }
      const cur = this._blocks.get(idx);
      if (chunk.type === 'block-end') { this._blocks.set(idx, chunk.block); return; }
      if (chunk.type === 'text-delta') { cur.type = 'text'; cur.text += chunk.text; }
      else if (chunk.type === 'reasoning-delta') { cur.type = 'reasoning'; cur.text += chunk.text; }
      else if (chunk.type === 'tool-call-delta') {
        cur.type = 'tool-call';
        cur.id = chunk.id ?? cur.id;
        if (chunk.name) cur.name = chunk.name;
        cur.arguments += chunk.argumentsDelta ?? '';
      }
    }
    blocks() {
      return this._order.map((i) => this._blocks.get(i));
    }
  },
};

const DEFAULT_MAX_TOKENS = 16_384;

/**
 * Build a `complete({ system, messages, tools, signal })` function backed by
 * `ctx.llm` for one concrete `{ provider, model, reasoningEffort? }` route.
 */
export function createDshComplete({ ctx, route, primitives = fallbackPrimitives, maxTokens = DEFAULT_MAX_TOKENS }) {
  const { BlockAssembler, createUserMessage, createAssistantMessage, createToolResultMessage } = {
    ...fallbackPrimitives,
    ...primitives,
  };
  return async ({ system, messages = [], tools = [], signal }) => {
    const llm = ctx.get?.('llm') ?? ctx.llm;
    if (!llm) {
      const err = new Error('DSH model service is unavailable');
      err.status = 503;
      throw err;
    }
    let effort = route.reasoningEffort;
    let resolvedMaxTokens = maxTokens;
    if (typeof llm.resolveModelInfo === 'function') {
      try {
        const info = await llm.resolveModelInfo(route.provider, route.model, signal);
        if (effort && info?.reasoning?.efforts && !info.reasoning.efforts.some((e) => e.id === effort)) {
          effort = undefined;
        }
        if (Number.isInteger(info?.defaultMaxTokens) && info.defaultMaxTokens > 0 && info.defaultMaxTokens < resolvedMaxTokens) {
          resolvedMaxTokens = info.defaultMaxTokens;
        }
      } catch {
        // Model discovery metadata is advisory; prepareCall/stream owns dispatch validation.
        effort = undefined;
      }
    }

    const callConfig = {
      provider: route.provider,
      model: route.model,
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(resolvedMaxTokens ? { maxTokens: resolvedMaxTokens } : {}),
    };

    const dshMessages = [];
    for (const m of messages) {
      if (!m || m.role === 'system') continue;
      if (m.role === 'user') {
        dshMessages.push(createUserMessage({
          content: [{ type: 'text', text: String(m.content ?? '') }],
          source: { kind: 'dota2ai', form: 'instructions' },
        }));
      } else if (m.role === 'assistant') {
        const content = [];
        if (typeof m.reasoning_content === 'string' && m.reasoning_content) {
          content.push({ type: 'reasoning', text: m.reasoning_content });
        }
        if (typeof m.content === 'string' && m.content) {
          content.push({ type: 'text', text: m.content });
        }
        for (const tc of m.tool_calls ?? []) {
          if (!tc?.function?.name) continue;
          content.push({
            type: 'tool-call',
            id: tc.id,
            name: tc.function.name,
            arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments ?? {}),
          });
        }
        if (!content.length) content.push({ type: 'text', text: '' });
        dshMessages.push(createAssistantMessage({
          content,
          source: {
            provider: route.provider,
            model: route.model,
            ...(m.provider_state !== undefined ? { replayState: m.provider_state } : {}),
          },
        }));
      } else if (m.role === 'tool') {
        dshMessages.push(createToolResultMessage({
          callId: m.tool_call_id,
          content: [{ type: 'text', text: String(m.content ?? '') }],
          isError: false,
        }));
      }
    }

    const dshTools = Array.isArray(tools) && tools.length > 0
      ? tools.map((t) => ({ name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object', properties: {} } }))
      : undefined;

    const assembler = new BlockAssembler();
    const streamSource = typeof llm.prepareCall === 'function'
      ? await llm.prepareCall(callConfig, signal)
      : { config: callConfig, stream: (opts) => llm.stream(opts) };

    for await (const chunk of streamSource.stream({
      ...streamSource.config,
      ...(system ? { system } : {}),
      messages: dshMessages,
      ...(dshTools ? { tools: dshTools } : {}),
      ...(signal ? { signal } : {}),
    })) {
      assembler.push(chunk);
    }

    const finish = assembler.finish;
    if (finish?.kind === 'aborted' || signal?.aborted) {
      const err = new DOMException(finish?.failure?.message || 'Aborted', 'AbortError');
      throw err;
    }
    if (finish?.kind === 'error') {
      const err = new Error(finish.failure?.message || 'Model call failed');
      if (Number.isInteger(finish.failure?.status)) err.status = finish.failure.status;
      else if (finish.failure?.code === 'AUTH') err.status = 401;
      else if (finish.failure?.code === 'RATE_LIMIT') err.status = 429;
      throw err;
    }

    let text = '';
    let reasoning = '';
    const toolCalls = [];
    const blocks = assembler.blocks();
    for (let i = 0; i < blocks.length; i += 1) {
      const b = blocks[i];
      if (!b) continue;
      if (b.type === 'text') text += b.text ?? '';
      else if (b.type === 'reasoning') reasoning += b.text ?? '';
      else if (b.type === 'tool-call') {
        let args = {};
        let argsError = false;
        try {
          args = b.arguments ? JSON.parse(b.arguments) : {};
        } catch {
          argsError = true;
        }
        if (args == null || typeof args !== 'object' || Array.isArray(args)) {
          args = {};
          argsError = true;
        }
        toolCalls.push({
          id: b.id ?? `call_${i}`,
          name: b.name,
          args,
          ...(argsError ? { argsError } : {}),
        });
      }
    }

    const u = assembler.usage;
    const inputTokens = (u?.inputTokens ?? 0) + (u?.cacheReadTokens ?? 0) + (u?.cacheWriteTokens ?? 0);
    const outputTokens = u?.outputTokens ?? 0;

    return {
      text,
      ...(reasoning ? { reasoning } : {}),
      ...(assembler.replayState !== undefined ? { providerState: assembler.replayState } : {}),
      toolCalls,
      usage: { input: inputTokens, output: outputTokens },
    };
  };
}

/**
 * Live catalog of models configured in the DSH host:
 * - Reads `agentDefaultModel.currentSelection()` synchronously so changing the
 *   default model in DSH takes effect immediately.
 * - Discovers all advertised models across `ctx.llm.listProviders()` in the
 *   background and refreshes whenever `'llm/adapters-updated'` fires.
 */
export function createDshModelRegistry({ ctx, primitives = fallbackPrimitives }) {
  /** @type {Map<string, { provider: string, providerName: string, model: string, modelName: string }>} */
  let discovered = new Map();
  let refreshing = null;

  const currentSelection = () => {
    const sel = (ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel)?.currentSelection?.();
    return sel?.provider && sel?.model ? { provider: sel.provider, model: sel.model, ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}) } : null;
  };

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const llm = ctx.get?.('llm') ?? ctx.llm;
      if (!llm || typeof llm.listProviders !== 'function') {
        discovered = new Map();
        return;
      }
      const next = new Map();
      let providers = [];
      try { providers = llm.listProviders() ?? []; } catch { providers = []; }
      for (const p of providers) {
        if (!p?.id) continue;
        let models = [];
        try { models = (await llm.listModels?.(p.id)) ?? []; } catch { models = []; }
        for (const m of models) {
          if (!m?.id) continue;
          const key = encodeModelKey(p.id, m.id);
          next.set(key, {
            provider: p.id,
            providerName: p.name || p.id,
            model: m.id,
            modelName: m.name || m.id,
          });
        }
      }
      discovered = next;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  function catalog() {
    const llm = ctx.get?.('llm') ?? ctx.llm;
    if (!llm) return { models: {}, defaultModel: null, modelMeta: null };
    const sel = currentSelection();
    /** @type {Record<string, { complete: Function, name: string, maxMs: number }>} */
    const models = {};
    /** @type {Record<string, { label: string, minutes: null }>} */
    const modelMeta = {};

    const add = (provider, model, label, reasoningEffort) => {
      const id = encodeModelKey(provider, model);
      if (models[id]) return id;
      const route = { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
      models[id] = {
        complete: createDshComplete({ ctx, route, primitives }),
        name: `${provider}/${model}`,
        // Host models may include slow thinking models or remote gateways: allow the 25-min ceiling.
        maxMs: 25 * 60_000,
      };
      modelMeta[id] = { label, minutes: null };
      return id;
    };

    let defaultModel = null;
    if (sel) {
      const known = discovered.get(encodeModelKey(sel.provider, sel.model));
      const label = known
        ? `${known.modelName} (${known.providerName})`
        : `${sel.model} (${sel.provider})`;
      defaultModel = add(sel.provider, sel.model, label, sel.reasoningEffort);
    }

    for (const entry of discovered.values()) {
      const id = add(entry.provider, entry.model, `${entry.modelName} (${entry.providerName})`);
      if (!defaultModel) defaultModel = id;
    }

    return { models, defaultModel, modelMeta: Object.keys(modelMeta).length ? modelMeta : null };
  }

  return {
    refresh,
    catalog,
    currentSelection,
    isConfigured: () => Boolean(catalog().defaultModel),
    defaultComplete: () => {
      const cat = catalog();
      return cat.defaultModel ? cat.models[cat.defaultModel]?.complete ?? null : null;
    },
  };
}
