import { describe, expect, it, vi } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '@dota2ai/mcp';
import { createCoachHandlers } from 'dota2ai/handlers';
import { TOOL_DOCS } from 'dota2ai/tools';
import { buildCoachReport } from '../../../lib/coach/analyze.js';
import { runAgent } from '../../../lib/agent/loop.js';
import { PARAMETERS, TOOL_NAMES, toolOptions } from '../src/tools.js';
import { SKILL, headersFor, skillBody, skillRegistration } from '../src/skill.js';
import { MAX_MODEL_KEY_LENGTH, createDshComplete, createDshModelRegistry, decodeModelKey, encodeModelKey } from '../src/llm.js';
import { createDshTracePipeline, normalizeTraceGzip } from '../src/traceSource.js';
import { createDshService, resolveDataHome, synthesizeMatchFromCoachReport } from '../src/service.js';
import { TYPERT, TYPERT_REMOTE } from '../src/typert.js';
import { createFileStore, createTraceStore } from '../../../lib/agent/stores.js';
import { createAgentService } from '../../../lib/agent/service.js';
import { gzipSync } from 'node:zlib';
import { buildPlugin } from '../scripts/build.mjs';
import { releaseManifest } from '../scripts/pack.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../../src/fixtures/coach/match9091400302.parsed.json', import.meta.url), 'utf8'));
const report = buildCoachReport(fixture);
const traceFixturePath = new URL('../../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url);
const traceGzBytes = readFileSync(traceFixturePath);
const scoreboard9100904020 = JSON.parse(readFileSync(new URL('../../../src/fixtures/agent/match9100904020.scoreboard.json', import.meta.url), 'utf8'));

/** The coach API shape (packages/cli/src/coachApi.js) over a fixture. */
const fixtureCoach = {
  report: async (id) => {
    if (String(id) === '9091400302') return report;
    throw Object.assign(new Error('Match not found'), { code: 'NOT_FOUND' });
  },
};

const unusedReplay = { review: async () => { throw new Error('not called'); } };
const byName = (tools) => Object.fromEntries(tools.map((t) => [t.name, t]));

/** An MCP client on an in-memory server, as the hosted endpoint is built (replay_review only). */
async function mcpClient(options) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ review: async () => ({}), coachTools: false, ...options });
  await server.connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  return client;
}

/** Stream helper that turns scripted DSH blocks into `@deepseek-ai/dsh-llm` stream chunks. */
function scriptedDshLlm(turnHandler, { providers = [{ id: 'deepseek', name: 'DeepSeek' }], modelsByProvider = { deepseek: [{ id: 'deepseek-chat', name: 'DeepSeek V3' }, { id: 'deepseek-reasoner', name: 'DeepSeek R1' }] }, modelInfo = null } = {}) {
  const calls = [];
  return {
    calls,
    listProviders: () => providers,
    listModels: async (providerId) => modelsByProvider[providerId] ?? [],
    resolveModelInfo: async (provider, model) => (typeof modelInfo === 'function' ? modelInfo(provider, model) : modelInfo),
    prepareCall: async (config) => ({
      config,
      async *stream(opts) {
        calls.push(opts);
        const turn = await turnHandler(opts, calls.length - 1);
        let idx = 0;
        if (turn.reasoning) {
          yield { type: 'reasoning-delta', index: idx, text: turn.reasoning };
          idx += 1;
        }
        if (turn.text) {
          yield { type: 'text-delta', index: idx, text: turn.text };
          idx += 1;
        }
        for (const tc of turn.toolCalls ?? []) {
          yield {
            type: 'block-end',
            index: idx,
            block: {
              type: 'tool-call',
              id: tc.id ?? `call_${idx}`,
              name: tc.name,
              arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}),
            },
          };
          idx += 1;
        }
        if (turn.usage) yield { type: 'usage', usage: turn.usage };
        yield {
          type: 'finish',
          reason: turn.finish ?? { kind: (turn.toolCalls?.length ? 'tool-use' : 'stop') },
          ...(turn.replayState !== undefined ? { replayState: turn.replayState } : {}),
        };
      },
    }),
  };
}

describe('DSH tool definitions', () => {
  it('offers the replay review and the six coach tools, prefixed so the dota_* coach plugin can sit next to it', () => {
    const tools = toolOptions({ coach: {}, replay: unusedReplay });
    expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    expect(TOOL_NAMES).toEqual(['dota2ai_replay_review', 'dota2ai_recent_matches', 'dota2ai_coach_report', 'dota2ai_coach_cases', 'dota2ai_coach_ask', 'dota2ai_goal_check', 'dota2ai_hero_matchup']);
    for (const t of tools) {
      const doc = TOOL_DOCS[t.name.replace('dota2ai_', '')];
      expect(t.description).toBe(doc.dsh ?? doc.description);
      expect(t.timeoutMs).toBeGreaterThan(0);
      expect(t.output.render({}, { a: 1 })).toEqual([{ type: 'text', text: '{"a":1}' }]);
    }
  });

  it('takes the same arguments as the MCP tools, with the same ones required and the same words', async () => {
    const client = await mcpClient({ coachTools: true, coach: fixtureCoach, replay: unusedReplay });
    const mcp = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t]));
    for (const [name, params] of Object.entries(PARAMETERS)) {
      const schema = mcp[name].inputSchema;
      expect(mcp[name].description).toBe(TOOL_DOCS[name].description);
      expect(Object.keys(params).sort(), name).toEqual(Object.keys(schema.properties).sort());
      const required = Object.entries(params).filter(([, p]) => p.required).map(([k]) => k).sort();
      expect(required, name).toEqual([...(schema.required ?? [])].sort());
      for (const [k, p] of Object.entries(params)) {
        if (schema.properties[k].description) expect(p.description, `${name}.${k}`).toBe(schema.properties[k].description);
      }
    }
  });

  it('answers in the configured language when the call names none, and keeps the one it names', async () => {
    const seen = [];
    const coach = { coach_cases: async (args) => { seen.push(args.lang); return { ok: 1 }; } };
    const tools = byName(toolOptions({ coach, replay: unusedReplay, lang: 'zh' }));
    await tools.dota2ai_coach_cases.execute({ match_id: 1, hero: 'ursa' });
    await tools.dota2ai_coach_cases.execute({ match_id: 1, hero: 'ursa', lang: 'en' });
    expect(seen).toEqual(['zh', 'en']);
  });

  it('returns what the shared coach handlers return (the MCP shapes)', async () => {
    const tools = byName(toolOptions({ coach: createCoachHandlers({ coach: fixtureCoach }), replay: unusedReplay }));
    const roster = await tools.dota2ai_coach_report.execute({ match_id: 9091400302 });
    expect(roster.roster).toHaveLength(10);
    expect(roster.note).toMatch(/never guess/);
    const why = await tools.dota2ai_coach_report.execute({ match_id: 9091400302, hero: roster.roster[0].hero.slug, section: 'why' });
    expect(why.section).toBe('why');
    expect(why.url).toMatch(/^https:\/\/dota2\.ai\/r\/9091400302\?p=/);
  });

  it('fails with our own words: known codes keep theirs, anything else hides the raw message', async () => {
    const thrower = (error) => async () => { throw error; };
    const coach = {
      recent_matches: thrower(Object.assign(new Error('dota2.ai request failed'), { code: 'UPSTREAM' })),
      coach_report: thrower(Object.assign(new Error('Match not found'), { code: 'NOT_FOUND' })),
      hero_matchup: thrower(new Error('ECONNRESET 10.0.0.1:443 secret upstream body')),
    };
    const tools = byName(toolOptions({ coach, replay: unusedReplay }));
    await expect(tools.dota2ai_recent_matches.execute({ account: '1' })).rejects.toThrow('dota2.ai request failed (temporary; retry later)');
    await expect(tools.dota2ai_coach_report.execute({ match_id: 1 })).rejects.toThrow('Match not found');
    await expect(tools.dota2ai_hero_matchup.execute({ hero: 'a', vs: 'b' })).rejects.toThrow(/^Coach request failed$/);
  });
});

describe('the words of the DSH tools', () => {
  it('say where the review runs and where to read it, not the hosted limits', () => {
    const tools = byName(toolOptions({ coach: {}, replay: unusedReplay }));
    expect(tools.dota2ai_replay_review.description).toContain("user's own DSH model");
    expect(tools.dota2ai_replay_review.description).toContain('panel_route');
    expect(tools.dota2ai_replay_review.description).not.toMatch(/limited per caller/);
    expect(TOOL_DOCS.replay_review.description).toMatch(/limited per caller/);
    expect(tools.dota2ai_coach_ask.description).toContain('from the replay');
    expect(tools.dota2ai_coach_ask.description).not.toContain('answered only from the report');
  });
});

