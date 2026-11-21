import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createDraftRequestBoundary } from '../../lib/draftRequest.js';
import { createSlidingWindowLimiter } from '../../lib/rateLimiter.js';
import { createLlmRateLimit } from '../../lib/llmRateLimit.js';

const uiHero = { id: 1, name: 'Anti-Mage', nameEn: 'Anti-Mage', nameZh: '敌法师',
  aliases: ['am'], attribute: 'Agility', roles: ['Carry', 'Escape'], rolesZh: ['核心'],
  img: '/heroes/antimage.png', imgFallback: 'https://cdn.example/antimage.jpg', icon: '/icon.png' };
async function harness(perIp = 12, global = 600, llmQuota = 100) {
  const resolveClientIp = (req: any) => req.headers['x-test-client'] || '203.0.113.1';
  const boundary = createDraftRequestBoundary({ resolveClientIp,
    limiter: createSlidingWindowLimiter({ limit: perIp, globalLimit: global, windowMs: 60_000 }) });
  const llm = createLlmRateLimit({ resolveClientIp, log: vi.fn(),
    limiter: createSlidingWindowLimiter({ limit: llmQuota, windowMs: 60_000 }) });
  const upstream = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  const completion = vi.fn(async () => 'stub completion');
  // Exercise the extracted production handler boundary directly. All IO
  // beyond admission is stubbed; no listening socket or provider is needed.
  return { upstream, completion, post: (kind: string, body: unknown, headers = {}) => new Promise<Response>((resolve, reject) => {
    const req = { body: JSON.parse(JSON.stringify(body)), headers };
    let status = 200;
    const responseHeaders = new Headers();
    const res = {
      setHeader(key: string, value: string) { responseHeaders.set(key, value); },
      status(code: number) { status = code; return this; },
      json(payload: unknown) {
        responseHeaders.set('Content-Type', 'application/json');
        resolve(new Response(JSON.stringify(payload), { status, headers: responseHeaders }));
      },
    };
    boundary(kind)(req, res, () => {
      (async () => {
        await upstream();
        if ('x-fallback' in headers) return res.json({ fallback: true });
        const gate = llm.acquire(req);
        if (!gate.ok) return llm.respondRateLimited(req, res, gate.retryAfterSec);
        return res.json({ text: await completion() });
      })().catch(reject);
    });
  }) };
}

it('registers the boundary before both production handlers', () => {
  const source = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
  for (const kind of ['analyze', 'playbook']) {
    expect(source).toContain(`app.post('/api/${kind}', draftRequestBoundary('${kind}'), async (req, res) => {`);
  }
});

