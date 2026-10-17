import { describe, it, expect, vi } from 'vitest';
import { jsonBodyErrorHandler } from '../../lib/jsonBodyErrors.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Pure unit test (no supertest dependency): drive the 4-arg error handler with
// mock req/res/next exactly as Express would after a body-parser failure.
type Res = { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
const makeRes = (): Res => {
  const res = { } as unknown as Res;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};
const makeReq = (opts: { query?: Record<string, unknown>, acceptLanguage?: string } = {}) => ({
  query: opts.query ?? {},
  headers: opts.acceptLanguage != null ? { 'accept-language': opts.acceptLanguage } : {},
});
const parseFailed = { type: 'entity.parse.failed', message: 'Unexpected token } in JSON at position 12', body: '{"bad":' };

describe('jsonBodyErrorHandler (entity.parse.failed → 400 invalid_json)', () => {
  it('returns a 400 JSON payload with the localized English message by default', () => {
    const res = makeRes();
    jsonBodyErrorHandler(parseFailed, makeReq(), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'invalid_json',
      message: 'Request body is not valid JSON',
    });
  });

  it('localizes to zh when the query lang=zh', () => {
    const res = makeRes();
    jsonBodyErrorHandler(parseFailed, makeReq({ query: { lang: 'zh' } }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'invalid_json', message: '请求体不是合法的 JSON' });
  });

  it('localizes to zh for zh-* query values and Accept-Language: zh…', () => {
    for (const req of [
      makeReq({ query: { lang: 'zh-CN' } }),
      makeReq({ acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8' }),
      makeReq({ acceptLanguage: 'zh' }),
    ]) {
      const res = makeRes();
      jsonBodyErrorHandler(parseFailed, req, res, vi.fn());
      expect(res.json).toHaveBeenCalledWith({ error: 'invalid_json', message: '请求体不是合法的 JSON' });
    }
    // Non-zh Accept-Language stays English.
    const res = makeRes();
    jsonBodyErrorHandler(parseFailed, makeReq({ query: { lang: 'en' }, acceptLanguage: 'en-US,en;q=0.9' }), res, vi.fn());
    expect(res.json).toHaveBeenCalledWith({ error: 'invalid_json', message: 'Request body is not valid JSON' });
  });

  it('never echoes the request body or the parser message', () => {
    const res = makeRes();
    jsonBodyErrorHandler(parseFailed, makeReq(), res, vi.fn());
    const payload = JSON.stringify(res.json.mock.calls[0][0]);
    expect(payload).not.toContain('Unexpected token');
    expect(payload).not.toContain('{"bad"');
  });
});

describe('jsonBodyErrorHandler (entity.too.large → 413)', () => {
  it('returns a 413 JSON payload without echoing anything error-derived', () => {
    const res = makeRes();
    const err = { type: 'entity.too.large', message: 'request entity too large', limit: 102400, length: 999999 };
    jsonBodyErrorHandler(err, makeReq({ query: { lang: 'zh' } }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({ error: 'payload_too_large', message: '请求体过大' });
    const resEn = makeRes();
    jsonBodyErrorHandler(err, makeReq(), resEn, vi.fn());
    expect(resEn.json).toHaveBeenCalledWith({ error: 'payload_too_large', message: 'Request body is too large' });
  });
});

describe('jsonBodyErrorHandler (pass-through)', () => {
  it('forwards non-body-parser errors and missing errors to next(err)', () => {
    for (const err of [
      new Error('route blew up'),               // no err.type
      { type: 'charset.unsupported' },          // other body-parser type
      null,
      undefined,
      'string error',
    ]) {
      const next = vi.fn();
      jsonBodyErrorHandler(err, makeReq(), makeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith(err);
    }
  });
});

describe('jsonBodyErrorHandler (server.js wiring)', () => {
  it('is registered right after express.json()', () => {
    const src = readFileSync(join(__dirname, '../../server.js'), 'utf8');
    const jsonIdx = src.indexOf('app.use(express.json());');
    const handlerIdx = src.indexOf('app.use(jsonBodyErrorHandler);');
    expect(jsonIdx).toBeGreaterThanOrEqual(0);
    expect(handlerIdx).toBeGreaterThan(jsonIdx);
    // No other app.use/middleware registration sits between the two.
    expect(src.slice(jsonIdx, handlerIdx)).not.toMatch(/app\.use\((?!express\.json|jsonBodyErrorHandler)/);
  });
});