describe('replay_review tool', () => {
  it('relays every status the review gives, call after call, with the arguments as given', async () => {
    const calls = [];
    const states = [
      { status: 'parsing', match_id: '42', poll_after_sec: 20 },
      { status: 'pick_hero', match_id: '42', heroes: [{ hero: 'ursa', team: 'radiant', en: 'Ursa', zh: '熊战士' }] },
      { status: 'reviewing', match_id: '42', hero: 'ursa', lang: 'zh', steps: 3, poll_after_sec: 20 },
      { status: 'ready', match_id: '42', hero: 'ursa', lang: 'zh', verdict: 'v', findings: [], blind_spots: [], url: 'https://dota2.ai/r/42?hero=ursa&lang=zh' },
    ];
    const replay = { review: async (args) => { calls.push(args); return states[calls.length - 1]; } };
    const tool = byName(toolOptions({ coach: {}, replay, lang: 'zh' })).dota2ai_replay_review;
    const seen = [];
    for (let i = 0; i < states.length; i++) seen.push(await tool.execute({ match_id: 42, hero: 'ursa' }, { signal: new AbortController().signal }));
    expect(seen.map((s) => s.status)).toEqual(['parsing', 'pick_hero', 'reviewing', 'ready']);
    expect(seen[3]).toEqual(states[3]);
    expect(calls[0]).toEqual({ match_id: 42, hero: 'ursa', lang: 'zh' });
  });

  it("passes the review's own refusal through, and hides any other failure", async () => {
    const limited = Object.assign(new Error('match_id must be a Dota 2 match ID (digits).'), { code: 'INVALID_INPUT' });
    const refusing = { review: async () => { throw limited; } };
    const tool = byName(toolOptions({ coach: {}, replay: refusing })).dota2ai_replay_review;
    await expect(tool.execute({ match_id: 42, hero: 'ursa' })).rejects.toThrow('match_id must be a Dota 2 match ID (digits).');

    const down = { review: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:443'); } };
    const tool2 = byName(toolOptions({ coach: {}, replay: down })).dota2ai_replay_review;
    await expect(tool2.execute({ match_id: 42 })).rejects.toThrow(/^Replay review request failed \(temporary; retry later\)$/);
  });
});

describe('DSH host LLM bridge (llm.js)', () => {
  const STORE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;

  it('encodes and decodes arbitrary provider/model pairs into bounded store keys', () => {
    const cases = [
      ['deepseek', 'deepseek-reasoner'],
      ['openrouter', 'anthropic/claude-sonnet-4.5:beta'],
      ['my_provider.v2', 'qwen3_235b-a22b'],
    ];
    for (const [provider, model] of cases) {
      const key = encodeModelKey(provider, model);
      expect(key.startsWith('dsh.')).toBe(true);
      expect(key.length).toBeLessThanOrEqual(MAX_MODEL_KEY_LENGTH);
      expect(STORE_KEY_RE.test(key)).toBe(true);
      expect(decodeModelKey(key)).toEqual({ provider, model });
    }
    // Very long escaped IDs stay bounded (<= 64 chars) and collision-resistant so complete review/feedback keys never exceed 181 chars.
    const longA = encodeModelKey('openrouter-enterprise-gateway', 'anthropic/claude-3.7-sonnet-thinking:beta-custom-endpoint-deployment-v1');
    const longB = encodeModelKey('openrouter-enterprise-gateway', 'anthropic/claude-3.7-sonnet-thinking:beta-custom-endpoint-deployment-v2');
    expect(longA.length).toBeLessThanOrEqual(MAX_MODEL_KEY_LENGTH);
    expect(longB.length).toBeLessThanOrEqual(MAX_MODEL_KEY_LENGTH);
    expect(longA).not.toBe(longB);
    expect(STORE_KEY_RE.test(`9100904020.keeper_of_the_light.zh.p999.plan-teamfight.m-${longA}.f9.abcdefghij1234567890abcd`)).toBe(true);
    expect(decodeModelKey(longA)).toBeNull();
    expect(decodeModelKey('deepseek-flash')).toBeNull();
    expect(decodeModelKey('dsh.onlyone')).toBeNull();
  });

  it('bridges multi-round tool calls, reasoning blocks, replayState, and errors through ctx.llm', async () => {
    const llm = scriptedDshLlm((_opts, turnIdx) => {
      if (turnIdx === 0) {
        return {
          reasoning: 'Let me inspect roar first',
          toolCalls: [{ id: 'tc_1', name: 'lookup', args: { q: 7 } }],
          replayState: { signature: 'sig-round-1' },
          usage: { inputTokens: 100, cacheReadTokens: 25, outputTokens: 12 },
        };
      }
      return {
        text: 'Answer is 14.',
        usage: { inputTokens: 140, outputTokens: 8 },
      };
    }, {
      modelInfo: () => ({ defaultMaxTokens: 8192, reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }] } }),
    });

    const complete = createDshComplete({
      ctx: { llm },
      route: { provider: 'anthropic', model: 'claude-sonnet-4-5', reasoningEffort: 'unsupported-max' },
    });

    const out = await runAgent({
      complete,
      system: 'Coach system',
      messages: [{ role: 'user', content: 'Check 7' }],
      tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object', properties: { q: { type: 'number' } } } }],
      runTool: async (_name, args) => ({ doubled: args.q * 2 }),
    });

    expect(out).toMatchObject({ status: 'answered', text: 'Answer is 14.', usage: { input: 265, output: 20 } });
    // Turn 2 omitted cacheReadTokens -> accumulated cache breakdown stays null instead of coercing unknown to 0.
    expect(out.usage).toEqual({
      input: 265,
      output: 20,
      input_uncached: null,
      cache_read: null,
      cache_write: null,
      source: 'provider_usage',
    });
    // Unsupported reasoningEffort was stripped and maxTokens was capped to defaultMaxTokens (8192).
    expect(llm.calls[0].reasoningEffort).toBeUndefined();
    expect(llm.calls[0].maxTokens).toBe(8192);
    // Round 2 replayed both the reasoning block and the opaque replayState on the assistant tool-call message.
    const round2Assistant = llm.calls[1].messages.find((m) => m.role === 'assistant');
    expect(round2Assistant.content[0]).toEqual({ type: 'reasoning', text: 'Let me inspect roar first' });
    expect(round2Assistant.content[1]).toMatchObject({ type: 'tool-call', id: 'tc_1', name: 'lookup' });
    expect(round2Assistant.source.replayState).toEqual({ signature: 'sig-round-1' });

    // Error mapping: AUTH -> 401, RATE_LIMIT -> 429, aborted -> AbortError, missing llm -> 503.
    const authLlm = scriptedDshLlm(() => ({ finish: { kind: 'error', failure: { code: 'AUTH', message: 'Invalid key' } } }));
    await expect(createDshComplete({ ctx: { llm: authLlm }, route: { provider: 'x', model: 'y' } })({ system: 's', messages: [] }))
      .rejects.toMatchObject({ status: 401 });
    const rlLlm = scriptedDshLlm(() => ({ finish: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'Slow down' } } }));
    await expect(createDshComplete({ ctx: { llm: rlLlm }, route: { provider: 'x', model: 'y' } })({ system: 's', messages: [] }))
      .rejects.toMatchObject({ status: 429 });
    const abortLlm = scriptedDshLlm(() => ({ finish: { kind: 'aborted', failure: { message: 'Cancelled' } } }));
    await expect(createDshComplete({ ctx: { llm: abortLlm }, route: { provider: 'x', model: 'y' } })({ system: 's', messages: [] }))
      .rejects.toMatchObject({ name: 'AbortError' });
    await expect(createDshComplete({ ctx: {}, route: { provider: 'x', model: 'y' } })({ system: 's', messages: [] }))
      .rejects.toMatchObject({ status: 503 });
  });

  it('tracks agentDefaultModel.currentSelection() live and exposes discovered models with untimed modelMeta', async () => {
    let selected = { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' };
    const llm = scriptedDshLlm(() => ({ text: 'ok' }), {
      providers: [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'openai', name: 'OpenAI' }],
      modelsByProvider: {
        deepseek: [{ id: 'deepseek-chat', name: 'DeepSeek V3' }, { id: 'deepseek-reasoner', name: 'DeepSeek R1' }],
        openai: [{ id: 'gpt-5', name: 'GPT-5' }],
      },
    });
    const reg = createDshModelRegistry({
      ctx: {
        llm,
        agentDefaultModel: { currentSelection: () => selected },
      },
    });
    await reg.refresh();
    const cat1 = reg.catalog();
    expect(cat1.defaultModel).toBe(encodeModelKey('deepseek', 'deepseek-reasoner'));
    expect(Object.keys(cat1.models)).toEqual([
      encodeModelKey('deepseek', 'deepseek-reasoner'),
      encodeModelKey('deepseek', 'deepseek-chat'),
      encodeModelKey('openai', 'gpt-5'),
    ]);
    expect(cat1.modelMeta[cat1.defaultModel]).toEqual({ label: 'DeepSeek R1 (DeepSeek)', minutes: null });

    // Switching the model in DSH immediately updates defaultModel without restarting.
    selected = { provider: 'openai', model: 'gpt-5' };
    expect(reg.catalog().defaultModel).toBe(encodeModelKey('openai', 'gpt-5'));
  });

  it('preserves exact DSH cacheReadTokens/cacheWriteTokens breakdown and keeps absent cache fields null', async () => {
    // 1. Full Anthropic-style cache split (inputTokens + cacheReadTokens + cacheWriteTokens)
    const fullLlm = scriptedDshLlm(() => ({
      text: 'ok',
      usage: { inputTokens: 1500, cacheReadTokens: 8200, cacheWriteTokens: 1300, outputTokens: 450 },
    }));
    const fullReply = await createDshComplete({ ctx: { llm: fullLlm }, route: { provider: 'anthropic', model: 'claude-sonnet-4-5' } })({ system: 's', messages: [] });
    expect(fullReply.usage).toEqual({
      input: 11_000,
      output: 450,
      input_uncached: 1500,
      cache_read: 8200,
      cache_write: 1300,
      source: 'provider_usage',
    });

    // 2. DeepSeek-style cache split (inputTokens + cacheReadTokens, no cacheWriteTokens -> cache_write stays null)
    const dsLlm = scriptedDshLlm(() => ({
      text: 'ok',
      usage: { inputTokens: 3200, cacheReadTokens: 9100, outputTokens: 600 },
    }));
    const dsReply = await createDshComplete({ ctx: { llm: dsLlm }, route: { provider: 'deepseek', model: 'deepseek-chat' } })({ system: 's', messages: [] });
    expect(dsReply.usage).toEqual({
      input: 12_300,
      output: 600,
      input_uncached: 3200,
      cache_read: 9100,
      cache_write: null,
      source: 'provider_usage',
    });

    // 3. Provider reporting only inputTokens/outputTokens (no cache telemetry -> all cache breakdown fields null)
    const plainLlm = scriptedDshLlm(() => ({
      text: 'ok',
      usage: { inputTokens: 4000, outputTokens: 500 },
    }));
    const plainReply = await createDshComplete({ ctx: { llm: plainLlm }, route: { provider: 'custom', model: 'm' } })({ system: 's', messages: [] });
    expect(plainReply.usage).toEqual({
      input: 4000,
      output: 500,
      input_uncached: null,
      cache_read: null,
      cache_write: null,
      source: 'provider_usage',
    });

    // 4. Provider omitting usage chunk entirely -> source: null, breakdown fields null
    const emptyLlm = scriptedDshLlm(() => ({ text: 'ok' }));
    const emptyReply = await createDshComplete({ ctx: { llm: emptyLlm }, route: { provider: 'custom', model: 'm' } })({ system: 's', messages: [] });
    expect(emptyReply.usage).toEqual({
      input: 0,
      output: 0,
      input_uncached: null,
      cache_read: null,
      cache_write: null,
      source: null,
    });
  });
});

