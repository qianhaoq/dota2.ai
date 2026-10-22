import { useEffect, useReducer, useRef, useState } from 'react';
import type { Frame, Hero, Insight, Followup, Review, StreamError } from './types';
/** Incremental SSE parser: comments, CRLF, split UTF-8 and multi-line data. */
export async function readSse(response: Response, signal: AbortSignal, receive: (frame: Frame) => void | boolean) {
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
        throw new Error('unsupported');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let stopped = false;
    let buffer = '', event = 'message', id: string | undefined, data: string[] = [];
    const abort = () => {
        void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    const line = (value: string) => {
        if (!value) {
            if (data.length)
                stopped = receive({ event, id, data: JSON.parse(data.join('\n')) }) === true;
            event = 'message';
            data = [];
            id = undefined;
            return;
        }
        if (value.startsWith(':'))
            return;
        const colon = value.indexOf(':');
        const field = colon < 0 ? value : value.slice(0, colon);
        const text = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '');
        if (field === 'event')
            event = text;
        if (field === 'data')
            data.push(text);
        if (field === 'id' && !text.includes('\0'))
            id = text;
        if (field === 'retry' && /^\d+$/.test(text))
            receive({ event: 'retry', data: null, retry: Number(text) });
    };
    try {
        while (!signal.aborted) {
            const chunk = await reader.read();
            buffer += decoder.decode(chunk.value, { stream: !chunk.done });
            let end: number;
            while ((end = buffer.search(/[\r\n]/)) >= 0) {
                if (buffer[end] === '\r' && end === buffer.length - 1 && !chunk.done)
                    break;
                const size = buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1;
                line(buffer.slice(0, end));
                if (stopped)
                    return;
                buffer = buffer.slice(end + size);
            }
            if (chunk.done)
                break;
        }
    }
    finally {
        signal.removeEventListener('abort', abort);
        await reader.cancel().catch(() => {
        });
        reader.releaseLock();
    }
}
export interface ReviewStreamState {
    contextKey?: string;
    status: 'idle' | 'streaming' | 'done' | 'error';
    steps: Record<string, {
        status: string;
        ms?: number;
    }>;
    heroPick: Hero[];
    resultHeader: any;
    insights: (Insight | undefined)[];
    followups: Followup[];
    fakedoor: any;
    done?: {
        state: string;
        review?: Review;
        timings?: Record<string, number | string>;
    };
    error?: StreamError;
}
const initial: ReviewStreamState = { status: 'idle', steps: {}, heroPick: [], resultHeader: null, insights: [], followups: [], fakedoor: null };
export function reviewReducer(state: ReviewStreamState, frame: Frame): ReviewStreamState {
    const d = frame.data;
    if (frame.event === 'reset')
        return { ...initial, status: 'streaming', contextKey: d };
    if (state.status === 'error' || state.status === 'done')
        return state;
    switch (frame.event) {
        case 'progress': return { ...state, steps: { ...state.steps, [d.step]: d } };
        case 'hero_pick': return { ...state, heroPick: d.roster };
        case 'card': {
            if (d.kind === 'insight') {
                const insights = [...state.insights];
                insights[d.index - 1] = d.payload;
                return { ...state, insights };
            }
            return { ...state, ...(d.kind === 'result_header' ? { resultHeader: d.payload } : d.kind === 'followups' ? { followups: d.payload } : d.kind === 'fakedoor' ? { fakedoor: d.payload } : {}) };
        }
        case 'token': return { ...state, insights: state.insights.map(i => i && d.target === `insight:${i.id}` ? { ...i, claim: { ...i.claim, text: d.mode === 'replace_start' ? '' : i.claim.text + (d.delta ?? '') } } : i) };
        case 'done': return { ...state, status: 'done', done: d };
        case 'error': return { ...state, status: 'error', error: d };
        default: return state;
    }
}
const failure: StreamError = { code: 'INTERNAL', retryable: true, message_key: 'err.internal' };
const pause = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
    const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
});
export function useReviewStream(matchId: string, hero: string | null, lang: string, enabled = true) {
    const [state, dispatch] = useReducer(reviewReducer, initial);
    const [attempt, retry] = useState(0);
    const revision = useRef(0);
    const contextKey = JSON.stringify([matchId, hero, lang, attempt, enabled]);
    useEffect(() => {
        const rev = ++revision.current, controller = new AbortController();
        const current = () => !controller.signal.aborted && rev === revision.current;
        dispatch({ event: 'reset', data: contextKey });
        if (!enabled)
            return () => controller.abort();
        const query = new URLSearchParams({ lang, ...(hero ? { hero } : {}) });
        const base = `/api/v1/review/${encodeURIComponent(matchId)}`;
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
        const pendingTokens: Frame[] = [];
        let lastId = '', delay = 3000, seen = false, terminal = false;
        const receive = (f: Frame) => {
            if (!current() || terminal)
                return;
            if (f.retry != null) {
                delay = Math.min(f.retry, 30000);
                return;
            }
            if (f.id && lastId && Number(f.id) <= Number(lastId))
                return;
            if (f.id)
                lastId = f.id;
            seen = true;
            terminal = f.event === 'done' || f.event === 'error';
            if (reduced && f.event === 'token') {
                pendingTokens.push(f);
                return;
            }
            if (f.event === 'done')
                pendingTokens.forEach(dispatch);
            dispatch(f);
        };
        void (async () => {
            for (let n = 0; n < 4 && current(); n++) {
                try {
                    const response = await fetch(`${base}/stream?${query}`, { signal: controller.signal, headers: { Accept: 'text/event-stream', ...(lastId ? { 'Last-Event-ID': lastId } : {}) } });
                    await readSse(response, controller.signal, f => {
                        receive(f);
                        return terminal;
                    });
                    if (terminal || !current())
                        return;
                }
                catch {
                    if (!current())
                        return;
                }
                if (!seen) {
                    try {
                        const response = await fetch(`${base}?${query}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
                        const review = await response.json();
                        if (!current())
                            return;
                        if (!response.ok) {
                            receive({ event: 'error', data: review?.message_key ? review : failure });
                            return;
                        }
                        if (!review.player)
                            receive({ event: 'hero_pick', data: { roster: review.roster } });
                        receive({ event: 'card', data: { kind: 'result_header', payload: { match: review.match, player: review.player } } });
                        review.insights.forEach((payload: Insight, index: number) => receive({ event: 'card', data: { kind: 'insight', index: index + 1, payload } }));
                        receive({ event: 'card', data: { kind: 'followups', payload: review.followups } });
                        receive({ event: 'done', data: { state: review.player ? review.state : 'needs_hero', review } });
                        return;
                    }
                    catch {
                        if (current())
                            receive({ event: 'error', data: failure });
                        return;
                    }
                }
                if (n < 3)
                    await pause(delay, controller.signal);
            }
            if (current())
                receive({ event: 'error', data: failure });
        })();
        return () => {
            ++revision.current;
            controller.abort();
        };
    }, [matchId, hero, lang, attempt, enabled]);
    return { ...(state.contextKey === contextKey ? state : { ...initial, status: 'streaming' as const }), retry: () => retry(n => n + 1) };
}
