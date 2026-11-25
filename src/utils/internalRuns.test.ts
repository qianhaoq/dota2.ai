// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { INTERNAL_HEADER, INTERNAL_STORAGE_KEY, buildEventPayload, internalFromSearch, resolveInternal } from './analyticsClient';
import { validateAnalyticsEvent } from '../../lib/analyticsEvents.js';
import { summarizeFunnel } from '../../lib/analyticsFunnel.js';
import { createAgentRouter } from '../../lib/agent/router.js';

/**
 * Telling our own runs from visitors. Of five browsers that asked for a review in a week, how many were the
 * owner's, a session's check or a script's could not be said (#369): a browser of ours is now marked once with
 * ?internal=1, its events and its requests say so, and the funnel leaves it out.
 */

const store = () => { const m = new Map<string, string>(); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } }; };

describe('marking a browser as ours', () => {
  it('?internal=1 marks it, ?internal=0 unmarks it, anything else leaves it as it is', () => {
    expect([internalFromSearch('?internal=1'), internalFromSearch('?hero=axe&internal=0'), internalFromSearch('?internal=yes'), internalFromSearch('?hero=axe'), internalFromSearch('')]).toEqual([true, false, null, null, null]);
    const s = store();
    expect(resolveInternal(s, '?hero=axe')).toBe(false);
    expect(resolveInternal(s, '?internal=1')).toBe(true);
    expect(s.m.get(INTERNAL_STORAGE_KEY)).toBe('1');
    // The mark stays for later pages of this browser, with nothing in the URL.
    expect(resolveInternal(s, '')).toBe(true);
    expect(resolveInternal(s, '?internal=maybe')).toBe(true);
    expect(resolveInternal(s, '?internal=0')).toBe(false);
    expect(s.m.has(INTERNAL_STORAGE_KEY)).toBe(false);
    expect(resolveInternal(s, '')).toBe(false);
  });

  it('with no storage the URL decides for that page, and nothing throws', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
    expect(resolveInternal(broken, '?internal=1')).toBe(true);
    expect(resolveInternal(broken, '')).toBe(false);
    expect(resolveInternal(null, '?internal=1')).toBe(false);
    expect(resolveInternal(undefined, '')).toBe(false);
  });

  it('its events say so; a visitor\'s carry no such field at all', () => {
    expect(buildEventPayload('match_opened', { matchId: '1' }, null, true)).toEqual({ event: 'match_opened', props: { matchId: '1' }, anonId: null, internal: true });
    expect(buildEventPayload('match_opened', { matchId: '1' }, null)).toEqual({ event: 'match_opened', props: { matchId: '1' }, anonId: null });
    expect('internal' in buildEventPayload('match_opened', {}, null, false)).toBe(false);
  });
});

describe('the page of a marked browser', () => {
  beforeEach(() => { vi.resetModules(); localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });

  it('sends the mark with its events and the header with its requests for a parse or a review', async () => {
    window.history.replaceState({}, '', '/r/9100904020?hero=beastmaster&internal=1');
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { calls.push([String(url), init]); return new Response(JSON.stringify({ status: 'running', stage: 'locating' }), { status: 202 }); }));
    (navigator as any).sendBeacon = undefined;
    const analytics = await import('../services/analytics');
    const api = await import('../agent/api');
    expect(analytics.isInternalBrowser()).toBe(true);
    expect(analytics.internalHeaders()).toEqual({ [INTERNAL_HEADER]: '1' });
    analytics.trackEvent('match_opened', { matchId: '9100904020', lang: 'zh' });
    await api.prepareMatch('9100904020');
    const event = calls.find((c) => c[0].includes('/api/events'));
    expect(JSON.parse(String(event[1].body))).toMatchObject({ event: 'match_opened', internal: true });
    const prepare = calls.find((c) => c[0].includes('/prepare'));
    expect(prepare[1].headers).toEqual({ 'Content-Type': 'application/json', [INTERNAL_HEADER]: '1' });
    expect(localStorage.getItem(INTERNAL_STORAGE_KEY)).toBe('1');
  });

  it('a visitor\'s page sends neither', async () => {
    window.history.replaceState({}, '', '/r/9100904020?hero=beastmaster');
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { calls.push([String(url), init]); return new Response(JSON.stringify({ status: 'running', stage: 'locating' }), { status: 202 }); }));
    (navigator as any).sendBeacon = undefined;
    const analytics = await import('../services/analytics');
    const api = await import('../agent/api');
    expect(analytics.isInternalBrowser()).toBe(false);
    expect(analytics.internalHeaders()).toEqual({});
    analytics.trackEvent('match_opened', { matchId: '9100904020', lang: 'zh' });
    await api.prepareMatch('9100904020');
    expect('internal' in JSON.parse(String(calls.find((c) => c[0].includes('/api/events'))[1].body))).toBe(false);
    expect(calls.find((c) => c[0].includes('/prepare'))[1].headers).toEqual({ 'Content-Type': 'application/json' });
  });
});

