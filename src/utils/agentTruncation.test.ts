import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { openAiCompatible, runAgent } from '../../lib/agent/loop.js';
import { runDeepReview } from '../../lib/agent/deepReview.js';
import { createAgentService } from '../../lib/agent/service.js';
import { createDshComplete, DEFAULT_MAX_TOKENS } from '../../packages/dsh/src/llm.js';

const fixture = gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url)));
const trace = () => JSON.parse(fixture.toString());
const ID = 9100904020;

const call = (name: string, args: any, id: string) => ({ id, name, args });
const finding = {
  title: 'Roar',
  claim: 'PA used BKB 7 times.',
  evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 roared into BKB for 3.4s' }],
  fix: 'Hold Roar for PA.',
};
const submit = { verdict: 'Hold Roar for PA.', mainline: [], findings: [finding], next_game: ['Hold Roar'], blind_spots: ['Vision'] };

describe('DSH and OpenAI max-tokens truncation detection', () => {
  it('defaults DSH maxTokens to 32768 and marks finish.kind === max-tokens as truncated', async () => {
    expect(DEFAULT_MAX_TOKENS).toBe(32_768);
    let seenConfig: any = null;
    const ctx = {
      llm: {
        stream: async function* (opts: any) {
          seenConfig = opts;
          yield { type: 'reasoning-delta', index: 0, text: 'long thinking...' };
          yield { type: 'text-delta', index: 1, text: 'partial prose' };
          yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 32768 } };
          yield { type: 'finish', reason: { kind: 'max-tokens' } };
        },
      },
    };
    const complete: any = createDshComplete({ ctx, route: { provider: 'deepseek', model: 'deepseek-flash' } });
    const reply = await complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(seenConfig.maxTokens).toBe(32_768);
    expect(reply).toMatchObject({ text: 'partial prose', reasoning: 'long thinking...', truncated: true, toolCalls: [], usage: { input: 1000, output: 32768 } });
  });

  it('openAiCompatible marks finish_reason === length as truncated', async () => {
    const complete = openAiCompatible({
      client: {
        chat: {
          completions: {
            create: async () => ({
              choices: [{ finish_reason: 'length', message: { content: 'cut off' } }],
              usage: { prompt_tokens: 100, completion_tokens: 16384 },
            }),
          },
        },
      },
      model: 'deepseek-flash',
    });
    const reply = await complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(reply).toMatchObject({ text: 'cut off', truncated: true, toolCalls: [] });
  });
});

describe('runAgent in-place truncation retry', () => {
  it('retries once in-place on max-tokens truncation and succeeds when the retry calls a tool', async () => {
    const seenMessages: any[] = [];
    const events: any[] = [];
    let turn = 0;
    const res = await runAgent({
      complete: async (o: any) => {
        seenMessages.push(o.messages);
        turn += 1;
        if (turn === 1) return { text: 'cut off...', truncated: true, toolCalls: [], usage: { input: 100, output: 16000 } };
        return { text: '', toolCalls: [call('submit_review', submit, 's1')], usage: { input: 120, output: 500 } };
      },
      system: 'sys',
      messages: [{ role: 'user', content: 'review' }],
      tools: [{ name: 'submit_review', description: 'submit', input_schema: { type: 'object' } }],
      runTool: () => ({}),
      isFinal: (c) => c.name === 'submit_review',
      onEvent: (e) => events.push(e),
    });
    expect(res.status).toBe('final');
    expect(res.steps).toBe(2);
    expect(events).toEqual([{ type: 'truncated_retry', step: 1, attempt: 1 }]);
    expect(seenMessages[1].at(-1).content).toContain('output token limit');
  });

  it('returns status truncated (not answered) if retry also hits output cap', async () => {
    const res = await runAgent({
      complete: async () => ({ text: 'still cut off', truncated: true, toolCalls: [], usage: { input: 100, output: 16000 } }),
      system: 'sys',
      messages: [{ role: 'user', content: 'review' }],
      tools: [{ name: 'submit_review', description: 'submit', input_schema: { type: 'object' } }],
      runTool: () => ({}),
      isFinal: (c) => c.name === 'submit_review',
    });
    expect(res.status).toBe('truncated');
    expect(res.steps).toBe(2);
    expect(res.text).toBe('still cut off');
  });

  it('applies bounded truncation recovery when output cap cuts off tool-call JSON (argsError)', async () => {
    const events: any[] = [];
    const res = await runAgent({
      complete: async () => ({
        text: '',
        truncated: true,
        toolCalls: [{ id: 'c1', name: 'submit_review', args: {}, argsError: true }],
        usage: { input: 100, output: 16384 },
      }),
      system: 'sys',
      messages: [{ role: 'user', content: 'review' }],
      tools: [{ name: 'submit_review', description: 'submit', input_schema: { type: 'object' } }],
      runTool: () => ({}),
      isFinal: (c) => c.name === 'submit_review',
      onEvent: (e) => events.push(e),
    });
    expect(res.status).toBe('truncated');
    expect(res.steps).toBe(2);
    expect(events).toEqual([{ type: 'truncated_retry', step: 1, attempt: 1 }]);
  });
});

