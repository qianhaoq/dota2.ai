import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { ALTERNATIVES, createAgentRouter } from '../../lib/agent/router.js';
import { replayReview } from '../../lib/agent/replayTool.js';
import { createSlots } from '../../lib/agent/slots.js';
import { withDailyCap } from '../../lib/llmRateLimit.js';

const express = createRequire(import.meta.url)('express');
const MATCH = '9100904020';

/** A service whose review starts go through the router's admission, and whose stored reviews are free to read. */
function fakeService(stored = new Set<string>()) {
  const started: string[] = [];
  const service: any = {
    availability: async () => ({ trace: true, model_configured: true, can_parse: false, heroes: [{ hero: 'beastmaster' }, { hero: 'axe' }] }),
    status: async (_m: string, hero: string) => ({ status: stored.has(hero) ? 'done' : 'none' }),
    start: async (_m: string, hero: string, _l: string, o: any) => {
      const refusal = o.admit();
      if (refusal) return { status: 'refused', refusal };
      started.push(hero);
      return { status: 'running' };
    },
    chat: async () => ({ status: 'ok', text: 'x', unverified: [] }),
  };
  return { service, started };
}

async function serve(router: any) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const at = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = async (path: string, body: object, ip: string) => {
    const r = await fetch(`${at}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-ip': ip }, body: JSON.stringify(body) });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* an event stream */ }
    return { status: r.status, body: json, text, retryAfter: r.headers.get('retry-after') };
  };
  return { post, close: () => new Promise((r) => srv.close(r)) };
}

const ipOf = (req: any) => String(req.headers?.['x-test-ip'] ?? '10.0.0.1');

describe('the day\'s ceiling on reviews this site pays for', () => {
  it('refuses past it with daily_cap and the ways to run on your own model; a stored review is still served', async () => {
    const { service, started } = fakeService(new Set(['axe']));
    const router = createAgentRouter({ service, resolveClientIp: ipOf, llm: { acquire: () => ({ ok: true }) }, reviewDailyMax: 2 });
    const s = await serve(router);
    try {
      expect((await s.post(`/api/agent/${MATCH}/review`, { hero: 'beastmaster', lang: 'en' }, '10.1.0.1')).status).toBe(202);
      expect((await s.post(`/api/agent/${MATCH}/review`, { hero: 'beastmaster', lang: 'zh' }, '10.1.0.2')).status).toBe(202);
      const third = await s.post(`/api/agent/${MATCH}/review`, { hero: 'beastmaster', lang: 'ru' }, '10.1.0.3');
      expect(third.status).toBe(503);
      expect(third.body).toMatchObject({ code: 'daily_cap', alternatives: ALTERNATIVES });
      expect(third.body.retryAfterSec).toBeGreaterThan(3600);
      expect(Number(third.retryAfter)).toBe(third.body.retryAfterSec);
      // Already written: read for free, past the ceiling.
      expect(await s.post(`/api/agent/${MATCH}/review`, { hero: 'axe', lang: 'en' }, '10.1.0.4')).toMatchObject({ status: 200, body: { status: 'done' } });
      expect(started).toHaveLength(2);
    } finally { await s.close(); }
  });

  it('a refused start takes nothing: neither model budget nor a place in the day', async () => {
    const { service, started } = fakeService();
    let budget: any = { ok: false, reason: 'cost_guard' };
    let acquired = 0;
    const router = createAgentRouter({ service, resolveClientIp: ipOf, llm: { acquire: () => { acquired += 1; return budget; } }, reviewDailyMax: 1 });
    const s = await serve(router);
    try {
      const busy = await s.post(`/api/agent/${MATCH}/review`, { hero: 'beastmaster', lang: 'en' }, '10.2.0.1');
      expect(busy).toMatchObject({ status: 503, body: { code: 'busy', alternatives: ALTERNATIVES } });
      budget = { ok: true };
      expect((await s.post(`/api/agent/${MATCH}/review`, { hero: 'beastmaster', lang: 'en' }, '10.2.0.1')).status).toBe(202);
      // The day is full now: the next is refused before the model budget is asked.
      expect((await s.post(`/api/agent/${MATCH}/review`, { hero: 'beastmaster', lang: 'zh' }, '10.2.0.2')).body.code).toBe('daily_cap');
      expect([acquired, started.length]).toEqual([2, 1]);
    } finally { await s.close(); }
  });

  it('MCP replay_review counts on the same day as the page, and its refusal names the DSH plugin', async () => {
    const { service } = fakeService();
    const router = createAgentRouter({ service, resolveClientIp: ipOf, llm: { acquire: () => ({ ok: true }) }, reviewDailyMax: 1 });
    const s = await serve(router);
    try {
      expect((await s.post(`/api/agent/${MATCH}/review`, { hero: 'beastmaster', lang: 'en' }, '10.3.0.1')).status).toBe(202);
      const api = router.forRequest({ headers: { 'x-test-ip': '10.3.0.2' } });
      await expect(replayReview(api, { match_id: MATCH, hero: 'axe', lang: 'en' })).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        message: expect.stringMatching(/used up.*DeepSeek Harness \(DSH\): https:\/\/dota2\.ai\/#ways-dsh/),
      });
    } finally { await s.close(); }
  });

  it('the review chat stops at its own daily count, shared with what server.js passes', async () => {
    const { service } = fakeService();
    const chatDaily = createSlots({ limit: 1, windowMs: 86_400_000 });
    const router = createAgentRouter({ service, resolveClientIp: ipOf, llm: { acquire: () => ({ ok: true }) }, chatDaily });
    const s = await serve(router);
    try {
      expect((await s.post(`/api/agent/${MATCH}/chat`, { hero: 'beastmaster', question: 'q' }, '10.4.0.1')).status).toBe(200);
      expect(await s.post(`/api/agent/${MATCH}/chat`, { hero: 'beastmaster', question: 'q' }, '10.4.0.2')).toMatchObject({ status: 503, body: { code: 'daily_cap' } });
      expect(chatDaily.full('all')).toBe(true);
    } finally { await s.close(); }
  });

  it('the review hour is tunable', async () => {
    const { service } = fakeService();
    const router = createAgentRouter({ service, resolveClientIp: ipOf, llm: { acquire: () => ({ ok: true }) }, reviewHourlyMax: 1 });
    const s = await serve(router);
    try {
      expect((await s.post(`/api/agent/${MATCH}/review`, { hero: 'beastmaster', lang: 'en' }, '10.5.0.1')).status).toBe(202);
      expect((await s.post(`/api/agent/${MATCH}/review`, { hero: 'beastmaster', lang: 'zh' }, '10.5.0.2')).body.code).toBe('busy');
    } finally { await s.close(); }
  });
});

describe('withDailyCap', () => {
  it('answers as the cost guard past the day, and counts only what was let through', () => {
    const daily = createSlots({ limit: 2, windowMs: 86_400_000 });
    let next: any = { ok: true };
    const inner = { acquire: () => next, respondRateLimited: () => 'limited' };
    const capped = withDailyCap(inner, daily);
    expect(capped.acquire({})).toEqual({ ok: true });
    next = { ok: false, reason: 'rate_limited', retryAfterSec: 5 };
    expect(capped.acquire({})).toEqual(next);
    next = { ok: true };
    expect(capped.acquire({})).toEqual({ ok: true });
    expect(capped.acquire({})).toMatchObject({ ok: false, reason: 'cost_guard' });
    expect(capped.respondRateLimited).toBe(inner.respondRateLimited);
  });
});
