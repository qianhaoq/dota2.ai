import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { streamFollowUpCompletion } from '../../lib/matchReview/followUpCompletion.js';
import { sanitizeLlmErrorForClient } from '../../lib/llmErrors.js';

// Mock providers only — no network, mock credential shapes if any appear.
type Chunk = { choices: Array<{ delta: { content?: string }, finish_reason: string | null }> };
const chunk = (text?: string, finish: string | null = null): Chunk => ({
  choices: [{ delta: text ? { content: text } : {}, finish_reason: finish }],
});
const never = () => new Promise<never>(() => {});
async function* streamOf(chunks: Chunk[]) {
  yield* chunks;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('streamFollowUpCompletion (timeout → fallback → error)', () => {
  it('aborts a hung DeepSeek attempt at the deadline and streams from Gemini instead', async () => {
    vi.useFakeTimers();
    const texts: string[] = [];
    const failures: string[] = [];
    let deepSeekAborted = false;
    const deepseek = {
      name: 'deepseek',
      // Stream creation never settles (hung request, ignores nothing else).
      create: (signal: AbortSignal) => {
        signal.addEventListener('abort', () => { deepSeekAborted = true; });
        return never();
      },
    };
    const gemini = {
      name: 'gemini',
      create: async () => streamOf([chunk('gemini ', undefined), chunk('answer', 'stop')]),
    };

    const pending = streamFollowUpCompletion({
      providers: [deepseek, gemini],
      attemptMs: 40000,
      onText: (t) => texts.push(t),
      onProviderError: (i) => failures.push(`${i.provider}:${i.error}`),
    });
    await vi.advanceTimersByTimeAsync(40000);
    const outcome = await pending;

    expect(outcome).toEqual({ status: 'done', finishReason: 'stop', provider: 'gemini' });
    expect(texts).toEqual(['gemini ', 'answer']);
    expect(failures).toEqual(['deepseek:deadline']);
    expect(deepSeekAborted).toBe(true);
  });

  it('returns failed (sanitized generic error for the client) when every provider fails before any text', async () => {
    vi.useFakeTimers();
    const texts: string[] = [];
    const failures: string[] = [];
    const authErr = () => {
      const e = new Error('401 Incorrect API key provided: sk-test-mock1234567890.');
      (e as unknown as { status: number }).status = 401;
      return e;
    };
    const providers = [
      { name: 'deepseek', create: async () => { throw authErr(); } },
      { name: 'gemini', create: async () => { throw authErr(); } },
    ];

    const outcome = await streamFollowUpCompletion({
      providers,
      attemptMs: 40000,
      onText: (t) => texts.push(t),
      onProviderError: (i) => failures.push(`${i.provider}:${i.error}`),
    });

    expect(outcome).toEqual({ status: 'failed', finishReason: null });
    expect(texts).toEqual([]);
    expect(failures).toEqual(['deepseek:http_401', 'gemini:http_401']);
    // The mapped client payload carries none of the provider text.
    const payload = JSON.stringify(sanitizeLlmErrorForClient('en'));
    expect(payload).not.toContain('sk-test-mock');
    expect(payload).not.toContain('Incorrect API key');
  });

  it('does not fall back after text was already forwarded (no duplicated stream)', async () => {
    vi.useFakeTimers();
    const texts: string[] = [];
    let geminiCalled = false;
    async function* partialThenHang() {
      yield chunk('partial ');
      await never();
    }
    const deepseek = { name: 'deepseek', create: async () => partialThenHang() };
    const gemini = {
      name: 'gemini',
      create: async () => {
        geminiCalled = true;
        return streamOf([chunk('dupe', 'stop')]);
      },
    };

    const pending = streamFollowUpCompletion({
      providers: [deepseek, gemini],
      attemptMs: 40000,
      onText: (t) => texts.push(t),
    });
    await vi.advanceTimersByTimeAsync(40000);
    const outcome = await pending;

    expect(outcome).toEqual({ status: 'incomplete', finishReason: null, provider: 'deepseek' });
    expect(texts).toEqual(['partial ']);
    expect(geminiCalled).toBe(false);
  });

  it('rethrows client-disconnect aborts without trying the next provider', async () => {
    vi.useFakeTimers();
    const client = new AbortController();
    const abortErr = Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' });
    let geminiCalled = false;
    const deepseek = {
      name: 'deepseek',
      // openai v4 rejects with APIUserAbortError when the shared signal aborts.
      create: (signal: AbortSignal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(abortErr));
      }),
    };
    const gemini = {
      name: 'gemini',
      create: async () => {
        geminiCalled = true;
        return streamOf([chunk('x', 'stop')]);
      },
    };

    const pending = streamFollowUpCompletion({
      providers: [deepseek, gemini],
      attemptMs: 40000,
      signal: client.signal,
      onText: () => {},
    });
    client.abort();
    await expect(pending).rejects.toBe(abortErr);
    expect(geminiCalled).toBe(false);
  });

  it('stops consuming when the caller reports the client is gone', async () => {
    vi.useFakeTimers();
    const texts: string[] = [];
    let geminiCalled = false;
    const deepseek = {
      name: 'deepseek',
      create: async () => streamOf([chunk('first'), chunk('second'), chunk('third', 'stop')]),
    };
    const outcome = await streamFollowUpCompletion({
      providers: [deepseek, { name: 'gemini', create: async () => { geminiCalled = true; return streamOf([]); } }],
      attemptMs: 40000,
      onText: (t) => texts.push(t),
      shouldStop: () => texts.length >= 1,
    });
    expect(outcome).toEqual({ status: 'stopped', finishReason: null, provider: 'deepseek' });
    expect(texts).toEqual(['first']);
    expect(geminiCalled).toBe(false);
  });

  it('marks a finished-but-non-terminal stream via finishReason (caller shows incomplete)', async () => {
    const outcome = await streamFollowUpCompletion({
      providers: [{ name: 'deepseek', create: async () => streamOf([chunk('hi')]) }],
      attemptMs: 40000,
      onText: () => {},
    });
    expect(outcome).toEqual({ status: 'done', finishReason: null, provider: 'deepseek' });
  });
});

