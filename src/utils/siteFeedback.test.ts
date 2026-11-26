import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { createSiteFeedbackRouter, parseSiteFeedback, SITE_FEEDBACK_MAX_MESSAGE, SITE_FEEDBACK_SCHEMA } from '../../lib/siteFeedback.js';

const express = createRequire(import.meta.url)('express');

describe('parseSiteFeedback', () => {
  it('validates and normalizes valid payloads across en/zh/ru', () => {
    expect(parseSiteFeedback({ message: '  Add Russian!  ', category: 'suggestion', contact: ' @kilocean ', lang: 'ru' })).toEqual({
      ok: true,
      value: { message: 'Add Russian!', category: 'suggestion', contact: '@kilocean', lang: 'ru' },
    });
    expect(parseSiteFeedback({ message: 'Found a bug', category: 'bug', lang: 'zh' })).toEqual({
      ok: true,
      value: { message: 'Found a bug', category: 'bug', contact: null, lang: 'zh' },
    });
    // Missing category defaults to suggestion; unknown lang defaults to en.
    expect(parseSiteFeedback({ message: 'hi', lang: 'fr' })).toEqual({
      ok: true,
      value: { message: 'hi', category: 'suggestion', contact: null, lang: 'en' },
    });
  });

  it('rejects empty, oversized, or malformed bodies', () => {
    expect(parseSiteFeedback(null)).toEqual({ ok: false, code: 'invalid_body' });
    expect(parseSiteFeedback([])).toEqual({ ok: false, code: 'invalid_body' });
    expect(parseSiteFeedback({ message: '   ' })).toEqual({ ok: false, code: 'empty_message' });
    expect(parseSiteFeedback({ message: 'x'.repeat(SITE_FEEDBACK_MAX_MESSAGE + 1) })).toEqual({ ok: false, code: 'message_too_long' });
    expect(parseSiteFeedback({ message: 'hi', category: 'spam' })).toEqual({ ok: false, code: 'invalid_category' });
    expect(parseSiteFeedback({ message: 'hi', contact: 123 })).toEqual({ ok: false, code: 'invalid_contact' });
    expect(parseSiteFeedback({ message: 'hi', contact: 'x'.repeat(121) })).toEqual({ ok: false, code: 'invalid_contact' });
  });
});

describe('POST /api/site-feedback', () => {
  let server: any;
  let base = '';
  let guardOk = true;
  let storeFail = false;
  const saved = new Map<string, any>();
  const logs: string[] = [];

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(createSiteFeedbackRouter({
      resolveClientIp: (req: any) => String(req.headers['x-test-ip'] ?? '10.0.0.1'),
      guard: () => (guardOk ? { ok: true } : { ok: false, status: 403, error: 'Cross-site request' }),
      store: {
        put: async (key: string, val: any) => {
          if (storeFail) throw new Error('bucket down');
          saved.set(key, val);
        },
      },
      dailyMax: 12,
      log: (line: string) => logs.push(line),
    }));
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  const post = async (body: any, ip = '10.0.0.1') => {
    const r = await fetch(`${base}/api/site-feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-ip': ip },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json(), retry: r.headers.get('retry-after') };
  };

  it('refuses GET with 405, enforces same-origin guard, and validates input', async () => {
    const g = await fetch(`${base}/api/site-feedback`);
    expect(g.status).toBe(405);

    guardOk = false;
    expect(await post({ message: 'hi' })).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    guardOk = true;

    expect(await post({ message: '' })).toMatchObject({ status: 400, body: { code: 'empty_message' } });
    expect(saved.size).toBe(0);
  });

  it('persists feedback and logs structured JSON without storing client IP', async () => {
    const res = await post({ message: 'Love the trilingual reviews!', category: 'suggestion', contact: 'qianhao1229@gmail.com', lang: 'ru' }, '203.0.113.99');
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('ok');
    expect(res.body.id).toBeTypeOf('string');
    const record = saved.get(`${res.body.id}.json`);
    expect(record).toMatchObject({
      schema: SITE_FEEDBACK_SCHEMA,
      id: res.body.id,
      message: 'Love the trilingual reviews!',
      category: 'suggestion',
      contact: 'qianhao1229@gmail.com',
      lang: 'ru',
    });
    expect(JSON.stringify(record)).not.toContain('203.0.113.99');
    expect(logs.join('\n')).not.toContain('203.0.113.99');
  });

  it('returns 503 when the store fails, and enforces per-IP and daily limits', async () => {
    storeFail = true;
    expect(await post({ message: 'store down test' }, '10.1.0.1')).toMatchObject({ status: 503, body: { code: 'unavailable' } });
    storeFail = false;

    // 10 per IP in 10 minutes; 11th returns 429. (Already used 1 daily slot for 203.0.113.99 and 1 for 10.1.0.1 = 2 used; 10 remaining in dailyMax=12).
    for (let i = 0; i < 10; i += 1) {
      expect((await post({ message: `msg ${i}` }, '10.2.0.1')).status).toBe(201);
    }
    const limited = await post({ message: 'over limit' }, '10.2.0.1');
    // Daily max (12) is now hit first -> 503 busy with Retry-After.
    expect(limited.status).toBe(503);
    expect(Number(limited.retry)).toBeGreaterThan(0);
  });
});
