// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { readSse, reviewReducer, useReviewStream } from './useReviewStream';
function sse(text: string) {
    return new Response(new ReadableStream({ start(c) {
            const bytes = new TextEncoder().encode(text);
            for (let i = 0; i < bytes.length; i++)
                c.enqueue(bytes.slice(i, i + 1));
            c.close();
        } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});
it('parses split UTF-8, CRLF, multiline data, ids, retry and comments', async () => {
    const frames: any[] = [];
    await readSse(sse(': ping\r\nretry: 10\r\n\r\nid: 12\r\nevent: token\r\ndata: {"delta":\r\ndata: "你好"}\r\n\r\n'), new AbortController().signal, f => { frames.push(f); });
    expect(frames).toEqual([{ event: 'retry', retry: 10, data: null }, { event: 'token', id: '12', data: { delta: '你好' } }]);
});
it('replace_start and functional delta appends target only the correct insight', () => {
    let state = reviewReducer({} as any, { event: 'reset', data: null });
    state = reviewReducer(state, { event: 'card', data: { kind: 'insight', index: 1, payload: { id: 'fix_this', claim: { text: 'template' } } } });
    state = reviewReducer(state, { event: 'token', data: { target: 'insight:fix_this', mode: 'replace_start' } });
    for (const delta of ['A', 'B'])
        state = reviewReducer(state, { event: 'token', data: { target: 'insight:fix_this', delta } });
    expect(state.insights[0]?.claim.text).toBe('AB');
});
it('bounded reconnect honors retry delay and ultimately emits safe failure', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(sse('retry: 25\n\nid: 1\nevent: progress\ndata: {"step":"facts","status":"active"}\n\n')));
    vi.stubGlobal('fetch', fetcher);
    const hook = renderHook(() => useReviewStream('123', 'pudge', 'en'));
    await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => {
        await vi.advanceTimersByTimeAsync(24);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(hook.result.current.status).toBe('error');
    expect(hook.result.current.error?.message_key).toBe('err.internal');
});
it('match, hero and language revisions abort the previous request and drop late resolution', async () => {
    let first!: (r: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise(r => {
        first = r;
    })).mockImplementation(() => Promise.resolve(sse('id: 1\nevent: done\ndata: {"state":"needs_hero"}\n\n')));
    vi.stubGlobal('fetch', fetcher);
    const hook = renderHook(({ id, hero, lang }) => useReviewStream(id, hero, lang), { initialProps: { id: '123', hero: 'pudge', lang: 'en' } });
    hook.rerender({ id: '456', hero: 'axe', lang: 'zh' });
    await waitFor(() => expect(hook.result.current.status).toBe('done'));
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => {
        first(sse('event: error\ndata: {"message_key":"SECRET"}\n\n'));
    });
    expect(hook.result.current.status).toBe('done');
    expect(hook.result.current.error).toBeUndefined();
});
it('unmount cancels a pending reconnect without issuing another fetch', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(sse('retry: 100\n\nid: 1\nevent: progress\ndata: {}\n\n')));
    vi.stubGlobal('fetch', fetcher);
    const hook = renderHook(() => useReviewStream('123', null, 'en'));
    await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
    });
    hook.unmount();
    await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([false, true])('accepts a restarted sequence and clears stale cards/tokens (reduced motion: %s)', async (reduced) => {
    vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
    const card = { kind: 'insight', index: 1, payload: { id: 'fix_this', claim: { text: 'old' } } };
    const frame = (event: string, data: unknown, id: number) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const fetcher = vi.fn()
        .mockResolvedValueOnce(sse('retry: 0\n\n' + frame('card', card, 1) + frame('token', { target: 'insight:fix_this', delta: 'stale' }, 2) + frame('card', { kind: 'followups', payload: [{ id: 'stale' }] }, 3)))
        .mockResolvedValueOnce(sse(frame('card', { ...card, payload: { ...card.payload, claim: { text: 'fresh' } } }, 1) + frame('done', { state: 'parsed' }, 2)));
    vi.stubGlobal('fetch', fetcher);
    const hook = renderHook(() => useReviewStream('123', 'pudge', 'en'));
    await waitFor(() => expect(hook.result.current.status).toBe('done'));
    expect(fetcher.mock.calls[1][1].headers['Last-Event-ID']).toBe('3');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(hook.result.current.done?.state).toBe('parsed');
    expect(hook.result.current.error).toBeUndefined();
    expect(hook.result.current.insights[0]?.claim.text).toBe('fresh');
    expect(hook.result.current.followups).toEqual([]);
});