describe('the server and the funnel', () => {
  it('an event is ours only when it says the literal true', () => {
    expect(validateAnalyticsEvent({ event: 'match_opened', props: { matchId: '1' }, internal: true })).toMatchObject({ ok: true, internal: true });
    for (const v of [false, 'true', 1, 'yes', null, undefined, {}]) expect([v, 'internal' in validateAnalyticsEvent({ event: 'match_opened', props: {}, internal: v })]).toEqual([v, false]);
    expect(validateAnalyticsEvent({ event: 'match_opened', props: {} })).toEqual({ ok: true, event: 'match_opened', props: {}, anonId: null });
  });

  it('a browser of ours is left out of the funnel whole — also what it did before it was marked — and counted apart', () => {
    const e = (anonId: string, event: string, extra: any = {}) => ({ type: 'analytics', event, props: { matchId: '1' }, anonId, ts: '2026-11-25T02:00:00.000Z', ...extra });
    const ours = 'anon_00000000-0000-4000-8000-000000000001'; const visitor = 'anon_00000000-0000-4000-8000-000000000002';
    const out: any = summarizeFunnel([
      e(ours, 'match_opened'), e(ours, 'review_requested'),            // before it was marked
      e(ours, 'review_ready', { internal: true }), e(ours, 'match_opened', { internal: true }),
      e(visitor, 'match_opened'), e(visitor, 'review_requested'),
    ]);
    expect(out.internal).toEqual({ events: 4, browsers: 1 });
    expect(out.browsers).toMatchObject({ opened: 1, requested: 1, own: 0 });
    expect(out.events).toEqual({ match_opened: 1, review_requested: 1 });
    // With nobody marked the funnel is what it was.
    const plain: any = summarizeFunnel([e(ours, 'match_opened'), e(visitor, 'match_opened')]);
    expect(plain.internal).toEqual({ events: 0, browsers: 0 });
    expect(plain.browsers.opened).toBe(2);
  });

  it('a parse or a review started by one of ours says so in the log line; nothing else about the request changes', async () => {
    const express = createRequire(import.meta.url)('express');
    const lines: string[] = [];
    const service: any = {
      availability: async () => ({ trace: false, can_parse: true, model_configured: true, heroes: [], parse: { status: 'none' } }),
      prepare: async () => ({ status: 'running', stage: 'locating' }),
      status: async () => ({ status: 'none' }),
      start: async () => ({ status: 'running', steps: [] }),
    };
    const app = express(); app.use(express.json());
    app.use(createAgentRouter({ service, resolveClientIp: () => '10.0.0.1', log: (m: string) => lines.push(m) }));
    const server: any = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const real = (globalThis as any).fetch;
    const post = (path: string, body: any, headers: Record<string, string> = {}) => real(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    try {
      expect((await post('/api/agent/9100904020/prepare', {}, { [INTERNAL_HEADER]: '1' })).status).toBe(202);
      expect((await post('/api/agent/9100904020/prepare', {})).status).toBe(202);
      expect((await post('/api/agent/9100904020/review', { hero: 'axe', lang: 'zh' }, { [INTERNAL_HEADER]: '1' })).status).toBe(202);
      expect((await post('/api/agent/9100904020/review', { hero: 'axe', lang: 'zh' }, { [INTERNAL_HEADER]: 'yes' })).status).toBe(202);
    } finally { await new Promise((resolve) => server.close(resolve)); }
    expect(lines).toEqual([
      'parse start match=9100904020 -> running internal',
      'parse start match=9100904020 -> running',
      'review start match=9100904020 hero=axe plan=none -> running internal',
      'review start match=9100904020 hero=axe plan=none -> running',
    ]);
  });
});