for (const kind of ['analyze', 'playbook']) {
  const team = kind === 'analyze' ? 'radiant' : 'allies';
  const other = kind === 'analyze' ? 'dire' : 'enemies';
  const valid = { [team]: [uiHero], [other]: [{ id: 2 }], lang: 'zh',
    ...(kind === 'analyze' ? { userContext: '练习对线 / lane practice' } : { side: 'dire', focusHeroId: 1 }) };
  describe(`${kind} actual request boundary`, () => {
    it('rejects the 70KB amplification body before any upstream or LLM IO', async () => {
      const h = await harness();
      const response = await h.post(kind, { [team]: Array.from({ length: 5000 }, (_, i) => ({ id: 100000 + i })) });
      expect(response.status).toBe(400);
      expect(h.upstream).not.toHaveBeenCalled();
      expect(h.completion).not.toHaveBeenCalled();
    });
    it('validates IDs, team cardinality, duplicates and bounded field shapes without burning LLM quota', async () => {
      const h = await harness(12, 600, 1);
      const malformed = [null, [], 'bad', { [team]: null }, { [team]: {} }, { [team]: 'x' },
        ...[0, -1, 99999, 1.5, '1', null].map((id) => ({ [team]: [{ id }] })),
        { [team]: [null] }, { [team]: [[]] }, { [team]: [1] },
        { ...valid, [other]: {} }, { ...valid, [other]: [null] },
        { [team]: [1, 2, 3, 4, 5, 6].map((id) => ({ id })) },
        { [team]: [{ id: 1 }, { id: 1 }] }, { [team]: [{ id: 1 }], [other]: [{ id: 1 }] },
        { [team]: [{ id: 1, name: {} }] }, { [team]: [{ id: 1, img: 'x'.repeat(513) }] }, { [team]: [{ id: 1, roles: ['x'.repeat(129)] }] },
        { [team]: [{ id: 1, aliases: Array(33).fill('x') }] },
        { ...valid, lang: {} }, { ...valid, unexpected: {} },
        ...(kind === 'analyze' ? [{ ...valid, userContext: {} }, { ...valid, userContext: 'x'.repeat(2001) }]
          : [{ ...valid, focusHeroId: 2 }, { ...valid, side: {} }])];
      for (const body of malformed) expect((await h.post(kind, body)).status).toBe(400);
      expect(h.upstream).not.toHaveBeenCalled();
      expect(h.completion).not.toHaveBeenCalled();
      expect((await h.post(kind, valid)).status).toBe(200);
      expect(h.completion).toHaveBeenCalledTimes(1);
    });
    it('throttles before upstream work and returns JSON + Retry-After even for SSE', async () => {
      const h = await harness(1);
      expect((await h.post(kind, valid)).status).toBe(200);
      const rejected = await h.post(kind, valid, { accept: 'text/event-stream' });
      expect(rejected.status).toBe(429);
      expect(Number(rejected.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(rejected.headers.get('content-type')).toContain('application/json');
      expect(h.upstream).toHaveBeenCalledTimes(1);
      expect(h.completion).toHaveBeenCalledTimes(1);
    });
    it('admits concurrent attempts atomically within the client budget', async () => {
      const h = await harness(2);
      const responses = await Promise.all(Array.from({ length: 20 }, () => h.post(kind, valid)));
      expect(responses.filter((r) => r.status === 200)).toHaveLength(2);
      expect(responses.filter((r) => r.status === 429)).toHaveLength(18);
      expect(h.upstream).toHaveBeenCalledTimes(2);
      expect(h.completion).toHaveBeenCalledTimes(2);
    });
    it('charges fallback work only to request admission, preserving completion budget', async () => {
      const h = await harness(12, 600, 1);
      expect((await h.post(kind, valid, { 'x-fallback': '1' })).status).toBe(200);
      expect((await h.post(kind, valid)).status).toBe(200);
      expect(h.completion).toHaveBeenCalledTimes(1);
    });
  });
}

it('shares a global work budget across endpoints and concurrent distinct clients', async () => {
  const h = await harness(12, 3);
  const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => h.post(
    i % 2 ? 'analyze' : 'playbook', i % 2 ? { radiant: [{ id: 1 }] } : { allies: [{ id: 2 }] },
    { 'x-test-client': `203.0.113.${i + 1}` },
  )));
  expect(responses.filter((r) => r.status === 200)).toHaveLength(3);
  expect(responses.filter((r) => r.status === 429)).toHaveLength(17);
  expect(h.upstream).toHaveBeenCalledTimes(3);
});

it('accepts full five-versus-five UI lineups and partial enemy-only Analyze', async () => {
  const h = await harness();
  const first = [1, 2, 3, 4, 5].map((id) => ({ ...uiHero, id }));
  const second = [6, 7, 8, 9, 10].map((id) => ({ ...uiHero, id }));
  expect((await h.post('analyze', { radiant: first, dire: second, lang: 'en' })).status).toBe(200);
  expect((await h.post('playbook', { allies: first, enemies: second, side: 'radiant', focusHeroId: 5 })).status).toBe(200);
  expect((await h.post('analyze', { dire: [{ id: 2 }] })).status).toBe(200);
  expect((await h.post('playbook', { allies: [{ id: 1 }] })).status).toBe(200);
  expect(h.completion).toHaveBeenCalledTimes(4);
});
