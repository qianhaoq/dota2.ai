import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { streamFollowUpCompletion } from '../../lib/matchReview/followUpCompletion.js';
import { clampFollowUpAttemptMs } from '../../lib/matchReview/followUpTimeout.js';
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

describe('streamFollowUpCompletion (empty-stream fallback)', () => {
  it('treats a cleanly-closed empty stream as a provider failure and streams from Gemini instead', async () => {
    const texts: string[] = [];
    const failures: string[] = [];
    // Upstream proxy truncated the SSE body: no content, no finish_reason.
    const deepseek = { name: 'deepseek', create: async () => streamOf([]) };
    const gemini = { name: 'gemini', create: async () => streamOf([chunk('gemini answer', 'stop')]) };

    const outcome = await streamFollowUpCompletion({
      providers: [deepseek, gemini],
      attemptMs: 40000,
      onText: (t) => texts.push(t),
      onProviderError: (i) => failures.push(`${i.provider}:${i.error}`),
    });

    expect(outcome).toEqual({ status: 'done', finishReason: 'stop', provider: 'gemini' });
    expect(texts).toEqual(['gemini answer']);
    expect(failures).toEqual(['deepseek:empty_stream']);
  });

  it('returns failed when every provider closes with an empty, non-terminal stream', async () => {
    const texts: string[] = [];
    const failures: string[] = [];
    const providers = [
      { name: 'deepseek', create: async () => streamOf([]) },
      { name: 'gemini', create: async () => streamOf([chunk(undefined)]) },
    ];

    const outcome = await streamFollowUpCompletion({
      providers,
      attemptMs: 40000,
      onText: (t) => texts.push(t),
      onProviderError: (i) => failures.push(`${i.provider}:${i.error}`),
    });

    expect(outcome).toEqual({ status: 'failed', finishReason: null });
    expect(texts).toEqual([]);
    expect(failures).toEqual(['deepseek:empty_stream', 'gemini:empty_stream']);
  });

  it('keeps done semantics for an empty stream that ended with a terminal finish_reason', async () => {
    let geminiCalled = false;
    const outcome = await streamFollowUpCompletion({
      providers: [
        { name: 'deepseek', create: async () => streamOf([chunk(undefined, 'stop')]) },
        { name: 'gemini', create: async () => { geminiCalled = true; return streamOf([]); } },
      ],
      attemptMs: 40000,
      onText: () => {},
    });
    expect(outcome).toEqual({ status: 'done', finishReason: 'stop', provider: 'deepseek' });
    expect(geminiCalled).toBe(false);
  });
});

describe('streamFollowUpCompletion (terminal finish)', () => {
  it('returns done as soon as a terminal finish_reason arrives, even if the iterator then stalls', async () => {
    vi.useFakeTimers();
    const texts: string[] = [];
    async function* stallsAfterStop() {
      yield chunk('final answer', 'stop');
      await never();
    }
    const gemini = { name: 'gemini', create: vi.fn() };
    const p = streamFollowUpCompletion({
      providers: [{ name: 'deepseek', create: async () => stallsAfterStop() }, gemini],
      attemptMs: 40000,
      onText: (t: string) => texts.push(t),
    });
    const outcome = await p;
    expect(outcome).toEqual({ status: 'done', finishReason: 'stop', provider: 'deepseek' });
    expect(texts).toEqual(['final answer']);
    expect(gemini.create).not.toHaveBeenCalled();
  });
});

