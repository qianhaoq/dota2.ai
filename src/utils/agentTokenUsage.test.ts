import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { runDeepReview } from '../../lib/agent/deepReview.js';
import { createAgentService } from '../../lib/agent/service.js';
import { shapeReview } from '../../lib/agent/replayTool.js';
import { formatUsageLog, parseDshUsage, parseOpenAiUsage } from '../../lib/agent/usage.js';

const fixture = gunzipSync(readFileSync(new URL('../../packages/review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url)));
const trace = () => JSON.parse(fixture.toString());
const ID = 9100904020;

const call = (name: string, args: any, id: string) => ({ id, name, args });
const finding = {
  title: '咆哮',
  claim: '幻影刺客开了 7 次黑皇杖。',
  evidence: [{ refs: ['cast:beastmaster:primal_roar:6'], fact: '27:27 吼进黑皇杖，定住 3.4 秒' }],
  fix: '留给她。',
};
const goodSubmit = {
  verdict: '咆哮没有留给幻影刺客。',
  mainline: [],
  findings: [finding],
  next_game: ['留咆哮'],
  blind_spots: ['视野'],
};
const badSubmit = {
  ...goodSubmit,
  verdict: '你在 19:19 死了，咆哮没有留给幻影刺客。',
};

describe('token usage accounting across review stages, persistence, and deduplication (#488)', () => {
  it('parses DSH and OpenAI usage cleanly while preserving null for absent cache telemetry', () => {
    expect(parseDshUsage({ inputTokens: 2000, cacheReadTokens: 8000, cacheWriteTokens: 500, outputTokens: 900 })).toEqual({
      input: 10_500, output: 900, input_uncached: 2000, cache_read: 8000, cache_write: 500, source: 'provider_usage',
    });
    expect(parseDshUsage({ inputTokens: 2000, cacheReadTokens: 8000, outputTokens: 900 })).toEqual({
      input: 10_000, output: 900, input_uncached: 2000, cache_read: 8000, cache_write: null, source: 'provider_usage',
    });
    expect(parseDshUsage({ inputTokens: 2000, outputTokens: 900 })).toEqual({
      input: 2000, output: 900, input_uncached: null, cache_read: null, cache_write: null, source: 'provider_usage',
    });
    expect(parseDshUsage(undefined)).toEqual({
      input: 0, output: 0, input_uncached: null, cache_read: null, cache_write: null, source: null,
    });
    expect(parseOpenAiUsage({ prompt_tokens: 5000, completion_tokens: 400, prompt_cache_hit_tokens: 3500, prompt_cache_miss_tokens: 1500 })).toEqual({
      input: 5000, output: 400, input_uncached: 1500, cache_read: 3500, cache_write: null, source: 'provider_usage',
    });
    expect(formatUsageLog({ input: 10_000, output: 1200, input_uncached: 2500, cache_read: 7500, cache_write: null })).toBe(
      'in=10000 uncached=2500 cache_read=7500(75%) out=1200',
    );
    expect(formatUsageLog({ input: 500, output: 80, input_uncached: null, cache_read: null, cache_write: null })).toBe(
      'in=500 out=80',
    );
  });

  it('aggregates per-stage usage across first pass (with truncation retry), repair round, and translate stage', async () => {
    let callIdx = 0;
    const complete = async (o: any) => {
      callIdx += 1;
      // Translate stage (tool-free completion)
      if (!o.tools?.length && String(o.system ?? '').includes('Dota 2 coaching translator')) {
        return {
          text: JSON.stringify({
            en: { verdict: 'Roar was not held for PA.', mainline: [], findings: [{ title: 'Roar', claim: 'PA used BKB 7 times.', evidence: ['27:27 stunned 3.4s'], fix: 'Hold it.' }], blind_spots: ['Vision'] },
            ru: { verdict: 'Рёв не сохранили для PA.', mainline: [], findings: [{ title: 'Рёв', claim: 'PA нажала BKB 7 раз.', evidence: ['27:27 оглушение 3.4 с'], fix: 'Берегите.' }], blind_spots: ['Обзор'] },
          }),
          usage: { input: 2000, output: 700, input_uncached: 2000, cache_read: 0, cache_write: null, source: 'provider_usage' },
        };
      }
      if (callIdx === 1) {
        return {
          toolCalls: [
            call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'a1'),
            call('immunity_windows', { hero: 'phantom_assassin' }, 'b1'),
          ],
          usage: { input: 3000, output: 200, input_uncached: 3000, cache_read: 0, cache_write: null, source: 'provider_usage' },
        };
      }
      if (callIdx === 2) {
        // Truncated mid-generation -> triggers one in-place truncation retry
        return {
          text: 'cut off...',
          truncated: true,
          toolCalls: [],
          usage: { input: 6000, output: 4000, input_uncached: 1500, cache_read: 4500, cache_write: null, source: 'provider_usage' },
        };
      }
      if (callIdx === 3) {
        // Submits review with one unsupported time (19:19) -> triggers repair round
        return {
          toolCalls: [call('submit_review', badSubmit, 's1')],
          usage: { input: 6200, output: 900, input_uncached: 200, cache_read: 6000, cache_write: null, source: 'provider_usage' },
        };
      }
      // Repair round (callIdx === 4): fixes verdict and resubmits
      return {
        toolCalls: [call('submit_review', goodSubmit, 's2')],
        usage: { input: 7000, output: 850, input_uncached: 800, cache_read: 6200, cache_write: null, source: 'provider_usage' },
      };
    };

    const out: any = await runDeepReview({ complete, trace: trace(), hero: 'beastmaster', lang: 'zh', translate: true });
    expect(out.status).toBe('ok');
    expect(out.steps).toBe(4);
    expect(out.repair_rounds).toBe(1);
    expect(out.truncation_retries).toBe(1);
    expect(out.usage_source).toBe('provider_usage');
    expect(out.usage).toEqual({
      input: 24_200,
      output: 6650,
      input_uncached: 7500,
      cache_read: 16_700,
      cache_write: null,
      source: 'provider_usage',
      stages: {
        first: {
          input: 15_200,
          output: 5100,
          input_uncached: 4700,
          cache_read: 10_500,
          cache_write: null,
          source: 'provider_usage',
          steps: 3,
          tool_calls: 2,
          truncation_retries: 1,
        },
        repair: {
          input: 7000,
          output: 850,
          input_uncached: 800,
          cache_read: 6200,
          cache_write: null,
          source: 'provider_usage',
          steps: 1,
          tool_calls: 0,
          truncation_retries: 0,
        },
        translate: {
          input: 2000,
          output: 700,
          input_uncached: 2000,
          cache_read: 0,
          cache_write: null,
          source: 'provider_usage',
          steps: 1,
          tool_calls: 0,
          truncation_retries: 0,
        },
      },
    });
  });

  it('deduplicates repeated lookup calls in runDeepReview (including repair round) while keeping verifyReview and checkpoint resume intact', async () => {
    const seenMessages: any[][] = [];
    const modelScript = (cutAt?: number) => {
      const state = { calls: 0 };
      const complete = async (o: any) => {
        const turn = o.messages.filter((m: any) => m.role === 'assistant').length + 1;
        state.calls += 1;
        seenMessages.push(JSON.parse(JSON.stringify(o.messages)));
        if (turn === cutAt) throw new Error('cut');
        if (turn === 1) {
          return {
            toolCalls: [
              call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'a1'),
              call('immunity_windows', { hero: 'phantom_assassin' }, 'b1'),
            ],
            usage: { input: 2000, output: 100, input_uncached: 2000, cache_read: 0, cache_write: null, source: 'provider_usage' },
          };
        }
        if (turn === 2) {
          // Redundantly re-calls ability_audit with reversed keys:
          return {
            toolCalls: [call('ability_audit', { ability: 'primal_roar', hero: 'beastmaster' }, 'a2')],
            usage: { input: 4000, output: 80, input_uncached: 1000, cache_read: 3000, cache_write: null, source: 'provider_usage' },
          };
        }
        if (turn === 3) {
          return {
            toolCalls: [call('submit_review', badSubmit, 's1')],
            usage: { input: 4200, output: 400, input_uncached: 200, cache_read: 4000, cache_write: null, source: 'provider_usage' },
          };
        }
        if (turn === 4) {
          // Repair round redundantly re-calls immunity_windows (already in first.messages):
          return {
            toolCalls: [call('immunity_windows', { hero: 'phantom_assassin' }, 'b2')],
            usage: { input: 4500, output: 80, input_uncached: 300, cache_read: 4200, cache_write: null, source: 'provider_usage' },
          };
        }
        return {
          toolCalls: [call('submit_review', goodSubmit, 's2')],
          usage: { input: 4600, output: 400, input_uncached: 100, cache_read: 4500, cache_write: null, source: 'provider_usage' },
        };
      };
      return { state, complete };
    };

    const points: any[] = [];
    await expect(runDeepReview({
      complete: modelScript(3).complete,
      trace: trace(),
      hero: 'beastmaster',
      lang: 'zh',
      onCheckpoint: (cp: any) => points.push(JSON.parse(JSON.stringify(cp))),
    })).rejects.toThrow('cut');

    // Checkpoint saved after the deduplicated turn 2 resumes cleanly without restarting from turn 1.
    const resumedScript = modelScript();
    const resumed: any = await runDeepReview({
      complete: resumedScript.complete,
      trace: trace(),
      hero: 'beastmaster',
      lang: 'zh',
      checkpoint: points.at(-1),
    });
    expect(resumed.status).toBe('ok');
    expect(resumedScript.state.calls).toBe(3); // turns 3, 4, 5 only (turns 1 & 2 came from checkpoint!)
    expect(resumed.duplicate_tool_calls).toBe(2);
    expect(resumed.verification).toMatchObject({ repaired: true, dropped: 0 });
    expect(resumed.review.findings).toHaveLength(1);
    // Both duplicate tool messages in the conversation were short pointers, not duplicated full payloads.
    const lastMsgs = seenMessages.at(-1)!;
    const dupMsgs = lastMsgs.filter((m: any) => m.role === 'tool' && String(m.content).includes('"duplicate_of"'));
    expect(dupMsgs).toHaveLength(2);
    expect(JSON.parse(dupMsgs[0].content)).toMatchObject({ duplicate_of: 'a1', tool: 'ability_audit' });
    expect(JSON.parse(dupMsgs[1].content)).toMatchObject({ duplicate_of: 'b1', tool: 'immunity_windows' });
  });

  it('persists full usage breakdown on stored reviews, logs cache hit stats, and exposes metadata in readyPayload & shapeReview', async () => {
    const blobs = new Map<string, any>();
    const docs = {
      get: async (k: string) => blobs.get(k) ?? null,
      put: async (k: string, v: any) => { blobs.set(k, JSON.parse(JSON.stringify(v))); },
      delete: async (k: string) => { blobs.delete(k); },
    };
    const logs: string[] = [];
    let turn = 0;
    const complete = async () => {
      turn += 1;
      if (turn === 1) {
        return {
          toolCalls: [
            call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'a1'),
            call('immunity_windows', { hero: 'phantom_assassin' }, 'b1'),
          ],
          usage: { input: 4000, output: 200, input_uncached: 4000, cache_read: 0, cache_write: null, source: 'provider_usage' },
        };
      }
      return {
        toolCalls: [call('submit_review', goodSubmit, 's1')],
        usage: { input: 8000, output: 1200, input_uncached: 2000, cache_read: 6000, cache_write: null, source: 'provider_usage' },
      };
    };

    const svc: any = createAgentService({
      traces: { get: async () => trace() },
      docs,
      complete,
      model: 'deepseek/deepseek-chat',
      log: (m: string) => logs.push(m),
    });
    expect(await svc.run({ kind: 'review', matchId: String(ID), hero: 'beastmaster', lang: 'zh' })).toEqual({ status: 'ready' });

    const readyLog = logs.find((l) => l.startsWith('deep-review ready'))!;
    expect(readyLog).toContain('steps=2');
    expect(readyLog).toContain('tools=2');
    expect(readyLog).toContain('repairs=0');
    expect(readyLog).toContain('in=12000 uncached=6000 cache_read=6000(50%) out=1400');

    // Fresh service instance reading purely from disk docs gets full usage metadata in readyPayload.
    const reloaded: any = createAgentService({ traces: { get: async () => trace() }, docs, complete: null });
    const state = await reloaded.status(ID, 'beastmaster', 'zh');
    expect(state).toMatchObject({
      status: 'ready',
      model: 'deepseek/deepseek-chat',
      steps: 2,
      tool_calls: 2,
      repair_rounds: 0,
      truncation_retries: 0,
      usage_source: 'provider_usage',
      usage: {
        input: 12_000,
        output: 1400,
        input_uncached: 6000,
        cache_read: 6000,
        cache_write: null,
        source: 'provider_usage',
        stages: {
          first: {
            input: 12_000,
            output: 1400,
            input_uncached: 6000,
            cache_read: 6000,
            cache_write: null,
            source: 'provider_usage',
            steps: 2,
            tool_calls: 2,
            truncation_retries: 0,
          },
        },
      },
    });

    // shapeReview passes the exact token usage telemetry through for MCP & DSH ToolCard.
    const shaped: any = shapeReview(String(ID), 'beastmaster', 'zh', state);
    expect(shaped).toMatchObject({
      model: 'deepseek/deepseek-chat',
      steps: 2,
      tool_calls: 2,
      repair_rounds: 0,
      truncation_retries: 0,
      usage_source: 'provider_usage',
      usage: {
        input: 12_000,
        output: 1400,
        input_uncached: 6000,
        cache_read: 6000,
        cache_write: null,
      },
    });
  });

  it('marks usage_source null when provider omits usage telemetry entirely', async () => {
    let turn = 0;
    const complete = async () => {
      turn += 1;
      if (turn === 1) return { toolCalls: [call('ability_audit', { hero: 'beastmaster', ability: 'primal_roar' }, 'a1'), call('immunity_windows', { hero: 'phantom_assassin' }, 'b1')] };
      return { toolCalls: [call('submit_review', goodSubmit, 's1')] };
    };
    const out: any = await runDeepReview({ complete, trace: trace(), hero: 'beastmaster', lang: 'zh' });
    expect(out.status).toBe('ok');
    expect(out.usage_source).toBeNull();
    expect(out.usage).toMatchObject({
      input: 0,
      output: 0,
      input_uncached: null,
      cache_read: null,
      cache_write: null,
      source: null,
    });
  });
});