describe('server.js follow-up wiring (pattern guard)', () => {
  const server = readFileSync(join(__dirname, '../../server.js'), 'utf8');
  const num = (name: string) =>
    Number(server.match(new RegExp(`const ${name} = envPositiveInt\\('${name}', (\\d+)\\)`))?.[1] ?? NaN);

  it('configures the follow-up attempt timeout (~40s, env-tunable)', () => {
    expect(num('REVIEW_FOLLOW_UP_ATTEMPT_TIMEOUT_MS')).toBe(40000);
    expect(server).toMatch(/streamFollowUpCompletion\(\{\s*[\s\S]*?attemptMs: REVIEW_FOLLOW_UP_ATTEMPT_TIMEOUT_MS/);
  });

  it('keeps fetch + two follow-up attempts inside the request budget', () => {
    const budget = Number(server.match(/const REVIEW_REQUEST_BUDGET_MS = (\d+)/)![1]);
    const fetch = Number(server.match(/const REVIEW_FETCH_BUDGET_MS = (\d+)/)![1]);
    expect(fetch + 2 * num('REVIEW_FOLLOW_UP_ATTEMPT_TIMEOUT_MS')).toBeLessThanOrEqual(budget);
  });

  it('answers total follow-up failure with the sanitized generic payload, not provider text', () => {
    expect(server).toMatch(/outcome\.status === 'failed'[\s\S]*?sanitizeLlmErrorForClient\(lang\)/);
    // Follow-up streaming goes through the provider chain, not a direct call.
    expect(server).toMatch(/const followUpProviders = \[/);
    expect(server).not.toMatch(/followUpRequest/);
  });
});