describe('streamFollowUpCompletion (request-budget clamp)', () => {
  it('caps each attempt at the remaining request budget, not the configured timeout', async () => {
    vi.useFakeTimers();
    const failures: string[] = [];
    let deepSeekAborted = false;
    let geminiCalled = false;
    const deepseek = {
      name: 'deepseek',
      create: (signal: AbortSignal) => {
        signal.addEventListener('abort', () => { deepSeekAborted = true; });
        return never();
      },
    };
    const gemini = {
      name: 'gemini',
      create: async () => {
        geminiCalled = true;
        return streamOf([chunk('x', 'stop')]);
      },
    };

    // 140s of the 170s budget already spent: the first attempt may only run
    // for the remaining 30s, not the configured 40s.
    const startedAt = Date.now() - 140000;
    const pending = streamFollowUpCompletion({
      providers: [deepseek, gemini],
      attemptMs: 40000,
      startedAt,
      budgetMs: 170000,
      minAttemptMs: 5000,
      onText: () => {},
      onProviderError: (i) => failures.push(`${i.provider}:${i.error}`),
    });
    await vi.advanceTimersByTimeAsync(30000);
    const outcome = await pending;

    // Deadline hit at 30s (budget-clamped); nothing left for Gemini.
    expect(outcome).toEqual({ status: 'failed', finishReason: null });
    expect(failures).toEqual(['deepseek:deadline']);
    expect(deepSeekAborted).toBe(true);
    expect(geminiCalled).toBe(false);
  });

  it('skips the next provider when the remaining budget drops below minAttemptMs', async () => {
    const failures: string[] = [];
    let geminiCalled = false;
    const httpErr = Object.assign(new Error('boom'), { status: 500 });
    const start = Date.now();
    let clock = start;
    const deepseek = {
      name: 'deepseek',
      // Fails fast in wall time but burns the budget down to 3s remaining
      // (via the injected clock) before handing over to the next provider.
      create: async () => { clock = start + 167000; throw httpErr; },
    };
    const gemini = {
      name: 'gemini',
      create: async () => {
        geminiCalled = true;
        return streamOf([chunk('x', 'stop')]);
      },
    };

    const outcome = await streamFollowUpCompletion({
      providers: [deepseek, gemini],
      attemptMs: 40000,
      startedAt: start,
      budgetMs: 170000,
      minAttemptMs: 5000,
      now: () => clock,
      onText: () => {},
      onProviderError: (i) => failures.push(`${i.provider}:${i.error}`),
    });

    expect(outcome).toEqual({ status: 'failed', finishReason: null });
    expect(geminiCalled).toBe(false);
    // Budget exhaustion is not a provider failure: only DeepSeek is reported.
    expect(failures).toEqual(['deepseek:http_500']);
  });

  it('does not attempt any provider once the request budget is exhausted', async () => {
    let called = false;
    const providers = [{
      name: 'deepseek',
      create: async () => {
        called = true;
        return streamOf([chunk('x', 'stop')]);
      },
    }];

    // 1s left < 5s floor: not even the first provider is attempted.
    const outcome = await streamFollowUpCompletion({
      providers,
      attemptMs: 40000,
      startedAt: Date.now() - 169000,
      budgetMs: 170000,
      minAttemptMs: 5000,
      onText: () => {},
    });

    expect(outcome).toEqual({ status: 'failed', finishReason: null });
    expect(called).toBe(false);
  });
});

describe('server.js follow-up wiring (pattern guard)', () => {
  const server = readFileSync(join(__dirname, '../../server.js'), 'utf8');
  const num = (name: string) => Number(server.match(new RegExp(`const ${name} = (\\d+)`))![1]);

  it('configures the follow-up attempt timeout (~40s, env-tunable but budget-clamped)', () => {
    expect(server).toMatch(/clampFollowUpAttemptMs\(\s*process\.env\.REVIEW_FOLLOW_UP_ATTEMPT_TIMEOUT_MS,/);
    // Whatever the env holds, the effective attempt timeout after clamping is
    // bounded by the server's own budgets.
    for (const raw of [undefined, 1, 40000, 999999, 'garbage']) {
      expect(clampFollowUpAttemptMs(raw, {
        fetchBudgetMs: num('REVIEW_FETCH_BUDGET_MS'),
        requestBudgetMs: num('REVIEW_REQUEST_BUDGET_MS'),
        maxAttempts: 2,
        minAttemptMs: num('REVIEW_MIN_ATTEMPT_MS'),
      })).toBeLessThanOrEqual(40000);
    }
    expect(server).toMatch(/streamFollowUpCompletion\(\{\s*[\s\S]*?attemptMs: REVIEW_FOLLOW_UP_ATTEMPT_TIMEOUT_MS/);
    // Each attempt is additionally capped by the remaining request budget.
    expect(server).toMatch(/streamFollowUpCompletion\(\{\s*[\s\S]*?minAttemptMs: REVIEW_MIN_ATTEMPT_MS,/);
  });

  it('keeps fetch + two follow-up attempts inside the request budget', () => {
    const budget = num('REVIEW_REQUEST_BUDGET_MS');
    const fetch = num('REVIEW_FETCH_BUDGET_MS');
    for (const raw of [undefined, 1, 40000, 999999]) {
      const attemptMs = clampFollowUpAttemptMs(raw, {
        fetchBudgetMs: fetch,
        requestBudgetMs: budget,
        maxAttempts: 2,
        minAttemptMs: num('REVIEW_MIN_ATTEMPT_MS'),
      });
      expect(fetch + 2 * attemptMs).toBeLessThanOrEqual(budget);
    }
  });

  it('answers total follow-up failure with the deterministic template, not provider text', () => {
    // failed (every provider died before any text) degrades to the
    // buildFollowUpFallbackText template — follow-ups never return
    // ai_unavailable, and the raw provider error never reaches the client.
    expect(server).toMatch(/const decision = decideFollowUpOutcome\(outcome\);[\s\S]*?sendFollowUpFallback\(decision\)/);
    expect(server).toMatch(/sendFollowUpFallback\(\{ reason: 'error', append: followUpForwarded \}\)/);
    // Follow-up streaming goes through the provider chain, not a direct call.
    expect(server).toMatch(/const followUpProviders = \[/);
    expect(server).not.toMatch(/followUpRequest/);
  });
});