describe('runDeepReview and createAgentService failure diagnostics & checkpoint archiving', () => {
  it('maps repeated truncation to output_cap and archives the failed checkpoint while clearing the live checkpoint', async () => {
    const blobs = new Map<string, any>();
    const docs = {
      get: async (k: string) => blobs.get(k) ?? null,
      put: async (k: string, v: any) => { blobs.set(k, v); },
      delete: async (k: string) => { blobs.delete(k); },
    };
    const logs: string[] = [];
    let turn = 0;
    const svc: any = createAgentService({
      traces: { get: async () => trace() },
      docs,
      model: 'dsh/deepseek-flash',
      log: (m: string) => logs.push(m),
      complete: async () => {
        turn += 1;
        if (turn === 1) return { toolCalls: [call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'c1')], usage: { input: 500, output: 200 } };
        return { text: 'truncated prose snippet', truncated: true, toolCalls: [], usage: { input: 1000, output: 32768 } };
      },
    });
    const out = await svc.run({ kind: 'review', matchId: String(ID), hero: 'beastmaster', lang: 'en' });
    expect(out).toEqual({ status: 'failed', reason: 'output_cap' });

    // Live checkpoint is dropped so retries start fresh, while .failed.json preserves the full conversation.
    const cpKey = [...blobs.keys()].find((k) => k.endsWith('.checkpoint.json'));
    expect(cpKey).toBeUndefined();
    const failedKey = [...blobs.keys()].find((k) => k.endsWith('.failed.json'));
    expect(failedKey).toBeDefined();
    expect(blobs.get(failedKey!)).toMatchObject({
      reason: 'output_cap',
      detail: 'truncated prose snippet',
      usage: { input: 2500, output: 65736 },
    });

    const jobKey = [...blobs.keys()].find((k) => k.endsWith('.job.json'))!;
    expect(blobs.get(jobKey)).toMatchObject({
      state: 'failed',
      reason: 'output_cap',
      steps: 3,
      usage: { input: 2500, output: 65736 },
      detail: 'truncated prose snippet',
    });
    expect(logs.some((l) => l.includes('reason=output_cap') && l.includes('steps=3'))).toBe(true);
  });

  it('runDeepReview returns detail snippet on plain-text no_review', async () => {
    const res = await runDeepReview({
      complete: async () => ({ text: 'Here is my prose review without calling submit_review.', toolCalls: [], usage: { input: 50, output: 20 } }),
      trace: trace(),
      hero: 'beastmaster',
      lang: 'en',
    });
    expect(res).toMatchObject({
      status: 'no_review',
      detail: 'Here is my prose review without calling submit_review.',
    });
  });

  it('packages/dsh/src/index.js resolves Cordis function-style ctx.logger', () => {
    const src = readFileSync(new URL('../../packages/dsh/src/index.js', import.meta.url), 'utf8');
    expect(src).toContain("typeof ctx.logger === 'function' ? ctx.logger('dota2ai') : ctx.logger");
  });
});
