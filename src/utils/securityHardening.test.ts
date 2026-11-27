import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { asyncHandler, internalErrorHandler } from '../../lib/asyncHandler.js';
import { createAgentRouter } from '../../lib/agent/router.js';
import { createTraceStore, MAX_TRACE_JSON_BYTES } from '../../lib/agent/stores.js';
import { securityHeaders } from '../../routes/v1/support.js';
import { createDshTracePipeline, MAX_TRACE_GZIP_BYTES, normalizeTraceGzip } from '../../packages/dsh/src/traceSource.js';

const express = createRequire(import.meta.url)('express');

async function withServer(setup: (app: any) => void, run: (base: string) => Promise<void>) {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.json());
  setup(app);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    await run(base);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

describe('Express 4 async error handling and global error handler', () => {
  it('forwards rejected promises from async routes to internalErrorHandler without leaking error details', async () => {
    const logs: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => { unhandled.push(err); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await withServer(
        (app) => {
          app.use(createAgentRouter({
            service: {
              availability: async () => { throw new Error('secret-db-connection-string'); },
              prepare: async () => ({ status: 'ready' }),
              status: async () => ({ status: 'none' }),
              start: async () => ({ status: 'none' }),
              chat: async () => ({ status: 'ok', text: '' }),
              evidence: async () => ({ status: 'ok' }),
              moment: async () => ({ status: 'ok' }),
            },
            resolveClientIp: () => '10.0.0.1',
          }));
          app.get('/boom', asyncHandler(async () => { throw new TypeError('internal-secret-detail'); }));
          app.use(internalErrorHandler({ log: (m) => logs.push(m) }));
        },
        async (base) => {
          const r1 = await fetch(`${base}/api/agent/9100904020`);
          expect(r1.status).toBe(500);
          expect(await r1.json()).toEqual({ code: 'internal_error', error: 'Internal Server Error' });

          const r2 = await fetch(`${base}/boom`);
          expect(r2.status).toBe(500);
          const body2 = await r2.text();
          expect(JSON.parse(body2)).toEqual({ code: 'internal_error', error: 'Internal Server Error' });
          expect(body2).not.toContain('internal-secret-detail');
          expect(logs.join('\n')).not.toContain('secret-db-connection-string');
          expect(logs.join('\n')).not.toContain('internal-secret-detail');
          expect(logs).toEqual([
            '[express] unhandled error GET /api/agent/9100904020: Error',
            '[express] unhandled error GET /boom: TypeError',
          ]);
        },
      );
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('Security headers and container/workflow hardening', () => {
  it('enforces CSP with Google Fonts, sets X-Frame-Options: DENY, and hides X-Powered-By', async () => {
    await withServer(
      (app) => {
        app.get('/ok', (_req: any, res: any) => res.json({ ok: true }));
      },
      async (base) => {
        const res = await fetch(`${base}/ok`);
        expect(res.headers.get('content-security-policy-report-only')).toBeNull();
        const csp = res.headers.get('content-security-policy') ?? '';
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).toContain("object-src 'none'");
        expect(csp).toContain('https://fonts.googleapis.com');
        expect(csp).toContain('https://fonts.gstatic.com');
        expect(res.headers.get('x-frame-options')).toBe('DENY');
        expect(res.headers.get('x-powered-by')).toBeNull();
      },
    );
  });

  it('Dockerfile runs production container as non-root user node', () => {
    const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toMatch(/^\s*USER\s+node\s*$/m);
  });

  it('server.js disables x-powered-by and registers internalErrorHandler', () => {
    const srv = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
    expect(srv).toContain("app.disable('x-powered-by')");
    expect(srv).toContain('app.use(internalErrorHandler())');
  });

  it('ai-review.yml builds JSON via jq instead of raw heredoc interpolation', () => {
    const yml = readFileSync(new URL('../../.github/workflows/ai-review.yml', import.meta.url), 'utf8');
    expect(yml).toContain('jq -n');
    expect(yml).not.toContain('Review PR: ${PR_TITLE}');
  });
});

describe('Bounded trace decompression and download limits', () => {
  it('normalizeTraceGzip rejects gzip bombs and oversized buffers', () => {
    const valid = gzipSync(Buffer.from(JSON.stringify({ schema: 'dota2.ai/match-trace@1', match_id: 9100904020 })));
    expect(normalizeTraceGzip(valid, 9100904020)).toBeInstanceOf(Buffer);

    // Highly compressible payload exceeding maxJsonBytes (simulates a gzip bomb).
    const bomb = gzipSync(Buffer.alloc(2 * 1024 * 1024, 0x61));
    expect(() => normalizeTraceGzip(bomb, 9100904020, { maxJsonBytes: 64 * 1024 })).toThrow();

    // Compressed buffer exceeding maxGzipBytes.
    expect(() => normalizeTraceGzip(valid, 9100904020, { maxGzipBytes: 10 })).toThrow('trace_too_large');
    expect(MAX_TRACE_GZIP_BYTES).toBe(10 * 1024 * 1024);
  });

  it('createDshTracePipeline rejects oversized streamed trace downloads as too_large', async () => {
    let putCalled = false;
    const traceStore = { get: async () => null, put: async () => { putCalled = true; } };
    const fetchImpl = async (url: string) => {
      if (url.endsWith('/api/agent/9100904020')) {
        return { ok: true, status: 200, json: async () => ({ trace: true, trace_outdated: false }) };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': String(MAX_TRACE_JSON_BYTES + 1) }),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };
    const pipe = createDshTracePipeline({ apiBase: 'https://dota2.ai', fetchImpl: fetchImpl as any, traceStore: traceStore as any, getMatchDetail: undefined, workRoot: undefined });
    const out = await pipe.run('9100904020');
    expect(out).toEqual({ ok: false, reason: 'too_large' });
    expect(putCalled).toBe(false);
  });

  it('createTraceStore returns null instead of crashing on a gzip bomb', async () => {
    // 33 MB of zeros compresses to ~33 KB, exceeding MAX_TRACE_JSON_BYTES (32 MB) on gunzip.
    const bomb = gzipSync(Buffer.alloc(MAX_TRACE_JSON_BYTES + 1024 * 1024, 0));
    const store = createTraceStore({ get: async () => bomb, put: async () => {} });
    expect(await store.get('9100904020')).toBeNull();
    expect(await store.raw('9100904020')).toBeNull();
  });
});