describe('DSH hybrid trace source (traceSource.js)', () => {
  it('validates both gzipped and proxy-decompressed JSON traces, rejecting wrong match IDs', () => {
    const fromGz = normalizeTraceGzip(traceGzBytes, '9100904020');
    expect(fromGz[0]).toBe(0x1f);
    const plainJson = gunzipSync(traceGzBytes);
    const recompressed = normalizeTraceGzip(plainJson, '9100904020');
    expect(JSON.parse(gunzipSync(recompressed).toString('utf8')).match_id).toBe(9100904020);
    expect(() => normalizeTraceGzip(traceGzBytes, '9999999')).toThrow('invalid_trace');
    expect(() => normalizeTraceGzip(Buffer.from('{}'), '9100904020')).toThrow('invalid_trace');
  });

  it('triggers cloud /prepare, polls availability stages, and caches the ~250KB trace locally', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-trace-src-'));
    try {
      const traceStore = createTraceStore(createFileStore(dir));
      const stages = [];
      let polls = 0;
      const fetchImpl = vi.fn(async (url, init) => {
        const u = String(url);
        if (u.endsWith('/api/agent/9100904020/prepare') && init?.method === 'POST') {
          return new Response(JSON.stringify({ status: 'running', stage: 'downloading' }), { status: 202 });
        }
        if (u.endsWith('/api/agent/9100904020/trace')) {
          return new Response(traceGzBytes, { status: 200, headers: { 'Content-Type': 'application/gzip' } });
        }
        if (u.endsWith('/api/agent/9100904020')) {
          polls += 1;
          if (polls === 1) return new Response(JSON.stringify({ trace: false, can_parse: true, parse: { status: 'none' } }), { status: 200 });
          if (polls === 2) return new Response(JSON.stringify({ trace: false, can_parse: true, parse: { status: 'running', stage: 'extracting' } }), { status: 200 });
          return new Response(JSON.stringify({ trace: true, can_parse: true, parse: { status: 'none' } }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      });

      const pipeline = createDshTracePipeline({
        apiBase: 'https://dota2.ai',
        fetchImpl,
        traceStore,
        pollIntervalMs: 10,
      });
      const res = await pipeline.run('9100904020', { onStage: (s) => stages.push(s) });
      expect(res.ok).toBe(true);
      expect(stages).toEqual(['locating', 'downloading', 'extracting', 'storing']);
      expect((await traceStore.get('9100904020')).heroes).toHaveLength(10);

      // When the server already has an outdated trace (`trace: true, trace_outdated: true`), wait for the replacement
      // (`trace_outdated: false`) instead of downloading the stale trace on the first poll.
      let reparsePolls = 0;
      let traceDownloads = 0;
      const reparseFetch = vi.fn(async (url, init) => {
        const u = String(url);
        if (u.endsWith('/api/agent/9100904020/prepare') && init?.method === 'POST') {
          return new Response(JSON.stringify({ status: 'running', stage: 'downloading' }), { status: 202 });
        }
        if (u.endsWith('/api/agent/9100904020/trace')) {
          traceDownloads += 1;
          return new Response(traceGzBytes, { status: 200, headers: { 'Content-Type': 'application/gzip' } });
        }
        if (u.endsWith('/api/agent/9100904020')) {
          reparsePolls += 1;
          if (reparsePolls === 1) return new Response(JSON.stringify({ trace: true, trace_outdated: true, can_parse: true, parse: { status: 'none' } }), { status: 200 });
          if (reparsePolls === 2) return new Response(JSON.stringify({ trace: true, trace_outdated: true, can_parse: true, parse: { status: 'running', stage: 'extracting' } }), { status: 200 });
          return new Response(JSON.stringify({ trace: true, trace_outdated: false, can_parse: true, parse: { status: 'none' } }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      });
      const reparseStages = [];
      const reparseOut = await createDshTracePipeline({
        apiBase: 'https://dota2.ai',
        fetchImpl: reparseFetch,
        traceStore,
        pollIntervalMs: 10,
      }).run('9100904020', { onStage: (s) => reparseStages.push(s) });
      expect(reparseOut.ok).toBe(true);
      expect(reparsePolls).toBe(3);
      expect(traceDownloads).toBe(1);
      expect(reparseStages).toEqual(['locating', 'downloading', 'extracting', 'storing']);

      // Against a real `createAgentService` whose outdated trace fails reparsing after `/prepare` returned `running`,
      // `availability()` exposes `parse` so `createDshTracePipeline` falls back to the existing server trace without timing out.
      const serverTracesDir = mkdtempSync(join(tmpdir(), 'dsh-server-outdated-'));
      const clientTracesDir = mkdtempSync(join(tmpdir(), 'dsh-client-fallback-'));
      try {
        const outdatedObj = { ...JSON.parse(gunzipSync(traceGzBytes).toString('utf8')), builder_version: 0 };
        const outdatedGz = gzipSync(Buffer.from(JSON.stringify(outdatedObj), 'utf8'));
        const serverTraces = createTraceStore(createFileStore(serverTracesDir));
        await serverTraces.put('9100904020', outdatedGz);
        const serverAgent = createAgentService({
          traces: serverTraces,
          reparseOldTraces: true,
          getMatchDetail: async () => ({ ...scoreboard9100904020, start_time: Math.floor(Date.now() / 1000) - 3600 }),
          pipeline: {
            run: async (_id, { onStage }) => {
              onStage?.('downloading');
              await new Promise((r) => setTimeout(r, 25));
              return { ok: false, reason: 'download_failed' };
            },
          },
        });
        const realServerFetch = async (url, init) => {
          const u = String(url);
          if (u.endsWith('/api/agent/9100904020/prepare') && init?.method === 'POST') {
            const p = await serverAgent.prepare('9100904020');
            return new Response(JSON.stringify(p), { status: p.status === 'running' ? 202 : 200 });
          }
          if (u.endsWith('/api/agent/9100904020/trace')) {
            const raw = await serverAgent.traceRaw('9100904020');
            return new Response(raw, { status: 200, headers: { 'Content-Type': 'application/gzip' } });
          }
          if (u.endsWith('/api/agent/9100904020')) {
            return new Response(JSON.stringify(await serverAgent.availability('9100904020')), { status: 200 });
          }
          return new Response('not found', { status: 404 });
        };
        const clientTraces = createTraceStore(createFileStore(clientTracesDir));
        const fallbackOut = await createDshTracePipeline({
          apiBase: 'https://dota2.ai',
          fetchImpl: realServerFetch,
          traceStore: clientTraces,
          pollIntervalMs: 10,
          timeoutMs: 1000,
        }).run('9100904020');
        expect(fallbackOut.ok).toBe(true);
        expect((await clientTraces.get('9100904020')).heroes).toHaveLength(10);
        await serverAgent.shutdown();
      } finally {
        rmSync(serverTracesDir, { recursive: true, force: true });
        rmSync(clientTracesDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to downloading an existing outdated server trace when /prepare returns 429/503/500 or parse is final-failed, while preserving exact errors when no trace exists (#485)', async () => {
    const outdatedAvail = { trace: true, trace_outdated: true, can_parse: true, parse: { status: 'none' } };
    for (const [label, availBody, prepResp] of [
      ['prepare 429', outdatedAvail, () => new Response(JSON.stringify({ code: 'rate_limited', retryAfterSec: 120 }), { status: 429, headers: { 'Retry-After': '120' } })],
      ['prepare 503 busy', outdatedAvail, () => new Response(JSON.stringify({ code: 'busy', retryAfterSec: 3600 }), { status: 503, headers: { 'Retry-After': '3600' } })],
      ['prepare 500', outdatedAvail, () => new Response('internal error', { status: 500 })],
      ['avail final replay_gone', { trace: true, trace_outdated: true, can_parse: true, parse: { status: 'failed', final: true, reason: 'replay_gone' } }, null],
      ['avail backoff no_replay_url', { trace: true, trace_outdated: true, can_parse: true, parse: { status: 'failed', final: false, reason: 'no_replay_url', retry_in_sec: 45 } }, null],
      ['avail can_parse false', { trace: true, trace_outdated: true, can_parse: false, parse: { status: 'none' } }, null],
    ]) {
      const dir = mkdtempSync(join(tmpdir(), 'dsh-trace-fallback-485-'));
      try {
        const traceStore = createTraceStore(createFileStore(dir));
        let traceDownloads = 0;
        const fetchImpl = vi.fn(async (url, init) => {
          const u = String(url);
          if (u.endsWith('/api/agent/9100904020/trace')) {
            traceDownloads += 1;
            return new Response(traceGzBytes, { status: 200, headers: { 'Content-Type': 'application/gzip' } });
          }
          if (u.endsWith('/api/agent/9100904020/prepare') && init?.method === 'POST') {
            return prepResp ? prepResp() : new Response('unexpected prepare', { status: 500 });
          }
          if (u.endsWith('/api/agent/9100904020')) {
            return new Response(JSON.stringify(availBody), { status: 200 });
          }
          return new Response('not found', { status: 404 });
        });
        const out = await createDshTracePipeline({ apiBase: 'https://dota2.ai', fetchImpl, traceStore, pollIntervalMs: 5 }).run('9100904020');
        expect(out.ok, label).toBe(true);
        expect(traceDownloads, label).toBe(1);
        expect((await traceStore.get('9100904020')).heroes, label).toHaveLength(10);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // When a local trace ALREADY exists (`hadLocalTrace === true`), a refused/rate-limited reparse must report the failure
    // cleanly with exact reason & retry_in_sec instead of falsely claiming it upgraded by re-downloading the old trace.
    const existingDir = mkdtempSync(join(tmpdir(), 'dsh-trace-had-local-'));
    try {
      const traceStore = createTraceStore(createFileStore(existingDir));
      await traceStore.put('9100904020', traceGzBytes);
      let downloads = 0;
      const out429 = await createDshTracePipeline({
        apiBase: 'https://dota2.ai',
        traceStore,
        pollIntervalMs: 5,
        fetchImpl: async (url, init) => {
          if (String(url).endsWith('/trace')) { downloads += 1; return new Response(traceGzBytes, { status: 200 }); }
          if (init?.method === 'POST') return new Response(JSON.stringify({ code: 'rate_limited', retryAfterSec: 95 }), { status: 429, headers: { 'Retry-After': '95' } });
          return new Response(JSON.stringify(outdatedAvail), { status: 200 });
        },
      }).run('9100904020');
      expect(out429).toEqual({ ok: false, reason: 'rate_limited', retry_in_sec: 95 });
      expect(downloads).toBe(0);
    } finally {
      rmSync(existingDir, { recursive: true, force: true });
    }

    // When the server has NO trace, exact rate_limited / busy / no_replay_url / replay_gone reasons and retry_in_sec are preserved.
    const emptyDir = mkdtempSync(join(tmpdir(), 'dsh-trace-errors-485-'));
    try {
      const traceStore = createTraceStore(createFileStore(emptyDir));
      const noTraceAvail = { trace: false, can_parse: true, parse: { status: 'none' } };
      const runWith = (fetchImpl, extra = {}) => createDshTracePipeline({
        apiBase: 'https://dota2.ai',
        fetchImpl,
        traceStore,
        pollIntervalMs: 5,
        ...extra,
      }).run('9100904020');

      const rlPrep = await runWith(async (url, init) => (
        init?.method === 'POST'
          ? new Response(JSON.stringify({ code: 'rate_limited', retryAfterSec: 120 }), { status: 429, headers: { 'Retry-After': '120' } })
          : new Response(JSON.stringify(noTraceAvail), { status: 200 })
      ));
      expect(rlPrep).toEqual({ ok: false, reason: 'rate_limited', retry_in_sec: 120 });

      const busyPrep = await runWith(async (url, init) => (
        init?.method === 'POST'
          ? new Response(JSON.stringify({ code: 'busy', retryAfterSec: 600 }), { status: 503, headers: { 'Retry-After': '600' } })
          : new Response(JSON.stringify(noTraceAvail), { status: 200 })
      ));
      expect(busyPrep).toEqual({ ok: false, reason: 'busy', retry_in_sec: 600 });

      const noUrlPrep = await runWith(async (url, init) => (
        init?.method === 'POST'
          ? new Response(JSON.stringify({ status: 'failed', final: false, reason: 'no_replay_url', retry_in_sec: 42 }), { status: 200 })
          : new Response(JSON.stringify(noTraceAvail), { status: 200 })
      ));
      expect(noUrlPrep).toEqual({ ok: false, reason: 'no_replay_url', retry_in_sec: 42 });

      const goneAvail = await runWith(async () => new Response(JSON.stringify({
        trace: false, can_parse: true, parse: { status: 'failed', final: true, reason: 'replay_gone' },
      }), { status: 200 }));
      expect(goneAvail).toEqual({ ok: false, reason: 'replay_gone' });

      // Transient network errors and HTTP 502s during polling recover cleanly instead of aborting or spinning forever.
      let pollCount = 0;
      const recovered = await runWith(async (url, init) => {
        const u = String(url);
        if (init?.method === 'POST') return new Response(JSON.stringify({ status: 'running', stage: 'downloading' }), { status: 202 });
        if (u.endsWith('/trace')) return new Response(traceGzBytes, { status: 200 });
        pollCount += 1;
        if (pollCount === 1) return new Response(JSON.stringify(noTraceAvail), { status: 200 });
        if (pollCount === 2) throw new TypeError('fetch failed');
        if (pollCount === 3) return new Response('bad gateway', { status: 502 });
        return new Response(JSON.stringify({ trace: true, can_parse: true, parse: { status: 'none' } }), { status: 200 });
      }, { maxConsecutivePollErrors: 3 });
      expect(recovered.ok).toBe(true);

      // Persistent poll errors exit cleanly after maxConsecutivePollErrors with the real reason & retry_in_sec.
      const dir2 = mkdtempSync(join(tmpdir(), 'dsh-trace-poll-fail-'));
      try {
        let persistentPolls = 0;
        const persistentFail = await createDshTracePipeline({
          apiBase: 'https://dota2.ai',
          traceStore: createTraceStore(createFileStore(dir2)),
          pollIntervalMs: 5,
          maxConsecutivePollErrors: 2,
          fetchImpl: async (url, init) => {
            if (init?.method === 'POST') return new Response(JSON.stringify({ status: 'running', stage: 'downloading' }), { status: 202 });
            persistentPolls += 1;
            if (persistentPolls === 1) return new Response(JSON.stringify(noTraceAvail), { status: 200 });
            return new Response(JSON.stringify({ code: 'rate_limited', retryAfterSec: 33 }), { status: 429, headers: { 'Retry-After': '33' } });
          },
        }).run('9100904020');
        expect(persistentFail).toEqual({ ok: false, reason: 'rate_limited', retry_in_sec: 33 });
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('DSH local service end-to-end (service.js)', () => {
  const finding = {
    title: '咆哮',
    claim: '幻影刺客开了 7 次黑皇杖。',
    evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 吼进黑皇杖，定住 3.4 秒' }],
    fix: '留给她。',
  };
  const submit = {
    verdict: '咆哮没有留给幻影刺客。',
    opening_note: '这局 27:27 你顶着黑皇杖交出了很果断的一波大招，先肯定你的执行力。',
    highlights: [{ title: '27:27 隔着黑皇杖控住核心', detail: '27:27 吼进黑皇杖，定住 3.4 秒。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 吼进黑皇杖，定住 3.4 秒' }] }],
    chapters: [{ topic: 'teamfights', title: '团战表现：关键大招决定上限', assessment: 'mixed', analysis: '幻影刺客开了 7 次黑皇杖，27:27 那波大招控制 3.4 秒很果断。', takeaway: '把大招留给黑皇杖核心。', evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 吼进黑皇杖，定住 3.4 秒' }] }],
    mainline: [],
    findings: [finding],
    encouragement: '27:27 的果断操作已经很出色，继续把控大招目标就能更稳。',
    next_game: ['留咆哮'],
    blind_spots: ['视野'],
  };

  it('runs deep replay review, verification, evidence, moment, chat, patch advisor, and profile sync locally on DSH models', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-service-e2e-'));
    try {
      copyFileSync(traceFixturePath, join(dir, 'traces_seed.gz'));
      const llm = scriptedDshLlm((opts) => {
        const toolNames = (opts.tools ?? []).map((t) => t.name);
        const last = opts.messages.at(-1);
        // Deep review
        if (toolNames.includes('submit_review')) {
          if (last.role === 'user') {
            return {
              toolCalls: [
                { id: 'c1', name: 'ability_audit', args: { hero: 'beastmaster', ability: 'primal_roar' } },
                { id: 'c2', name: 'immunity_windows', args: { hero: 'phantom_assassin' } },
              ],
              usage: { inputTokens: 3000, cacheReadTokens: 0, outputTokens: 250 },
            };
          }
          return {
            toolCalls: [{ id: 'c3', name: 'submit_review', args: submit }],
            usage: { inputTokens: 1400, cacheReadTokens: 6600, outputTokens: 1100 },
          };
        }
        // Replay follow-up chat
        if (toolNames.includes('death_context')) {
          if (last.role === 'tool') return { text: '36:05 你满血 2915，被 斧王 先手。' };
          return { toolCalls: [{ id: 'd1', name: 'death_context', args: { hero: 'beastmaster', index: 9 } }] };
        }
        // Patch advisor
        if (toolNames.includes('hero_patch')) {
          if (last.role === 'tool') return { text: '兽王本版本在 7.42 有改动。' };
          return { toolCalls: [{ id: 'p1', name: 'hero_patch', args: { hero: 'beastmaster' } }] };
        }
        // Coach report follow-up
        return { text: '对线期少死一次即可。' };
      });

      const fetchImpl = vi.fn(async (url) => {
        const u = String(url);
        if (u.includes('/matches/9100904020')) {
          return new Response(JSON.stringify(scoreboard9100904020), { status: 200 });
        }
        if (u.endsWith('/api/coach/9091400302')) {
          return new Response(JSON.stringify(report), { status: 200 });
        }
        if (u.endsWith('/api/coach/9100904020')) {
          return new Response(JSON.stringify(buildCoachReport(scoreboard9100904020)), { status: 200 });
        }
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      });

      const svc = createDshService({
        ctx: {
          llm,
          agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
        },
        config: { homeDir: dir, apiBase: 'https://dota2.ai' },
        fetchImpl,
      });
      // Seed the trace into `$homeDir/traces`
      await createTraceStore(createFileStore(join(dir, 'traces'))).put('9100904020', traceGzBytes);

      // 1. Availability exposes DSH's configured models and model_meta
      const availRes = await svc.handleRequest({ method: 'GET', url: '/api/agent/9100904020' });
      expect(availRes.status).toBe(200);
      expect(availRes.body).toMatchObject({
        trace: true,
        model_configured: true,
        default_model: 'dsh.deepseek.deepseek-chat',
        models: ['dsh.deepseek.deepseek-chat', 'dsh.deepseek.deepseek-reasoner'],
        model_meta: {
          'dsh.deepseek.deepseek-chat': { label: 'DeepSeek V3 (DeepSeek)', minutes: null },
          'dsh.deepseek.deepseek-reasoner': { label: 'DeepSeek R1 (DeepSeek)', minutes: null },
        },
      });

      // 2. Local `replay.review` (chat tool) runs on DSH's host model and passes `verifyReview`
      const pick = await svc.replay.review({ match_id: 9100904020 });
      expect(pick.status).toBe('pick_hero');
      const started = await svc.replay.review({ match_id: 9100904020, hero: 'beastmaster', lang: 'zh' });
      expect(['reviewing', 'ready']).toContain(started.status);
      let readyTool;
      await vi.waitFor(async () => {
        readyTool = await svc.replay.review({ match_id: 9100904020, hero: 'beastmaster', lang: 'zh' });
        expect(readyTool.status).toBe('ready');
      }, { timeout: 5000 });
      expect(readyTool.verdict).toBe(submit.verdict);
      expect(readyTool.opening_note).toBe(submit.opening_note);
      expect(readyTool.highlights[0]).toMatchObject({ title: submit.highlights[0].title, evidence: [{ clock: '27:27', fact: finding.evidence[0].fact }] });
      expect(readyTool.chapters[0]).toMatchObject({ topic: 'teamfights', assessment: 'mixed', takeaway: '把大招留给黑皇杖核心。' });
      expect(readyTool.encouragement).toBe(submit.encouragement);
      expect(readyTool).not.toHaveProperty('goal');
      expect(readyTool.findings[0].evidence[0]).toEqual({ clock: '27:27', fact: finding.evidence[0].fact });
      expect(readyTool).toMatchObject({
        model: 'deepseek/deepseek-chat',
        steps: 2,
        tool_calls: 2,
        repair_rounds: 0,
        truncation_retries: 0,
        usage_source: 'provider_usage',
        usage: {
          input: 11_000,
          output: 1350,
          input_uncached: 4400,
          cache_read: 6600,
          cache_write: null,
          source: 'provider_usage',
        },
      });

      // Stored under model-qualified key `.m-dsh.deepseek.deepseek-chat.review.json`
      const reviewFiles = readdirSync(join(dir, 'reviews')).filter((f) => f.endsWith('.review.json'));
      expect(reviewFiles).toEqual([expect.stringMatching(/^9100904020\.beastmaster\.zh\.p\d+\.m-dsh\.deepseek\.deepseek-chat\.review\.json$/)]);

      // 3. Evidence & minimap moment work locally off the cached trace
      const ev = await svc.handleRequest({ method: 'GET', url: '/api/agent/9100904020/evidence?hero=beastmaster&lang=zh&ref=cast%3Abeastmaster%3Aprimal_roar%3A6' });
      expect(ev.status).toBe(200);
      expect(ev.body.record).toMatchObject({ clock: '27:27', target: 'phantom_assassin' });
      const mom = await svc.handleRequest({ method: 'GET', url: '/api/agent/9100904020/moment?hero=beastmaster&lang=zh&t=1825' });
      expect(mom.status).toBe(200);
      expect(mom.body.frames).toHaveLength(19);

      // 4. Streaming replay chat (`/api/agent/9100904020/chat`) yields live tool step + verified answer
      const chatFrames = [];
      for await (const f of svc.handleStream({
        url: '/api/agent/9100904020/chat',
        body: JSON.stringify({ hero: 'beastmaster', lang: 'zh', question: '36 分钟那次我怎么死的？' }),
      })) {
        chatFrames.push(f);
      }
      expect(chatFrames).toEqual([
        { step: { tool: 'death_context', args: { hero: 'beastmaster', index: 9 } } },
        { text: '36:05 你满血 2915，被 斧王 先手。' },
        { done: true },
      ]);

      // 4b. `coach.coach_ask` resolves numeric hero IDs (`38`) and Chinese names (`兽王`) to replay-backed chat
      for (const alias of [38, '38', '兽王']) {
        const askOut = await svc.coach.coach_ask({ match_id: 9100904020, hero: alias, lang: 'zh', question: '36 分钟那次我怎么死的？' });
        expect(askOut).toMatchObject({
          match_id: 9100904020,
          hero: 'beastmaster',
          source: 'replay',
          answer: '36:05 你满血 2915，被 斧王 先手。',
        });
      }

      // 4c. Long provider/model names persist reviews and feedback cleanly across restarts
      const longProvider = 'openrouter-enterprise-gateway';
      const longModel = 'anthropic/claude-3.7-sonnet-thinking:beta-custom-deployment-route-2026-11';
      const longSvc = createDshService({
        ctx: {
          llm: scriptedDshLlm(
            (opts) => (opts.messages.at(-1).role === 'user'
              ? { toolCalls: [{ id: 'l1', name: 'ability_audit', args: { hero: 'beastmaster', ability: 'primal_roar' } }, { id: 'l2', name: 'immunity_windows', args: { hero: 'phantom_assassin' } }] }
              : { toolCalls: [{ id: 'l3', name: 'submit_review', args: submit }] }),
            { providers: [{ id: longProvider, name: 'OpenRouter' }], modelsByProvider: { [longProvider]: [{ id: longModel, name: 'Claude Sonnet Long' }] } },
          ),
          agentDefaultModel: { currentSelection: () => ({ provider: longProvider, model: longModel }) },
        },
        config: { homeDir: dir, apiBase: 'https://dota2.ai' },
        fetchImpl,
      });
      await longSvc.replay.review({ match_id: 9100904020, hero: 'beastmaster', lang: 'zh' });
      let readyLong;
      await vi.waitFor(async () => {
        readyLong = await longSvc.handleRequest({ method: 'GET', url: '/api/agent/9100904020/review?hero=beastmaster&lang=zh' });
        expect(readyLong.body.status).toBe('ready');
      }, { timeout: 5000 });
      // The tool's answer for a finished review: where to read it in DSH, never the public page (which has not got it).
      const toolReady = await longSvc.replay.review({ match_id: 9100904020, hero: 'beastmaster', lang: 'zh' });
      expect(toolReady).toMatchObject({ status: 'ready', match_id: '9100904020', hero: 'beastmaster', lang: 'zh', panel_route: '/r/9100904020?hero=beastmaster&lang=zh' });
      expect(toolReady).not.toHaveProperty('url');
      expect(JSON.stringify(toolReady)).not.toContain('https://dota2.ai/r/');
      expect(toolReady.note).toContain('kept on this machine');
      const fbRes = await longSvc.handleRequest({
        method: 'POST',
        url: '/api/agent/9100904020/feedback',
        body: JSON.stringify({
          hero: 'beastmaster',
          lang: 'zh',
          version: readyLong.body.prompt_version,
          finding: 0,
          title: finding.title,
          rating: 'right',
          id: 'abcdefghij123456',
        }),
      });
      expect(fbRes.status).toBe(200);
      // Replay chat with that bounded long-model ID also succeeds (never truncated into invalid_model).
      const longModelKey = encodeModelKey(longProvider, longModel);
      const longChatFrames = [];
      for await (const f of longSvc.handleStream({
        url: '/api/agent/9100904020/chat',
        body: JSON.stringify({ hero: 'beastmaster', lang: 'zh', model: longModelKey, question: '36 分钟那次我怎么死的？' }),
      })) {
        longChatFrames.push(f);
      }
      expect(longChatFrames.some((f) => f.error === 'invalid_model')).toBe(false);
      longSvc.shutdown();
      // A fresh service instance with an uncallable LLM still serves the persisted review from disk.
      const reloadedSvc = createDshService({
        ctx: {
          llm: scriptedDshLlm(() => { throw new Error('should not call LLM'); }, { providers: [{ id: longProvider, name: 'OpenRouter' }], modelsByProvider: { [longProvider]: [{ id: longModel, name: 'Claude Sonnet Long' }] } }),
          agentDefaultModel: { currentSelection: () => ({ provider: longProvider, model: longModel }) },
        },
        config: { homeDir: dir, apiBase: 'https://dota2.ai' },
        fetchImpl,
      });
      expect((await reloadedSvc.handleRequest({ method: 'GET', url: '/api/agent/9100904020/review?hero=beastmaster&lang=zh' })).body.status).toBe('ready');
      reloadedSvc.shutdown();

      // 5. Patch overview & streaming patch advisor work locally
      const patchRes = await svc.handleRequest({ method: 'GET', url: '/api/patch?lang=zh' });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.advisor).toBe(true);
      const patchFrames = [];
      for await (const f of svc.handleStream({
        url: '/api/patch/chat',
        body: JSON.stringify({ lang: 'zh', question: '兽王改了什么？' }),
      })) {
        patchFrames.push(f);
      }
      expect(patchFrames[0]).toMatchObject({ step: { tool: 'hero_patch', args: { hero: 'beastmaster' } } });
      expect(patchFrames.at(-1)).toEqual({ done: true });

      // 6. Profile sync & `goal_check` reading saved goal
      const saved = await svc.saveProfile({
        accountId: '86745912',
        reviewed: ['9100904020'],
        goal: { id: 'g1', goal: { kind: 'deaths_per10_max', max: 3 } },
      });
      expect(saved.accountId).toBe('86745912');
      expect(await svc.getProfile()).toMatchObject({ accountId: '86745912', reviewed: ['9100904020'] });
      const goalChecked = await svc.coach.goal_check({ match_id: 9091400302, hero: report.players[0].hero.slug, goal: {} });
      expect(['met', 'missed', 'no_opportunity', 'unknown']).toContain(goalChecked.result);

      // Saved `replay_habit` goals resolve their replay summary (`deaths:beastmaster`) from the cached trace.
      await svc.saveProfile({
        goal: {
          id: 'habit-1',
          goal: { kind: 'replay_habit', habit: 'nothing_pressed', max: 2, baseline: 4 },
        },
      });
      const habitChecked = await svc.coach.goal_check({ match_id: 9100904020, hero: 'beastmaster', goal: {} });
      expect(habitChecked.result).toBe('met');
      expect(habitChecked.count).toBe(0);

      // Synthesized match fallback preserves `report.timeline.radiant_gold_adv`, `isRadiant` team partitions, and core/support roles.
      const synth = synthesizeMatchFromCoachReport(report);
      expect(Array.isArray(synth.radiant_gold_adv)).toBe(true);
      expect(synth.radiant_gold_adv).toEqual(report.timeline.radiant_gold_adv);
      const rebuilt = buildCoachReport(synth);
      expect(rebuilt.players.map((p) => p.radiant)).toEqual(report.players.map((p) => p.radiant));
      expect(rebuilt.reviews.map((r) => r.role.kind)).toEqual(report.reviews.map((r) => r.role.kind));
      expect(rebuilt.reviews.map((r) => r.bracket?.key ?? null)).toEqual(report.reviews.map((r) => r.bracket?.key ?? null));

      svc.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves data home from config.homeDir or $DSH_HOME/dota2ai', () => {
    expect(resolveDataHome({ homeDir: '/custom/dir' }, { DSH_HOME: '/ignored' })).toBe('/custom/dir');
    expect(resolveDataHome({}, { DSH_HOME: '/tmp/dsh-test' })).toBe('/tmp/dsh-test/dota2ai');
  });

  it('reuses older-version local reviews across prompt bumps with cache_scope=dsh_local and regenerates only on explicit refresh (#486)', async () => {
    const { DEEP_REVIEW_PROMPT_VERSION, DEEP_REVIEW_SCHEMA } = await import('../../../lib/agent/deepReview.js');
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cache-reuse-'));
    try {
      await createTraceStore(createFileStore(join(dir, 'traces'))).put('9100904020', traceGzBytes);
      const oldV = DEEP_REVIEW_PROMPT_VERSION - 2;
      const modelKey = encodeModelKey('deepseek', 'deepseek-chat');
      const reviewDocs = (await import('../../../lib/agent/stores.js')).createJsonStore(createFileStore(join(dir, 'reviews')));
      await reviewDocs.put(`9100904020.beastmaster.zh.p${oldV}.m-${modelKey}.review.json`, {
        schema: 'dota2.ai/deep-review-bundle@1',
        model: 'deepseek/deepseek-chat',
        tool_calls: 2,
        verification: { repaired: false, dropped: 0 },
        review: {
          schema: DEEP_REVIEW_SCHEMA,
          match_id: 9100904020,
          hero: 'beastmaster',
          lang: 'zh',
          verdict: '本机旧版缓存结论。',
          mainline: [],
          findings: [finding],
          blind_spots: ['视野'],
        },
      });

      const llm = scriptedDshLlm((opts) => {
        const last = opts.messages.at(-1);
        if (last.role === 'user') {
          return {
            toolCalls: [
              { id: 'c1', name: 'ability_audit', args: { hero: 'beastmaster', ability: 'primal_roar' } },
              { id: 'c2', name: 'immunity_windows', args: { hero: 'phantom_assassin' } },
            ],
          };
        }
        return { toolCalls: [{ id: 'c3', name: 'submit_review', args: { ...submit, verdict: '本机最新版结论。' } }] };
      });
      const fetchImpl = vi.fn(async () => new Response('should not fetch trace or match on cache hit', { status: 500 }));
      const svc = createDshService({
        ctx: {
          llm,
          agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
        },
        config: { homeDir: dir, apiBase: 'https://dota2.ai' },
        fetchImpl,
      });

      // 1. Default replay.review hits local older-version cache with ZERO LLM calls and ZERO network calls.
      const toolCached = await svc.replay.review({ match_id: 9100904020, hero: 'beastmaster', lang: 'zh' });
      expect(toolCached).toMatchObject({
        status: 'ready',
        cached: true,
        stale_version: true,
        prompt_version: oldV,
        latest_prompt_version: DEEP_REVIEW_PROMPT_VERSION,
        cache_scope: 'dsh_local',
        panel_route: '/r/9100904020?hero=beastmaster&lang=zh',
        verdict: '本机旧版缓存结论。',
      });
      expect(toolCached).not.toHaveProperty('url');
      expect(toolCached.note).toContain('kept on this machine');
      expect(toolCached.note).toContain('separate from the public dota2.ai web cache');
      expect(toolCached.note).toContain('refresh: true');
      expect(llm.calls).toHaveLength(0);
      expect(fetchImpl).not.toHaveBeenCalled();

      // 2. HTTP GET & POST (without refresh) also reuse the local cache without calling LLM; other lang/model stay isolated.
      const getCached = await svc.handleRequest({ method: 'GET', url: '/api/agent/9100904020/review?hero=beastmaster&lang=zh' });
      expect(getCached.body).toMatchObject({ status: 'ready', prompt_version: oldV, stale_version: true, latest_prompt_version: DEEP_REVIEW_PROMPT_VERSION });
      const postCached = await svc.handleRequest({ method: 'POST', url: '/api/agent/9100904020/review', body: JSON.stringify({ hero: 'beastmaster', lang: 'zh' }) });
      expect(postCached.status).toBe(200);
      expect(postCached.body).toMatchObject({ status: 'ready', prompt_version: oldV, stale_version: true });
      expect((await svc.handleRequest({ method: 'GET', url: '/api/agent/9100904020/review?hero=beastmaster&lang=en' })).body).toEqual({ status: 'none' });
      expect((await svc.handleRequest({ method: 'GET', url: `/api/agent/9100904020/review?hero=beastmaster&lang=zh&model=${encodeModelKey('deepseek', 'deepseek-reasoner')}` })).body).toEqual({ status: 'none' });
      expect(llm.calls).toHaveLength(0);

      // 3. Explicit refresh: true regenerates locally under DEEP_REVIEW_PROMPT_VERSION.
      const started = await svc.replay.review({ match_id: 9100904020, hero: 'beastmaster', lang: 'zh', refresh: true });
      expect(['reviewing', 'ready']).toContain(started.status);
      let fresh;
      await vi.waitFor(async () => {
        fresh = await svc.replay.review({ match_id: 9100904020, hero: 'beastmaster', lang: 'zh' });
        expect(fresh.status).toBe('ready');
        expect(fresh.stale_version).toBeUndefined();
      }, { timeout: 5000 });
      expect(fresh.verdict).toBe('本机最新版结论。');
      expect(fresh.cache_scope).toBe('dsh_local');
      expect(llm.calls.length).toBeGreaterThan(0);

      svc.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back cleanly when OpenDota stalls/fails, guides unparsed coach_cases to dota2ai_replay_review, and keeps hero/URL/surface parity (#485)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-parity-485-'));
    const unparsedMatch = JSON.parse(readFileSync(new URL('../../../src/fixtures/coach/match9091400302.unparsed.json', import.meta.url), 'utf8'));
    const unparsedReport = buildCoachReport(unparsedMatch);
    try {
      let openDotaCalls = 0;
      let coachReportCalls = 0;
      let remoteAvail = { trace: true, can_parse: true, parse: { status: 'none' } };
      const llm = scriptedDshLlm((opts) => {
        const last = opts.messages.at(-1);
        if (last.role === 'user') {
          return {
            toolCalls: [
              { id: 'c1', name: 'ability_audit', args: { hero: 'beastmaster', ability: 'primal_roar' } },
              { id: 'c2', name: 'immunity_windows', args: { hero: 'phantom_assassin' } },
            ],
          };
        }
        return { toolCalls: [{ id: 'c3', name: 'submit_review', args: submit }] };
      });
      const fetchImpl = vi.fn(async (url, init) => {
        const u = String(url);
        if (u.includes('api.opendota.com/api/matches/')) {
          openDotaCalls += 1;
          // Simulate CN firewall blackhole / timeout on OpenDota.
          return await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new DOMException('Timed out', 'TimeoutError')), { once: true });
          });
        }
        if (u.endsWith('/api/coach/9091400302')) {
          coachReportCalls += 1;
          return new Response(JSON.stringify(unparsedReport), { status: 200 });
        }
        if (u.endsWith('/api/coach/9100904020')) {
          coachReportCalls += 1;
          return new Response(JSON.stringify(buildCoachReport(scoreboard9100904020)), { status: 200 });
        }
        if (u.endsWith('/api/agent/9091400302')) {
          if (remoteAvail === null) return new Response('unavailable', { status: 503 });
          return new Response(JSON.stringify(remoteAvail), { status: 200 });
        }
        if (u.endsWith('/api/agent/9100904020')) {
          return new Response(JSON.stringify({ trace: true, can_parse: true, parse: { status: 'none' } }), { status: 200 });
        }
        if (u.endsWith('/api/agent/9100904020/trace')) {
          return new Response(traceGzBytes, { status: 200, headers: { 'Content-Type': 'application/gzip' } });
        }
        if (u.endsWith('/api/agent/7777777')) {
          return new Response(JSON.stringify({ trace: false, can_parse: true, parse: { status: 'failed', final: true, reason: 'replay_gone' } }), { status: 200 });
        }
        if (u.endsWith('/api/agent/8888888')) {
          return new Response(JSON.stringify({ trace: false, can_parse: true, parse: { status: 'running', stage: 'extracting' } }), { status: 200 });
        }
        if (u.endsWith('/api/agent/6666666')) {
          return new Response(JSON.stringify({ trace: false, can_parse: true, parse: { status: 'failed', final: false, reason: 'no_replay_url', retry_in_sec: 48 } }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      });

      const svc = createDshService({
        ctx: {
          llm,
          agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
        },
        config: { homeDir: dir, apiBase: 'https://dota2.ai' },
        fetchImpl,
        openDotaTimeoutMs: 40,
        openDotaCooldownMs: 60_000,
        prepareGraceMs: 120,
      });

      // 1. Unparsed match `dota2ai_coach_cases` returns structured `no_parsed_match` guidance pointing to `dota2ai_replay_review`
      //    and detects that `dota2.ai` already has the replay trace (`replay_trace_available: true`). Also accepts URL + CN alias (`潮汐`)!
      const casesWithTrace = await svc.coach.coach_cases({
        match_id: 'https://dota2.ai/r/9091400302?lang=zh',
        hero: '潮汐',
        lang: 'zh',
      });
      expect(casesWithTrace).toMatchObject({
        status: 'no_parsed_match',
        reason: 'needs_parse',
        surface: 'native_dsh',
        match_id: '9091400302',
        hero: 'tidehunter',
        match_parsed: false,
        basic_report_available: true,
        replay_trace_available: true,
        replay_review_available: true,
        next_tool: 'dota2ai_replay_review',
      });
      expect(casesWithTrace.message).toContain('dota2ai_replay_review');

      // When dota2.ai does not have the trace yet, replay_trace_available is false while replay_review_available stays true.
      remoteAvail = { trace: false, can_parse: true, parse: { status: 'none' } };
      const casesNoTrace = await svc.coach.coach_cases({ match_id: '  9091400302  ', hero: '幽鬼' });
      expect(casesNoTrace).toMatchObject({
        status: 'no_parsed_match',
        surface: 'native_dsh',
        replay_trace_available: false,
        replay_review_available: true,
        next_tool: 'dota2ai_replay_review',
      });

      // When the availability probe cannot be reached, replay_trace_available stays null (unknown is never coerced to false).
      remoteAvail = null;
      const casesUnknownTrace = await svc.coach.coach_cases({ match_id: '9091400302', hero: '潮汐' });
      expect(casesUnknownTrace).toMatchObject({
        status: 'no_parsed_match',
        surface: 'native_dsh',
        replay_trace_available: null,
        replay_review_available: true,
        next_tool: 'dota2ai_replay_review',
      });

      // `dota2ai_coach_report` on an unparsed match surfaces `report_scope: 'basic_scoreboard_only'` and `data_gaps`.
      const basicWhy = await svc.coach.coach_report({ match_id: '#9091400302', hero: '拍拍熊', section: 'why' });
      expect(basicWhy).toMatchObject({
        section: 'why',
        surface: 'native_dsh',
        report_scope: 'basic_scoreboard_only',
        parsed: false,
        next_tool: 'dota2ai_replay_review',
      });
      expect(basicWhy.data_gaps.length).toBeGreaterThan(0);

      // 2. Cold `dota2ai_replay_review` downloads the server's ready trace inside the grace window and immediately starts reviewing
      //    (accepting full dota2.ai URL + CN alias `PA` / `兽王`), while OpenDota timeout cools down after 1 attempt instead of stalling repeatedly!
      const firstCall = await svc.replay.review({
        match_id: 'https://dota2.ai/r/9100904020?hero=beastmaster&lang=zh',
        hero: '兽王',
        lang: 'zh',
      });
      expect(['reviewing', 'ready']).toContain(firstCall.status);
      expect(firstCall.surface).toBe('native_dsh');
      await vi.waitFor(async () => {
        const done = await svc.replay.review({ match_id: 9100904020, hero: '兽王', lang: 'zh' });
        expect(done.status).toBe('ready');
        expect(done.surface).toBe('native_dsh');
        expect(done.cache_scope).toBe('dsh_local');
      }, { timeout: 5000 });
      // OpenDota timed out at most once and entered cooldown; subsequent calls went straight to apiBase.
      expect(openDotaCalls).toBeLessThanOrEqual(1);
      expect(coachReportCalls).toBeGreaterThan(0);

      // 3. Distinct failure/progress diagnostics on `dota2ai_replay_review`:
      //    - replay_gone settles immediately as `replay_unavailable`
      const goneOut = await svc.replay.review({ match_id: 7777777, hero: '小鹿' });
      expect(goneOut).toMatchObject({
        status: 'replay_unavailable',
        surface: 'native_dsh',
        stage: 'parse',
        reason: 'replay_gone',
        retryable: false,
      });
      expect(goneOut.message).toContain('dota2ai_coach_report');

      //    - non-final no_replay_url settles immediately as `failed` with exact `retry_in_sec`
      const notReadyOut = await svc.replay.review({ match_id: 6666666, hero: '骷髅王' });
      expect(notReadyOut).toMatchObject({
        status: 'failed',
        surface: 'native_dsh',
        stage: 'parse',
        reason: 'no_replay_url',
        retryable: true,
      });
      expect(notReadyOut.retry_in_sec).toBeGreaterThan(0);
      expect(notReadyOut.message).toContain('dota2ai_replay_review');

      //    - genuinely running remote parse reports `parsing` with real remote `stage: 'extracting'`
      const runningOut = await svc.replay.review({ match_id: 8888888, hero: '蓝猫' });
      expect(runningOut).toMatchObject({
        status: 'parsing',
        surface: 'native_dsh',
        stage: 'extracting',
        poll_after_sec: 20,
      });

      //    - hero_matchup resolves Chinese aliases (`小鹿` vs `蓝猫`, `骷髅王` vs `沙王`)
      const mu = await svc.coach.hero_matchup({ hero: '小鹿', vs: '蓝猫' });
      expect(mu.hero.id).toBe(58);
      expect(mu.vs.id).toBe(17);

      //    - missing DSH model reports `unavailable` with DSH-specific wording (never blaming "this server")
      const noModelSvc = createDshService({
        ctx: { llm: { listProviders: () => [], listModels: async () => [] } },
        config: { homeDir: dir, apiBase: 'https://dota2.ai' },
        fetchImpl,
      });
      const noModel = await noModelSvc.replay.review({ match_id: 9100904020, hero: 'PA', lang: 'zh' });
      expect(noModel).toMatchObject({
        status: 'unavailable',
        surface: 'native_dsh',
        stage: 'review',
        reason: 'model_not_configured',
      });
      expect(noModel.message).toContain('DSH');
      expect(noModel.message).not.toContain('this server');
      noModelSvc.shutdown();

      svc.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('skill', () => {
  it('registers SKILL.md without its frontmatter, covers active tools & full-dimension coaching, and omits mechanical goal guidance', () => {
    const rawSkillMd = readFileSync(new URL('../skills/dota2ai/SKILL.md', import.meta.url), 'utf8');
    const reg = skillRegistration();
    expect(reg.name).toBe(SKILL.name);
    expect(reg.source).toBe('runtime');
    expect(reg.content.startsWith('# dota2.ai coach')).toBe(true);
    // `dota2ai_goal_check` stays registered in `TOOL_NAMES` for RPC/legacy compatibility,
    // but SKILL.md intentionally stops pitching mechanical next-game goal checks.
    for (const name of TOOL_NAMES.filter((n) => n !== 'dota2ai_goal_check')) {
      expect(reg.content, name).toContain(name);
    }
    for (const field of ['opening_note', 'highlights', 'chapters', 'encouragement']) {
      expect(reg.content, field).toContain(field);
    }
    expect(rawSkillMd).not.toContain('dota2ai_goal_check');
    expect(rawSkillMd).not.toContain('Did I do what I practised?');
    expect(rawSkillMd).not.toContain('a next-game goal');
    expect(reg.content).not.toContain('dota2ai_goal_check');
    expect(reg.content).not.toContain('Did I do what I practised?');
    expect(SKILL.description).not.toContain('next-game goal');
    expect(skillBody('---\nname: x\n---\n\n# Body\n')).toBe('# Body\n');
    expect(skillBody('# No frontmatter\n')).toBe('# No frontmatter\n');
  });

  it('marks requests internal only when asked', () => {
    expect(headersFor({ DOTA2AI_INTERNAL: '1' })).toEqual({ 'X-Dota2ai-Internal': '1' });
    expect(headersFor({})).toEqual({});
  });
});

describe('bundle', () => {
  it('builds host, Typert descriptors, and browser client bundles with only host-supplied externals', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-dota2ai-build-'));
    try {
      const out = await buildPlugin({ outfile: join(dir, 'index.js') });
      const code = readFileSync(out, 'utf8');
      const bare = [...code.matchAll(/^import [^;]*? from "([^".][^"]*)";$/gm)].map((m) => m[1]).filter((s) => !s.startsWith('node:'));
      expect([...new Set(bare)].sort()).toEqual([
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-tools',
        '@deepseek-ai/dsh-typert-protocol',
        '@deepseek-ai/schemastery',
      ]);
      expect(code).not.toMatch(/from "dota2ai\//);
      expect(code).not.toMatch(/createRequire\(import\.meta\.url\)\(['"][^'"]+\.json['"]\)/);
      // Host entry delegates manifest registration to `@deepseek-ai/dsh-typert-loader` via `./typert` (never manual `typert.register`).
      expect(code).not.toMatch(/\.typert\.register\s*\(/);

      // Typert reflection artifacts exist, bundle zod + RemoteInfo internally with zero runtime externals,
      // and carry every required array (`schemas`, `services[].types`, `services[].members`, `services[].tags`, `events`, `objects`).
      expect(TYPERT.model.services[0].types).toEqual([]);
      expect(TYPERT.model.services[0].members).toEqual([]);
      expect(TYPERT.invocations.map((d) => d.id)).toEqual(TYPERT_REMOTE.descriptors.map((d) => d.id));
      for (const name of ['typert.host.js', 'typert.remote-client.js']) {
        const p = join(dir, name);
        expect(existsSync(p), name).toBe(true);
        const tCode = readFileSync(p, 'utf8');
        const tBare = [...tCode.matchAll(/^import [^;]*? from "([^".][^"]*)";$/gm)].map((m) => m[1]);
        expect([...new Set(tBare)]).toEqual([]);
      }
      const builtHostTypert = await import(new URL(`file://${join(dir, 'typert.host.js')}`).href);
      expect(builtHostTypert.TYPERT.model.services[0].types).toEqual([]);
      expect(builtHostTypert.TYPERT.invocations.map((d) => d.id)).toEqual([
        '@qianhaoq/dsh-dota2ai#dota2ai/request',
        '@qianhaoq/dsh-dota2ai#dota2ai/stream',
        '@qianhaoq/dsh-dota2ai#dota2ai/getProfile',
        '@qianhaoq/dsh-dota2ai#dota2ai/saveProfile',
      ]);

      // Browser client bundle wraps @qianhaoq/dsh-dota2ai for DSH's __ModuleLoader__.
      const clientPath = join(dir, 'client.js');
      expect(existsSync(clientPath)).toBe(true);
      const clientCode = readFileSync(clientPath, 'utf8');
      expect(clientCode.startsWith('window.__ModuleLoader__.load({ id: "@qianhaoq/dsh-dota2ai", factory: (require) => {')).toBe(true);
      expect(clientCode.trimEnd().endsWith('return module.exports; } });')).toBe(true);
      const clientReqs = [...new Set([...clientCode.matchAll(/\brequire\("([^"]+)"\)/g)].map((m) => m[1]))].sort();
      const allowedClientReqs = new Set(['@deepseek-ai/dsh-client-store', 'react', 'react-dom', 'react/jsx-runtime']);
      expect(clientReqs.length).toBeGreaterThanOrEqual(3);
      for (const req of clientReqs) {
        expect(allowedClientReqs.has(req), `unexpected client require: ${req}`).toBe(true);
      }

      // Release manifest strips `private` / `devDependencies` / `scripts` for public npm & market indexing.
      const rawPkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      const pubPkg = releaseManifest(rawPkg);
      expect(pubPkg.private).toBeUndefined();
      expect(pubPkg.devDependencies).toBeUndefined();
      expect(pubPkg.scripts).toBeUndefined();
      expect(pubPkg.publishConfig).toEqual({ access: 'public' });
      expect(pubPkg.icon).toBe('./icon.svg');
      expect(pubPkg.dsh?.manifestVersion).toBe(1);
      expect(pubPkg.dsh?.bundle).toEqual({ patch: './cordis.patch.yml' });
      expect(pubPkg.engines?.dsh).toBe('>=0.2.1-rc.3 <0.3.0-0');
      expect(pubPkg.repository).toEqual({
        type: 'git',
        url: 'git+https://github.com/qianhaoq/dota2.ai.git',
        directory: 'packages/dsh',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
