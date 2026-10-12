import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMatchReviewStream } from '../services/geminiService';
import type { ReviewParseStatus } from '../types/matchReview';

const sseBody = (events: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });

const sseHeaders = { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null) };
const jsonHeaders = { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) };

interface StreamResult {
  parseStatuses: ReviewParseStatus[];
  facts: unknown[];
  chunks: string[];
  grounded?: boolean;
  error?: string;
}

const runStream = (fetchMock: ReturnType<typeof vi.fn>): Promise<StreamResult> =>
  new Promise((resolve) => {
    const result: StreamResult = { parseStatuses: [], facts: [], chunks: [] };
    fetchMatchReviewStream(9035042364, 'en', undefined, undefined, {
      onData: (fact) => result.facts.push(fact),
      onParseStatus: (parse) => result.parseStatuses.push(parse),
      onChunk: (text) => result.chunks.push(text),
      onComplete: (grounded) => {
        result.grounded = grounded;
        resolve(result);
      },
      onError: (error) => {
        result.error = error;
        resolve(result);
      },
    });
  });

describe('fetchMatchReviewStream parse status', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces parse status from the SSE facts event', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: sseHeaders,
      body: sseBody([
        'data: {"matchFact":{"summary":{"matchId":9035042364}},"grounded":false,"parse":{"status":"pending","jobId":777,"retryAfterSec":120,"message":"Replay parse in progress"}}\n\n',
        'data: {"text":"partial"}\n\n',
        'data: [DONE]\n\n',
      ]),
    });

    const result = await runStream(fetchMock);
    expect(result.error).toBeUndefined();
    expect(result.parseStatuses).toEqual([
      { status: 'pending', jobId: 777, retryAfterSec: 120, message: 'Replay parse in progress' },
    ]);
    expect(result.facts).toHaveLength(1);
    expect(result.chunks).toEqual(['partial']);
    expect(result.grounded).toBe(false);
  });

  it('surfaces throttled parse status from a JSON (non-SSE) result', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: jsonHeaders,
      json: async () => ({
        matchFact: { summary: { matchId: 9035042364 } },
        grounded: false,
        parse: { status: 'throttled', jobId: null, retryAfterSec: 300, message: 'Rate limited' },
        text: 'review body',
      }),
    });

    const result = await runStream(fetchMock);
    expect(result.error).toBeUndefined();
    expect(result.parseStatuses).toEqual([
      { status: 'throttled', jobId: null, retryAfterSec: 300, message: 'Rate limited' },
    ]);
    expect(result.facts).toHaveLength(1);
    expect(result.chunks).toEqual(['review body']);
    expect(result.grounded).toBe(false);
  });

  it('does not call onParseStatus when the payload has no valid parse status', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      headers: sseHeaders,
      body: sseBody([
        'data: {"matchFact":{"summary":{"matchId":9035042364}},"grounded":true,"parse":{"status":"bogus"}}\n\n',
        'data: [DONE]\n\n',
      ]),
    });

    const result = await runStream(fetchMock);
    expect(result.error).toBeUndefined();
    expect(result.parseStatuses).toEqual([]);
    expect(result.grounded).toBe(true);
  });
});
