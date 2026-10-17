import { describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAI } from 'openai';
import { installConsoleRedaction } from '../../lib/consoleRedaction.js';

// Mock credential shapes only — never a real key format/value from any account.
const QA_FAKE_KEY = 'sk-qa-fake-ABCD1234';
const QA_FAKE_QUERY_KEY = 'qa-fake-ABCD123456';

function makeConsole() {
  const consoleObj = {
    error: vi.fn(),
    warn: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  return { consoleObj, errorMock: consoleObj.error, warnMock: consoleObj.warn, logMock: consoleObj.log };
}

describe('installConsoleRedaction (unit)', () => {
  it('redacts string, Error, and object arguments before forwarding', () => {
    const { consoleObj, errorMock } = makeConsole();
    const uninstall = installConsoleRedaction(consoleObj);

    consoleObj.error(
      `request rejected: Bearer ${QA_FAKE_KEY}`,
      new Error(`fetch failed for /v1/chat?api_key=${QA_FAKE_QUERY_KEY}`),
      { apiKey: QA_FAKE_KEY },
    );

    expect(errorMock).toHaveBeenCalledTimes(1);
    // The wrapper formats the whole line first, then redacts it as one string.
    const line = String((errorMock.mock.calls[0] as unknown[])[0]);
    expect((errorMock.mock.calls[0] as unknown[]).length).toBe(1);
    expect(line).not.toContain(QA_FAKE_KEY);
    expect(line).not.toContain('ABCD1234');
    expect(line).not.toContain(QA_FAKE_QUERY_KEY);
    expect(line).toContain('[REDACTED]');
    expect(line).toContain('Error: fetch failed');
    expect(line).toContain('at '); // stack retained for debugging

    uninstall();
  });

  it('applies printf-style substitutions before redaction (Codex P1)', () => {
    const { consoleObj, logMock, errorMock } = makeConsole();
    const uninstall = installConsoleRedaction(consoleObj);

    consoleObj.log('count=%d ok=%s', 42, true, null, undefined);
    expect(logMock.mock.calls[0]).toEqual(['count=42 ok=true null undefined']);

    // Credential context in the format string, bare token as a separate arg.
    consoleObj.error('Authorization: Bearer %s', 'eyJhbGciOiJIUzI1NiJ9.qa-fake.sig');
    consoleObj.error('Authorization: %s', 'qafaketoken123456');
    for (const [l] of errorMock.mock.calls as unknown[][]) {
      expect(String(l)).not.toContain('qa-fake');
      expect(String(l)).not.toContain('qafaketoken');
    }
    uninstall();
  });

  it('keeps ordinary ellipsis text intact (Codex P1)', () => {
    const { consoleObj, logMock } = makeConsole();
    const uninstall = installConsoleRedaction(consoleObj);
    consoleObj.log(JSON.stringify({ message: 'Wait...this happens. Please…help' }));
    expect(String(logMock.mock.calls[0][0])).toContain('Wait...this happens. Please…help');
    uninstall();
  });

  it('leaves generic key/token/password prose alone but redacts credential pairs (Codex P1)', () => {
    const { consoleObj, logMock } = makeConsole();
    const uninstall = installConsoleRedaction(consoleObj);
    consoleObj.log(JSON.stringify({ message: 'Use key=escape to close; my password: is long' }));
    expect(String(logMock.mock.calls[0][0])).toContain('Use key=escape to close; my password: is long');
    consoleObj.log(`GET https://api.opendota.com/api/heroes?api_key=${QA_FAKE_QUERY_KEY}&x=1`);
    consoleObj.log(`GET https://example.test/v1?alt=json&key=${QA_FAKE_QUERY_KEY}`);
    for (const call of logMock.mock.calls.slice(1)) {
      expect(String(call[0])).not.toContain(QA_FAKE_QUERY_KEY);
    }
    expect(String(logMock.mock.calls[2][0])).toContain('&key=[REDACTED]');
    uninstall();
  });

  it('redacts generic credential names in structured context (Codex P1)', () => {
    const { consoleObj, errorMock } = makeConsole();
    const uninstall = installConsoleRedaction(consoleObj);
    consoleObj.error('Could not parse message into JSON:', '{"token":"qafaketoken123456"');
    consoleObj.error('cfg', { token: 'qafaketoken123456', password: 'qafakepw123' });
    consoleObj.error('password=qafakepw123 secret=qafakesecret1');
    consoleObj.error(JSON.stringify({ line: JSON.stringify({ key: 'qafakekey98765' }) }));
    for (const [l] of errorMock.mock.calls as unknown[][]) {
      expect(String(l)).not.toMatch(/qafake(token|pw|secret|key)/);
      expect(String(l)).toContain('[REDACTED]');
    }
    uninstall();
  });

  it('bounds serialization of large objects (Codex P2)', () => {
    const { consoleObj, logMock } = makeConsole();
    const uninstall = installConsoleRedaction(consoleObj);
    const rows = Array.from({ length: 10000 }, (_, i) => ({ id: i, name: `row-${i}` }));
    consoleObj.log({ rows });
    expect(String(logMock.mock.calls[0][0]).length).toBeLessThan(5000);
    uninstall();
  });

  it('never throws: circular objects and BigInt values are stringified safely', () => {
    const { consoleObj, warnMock } = makeConsole();
    const uninstall = installConsoleRedaction(consoleObj);

    const circular: Record<string, unknown> = { name: 'cfg' };
    circular.self = circular;
    const withBigInt = { requestId: 123n };
    const withThrowingGetter = {
      get secret() { throw new Error('getter boom'); },
    };

    expect(() => consoleObj.warn(circular, withBigInt, withThrowingGetter)).not.toThrow();
    expect(warnMock).toHaveBeenCalledTimes(1);
    const [circularArg] = warnMock.mock.calls[0] as unknown[];
    expect(String(circularArg)).not.toContain('undefined'); // inspect, not JSON.stringify

    uninstall();
  });

  it('is idempotent: a second install returns the same uninstall, no double-wrap', () => {
    const { consoleObj, errorMock } = makeConsole();
    const uninstall1 = installConsoleRedaction(consoleObj);
    const uninstall2 = installConsoleRedaction(consoleObj);
    expect(uninstall2).toBe(uninstall1);

    consoleObj.error(`Bearer ${QA_FAKE_KEY}`);
    expect(errorMock).toHaveBeenCalledTimes(1);
    expect(String(errorMock.mock.calls[0][0])).toBe('Bearer [REDACTED]');

    uninstall2();
    consoleObj.error(`Bearer ${QA_FAKE_KEY}`);
    // Uninstalled once → the raw argument flows through again.
    expect(errorMock.mock.calls[1][0]).toBe(`Bearer ${QA_FAKE_KEY}`);
  });

  it('uninstall restores every original method', () => {
    const { consoleObj } = makeConsole();
    const originalError = consoleObj.error;
    const originalLog = consoleObj.log;
    const uninstall = installConsoleRedaction(consoleObj);
    expect(consoleObj.error).not.toBe(originalError);

    uninstall();
    expect(consoleObj.error).toBe(originalError);
    expect(consoleObj.log).toBe(originalLog);
  });

  it('only wraps the requested methods', () => {
    const { consoleObj, errorMock, warnMock } = makeConsole();
    const uninstall = installConsoleRedaction(consoleObj, { methods: ['error'] });

    consoleObj.warn(`Bearer ${QA_FAKE_KEY}`);
    expect(warnMock.mock.calls[0][0]).toBe(`Bearer ${QA_FAKE_KEY}`); // untouched
    consoleObj.error(`Bearer ${QA_FAKE_KEY}`);
    expect(String(errorMock.mock.calls[0][0])).toBe('Bearer [REDACTED]');
    uninstall();
  });
});

describe('installConsoleRedaction (Codex P1/P2: no truncation, structured fields intact)', () => {
  it('keeps a long feedback JSON record complete and valid', () => {
    const { consoleObj, logMock } = makeConsole();
    const uninstall = installConsoleRedaction(consoleObj);
    const record = { event: 'feedback_submitted', id: '3f2b8c1e-9a7d-4e21-b0c4-5d6e7f8a9b0c', message: 'x '.repeat(2000) };
    const line = JSON.stringify(record);
    consoleObj.log(line);
    const out = logMock.mock.calls[0][0];
    expect(out).toBe(line);
    expect(JSON.parse(out)).toEqual(record);
    uninstall();
  });

  it('does not redact event names or UUIDs but still redacts credentials', () => {
    const { consoleObj, warnMock } = makeConsole();
    const uninstall = installConsoleRedaction(consoleObj);
    consoleObj.warn(JSON.stringify({
      event: 'review_followup_fallback',
      other: 'review_ai_provider_error',
      requestId: '3f2b8c1e-9a7d-4e21-b0c4-5d6e7f8a9b0c',
      detail: `Bearer ${QA_FAKE_KEY}`,
    }));
    const out = warnMock.mock.calls[0][0];
    expect(out).toContain('review_followup_fallback');
    expect(out).toContain('review_ai_provider_error');
    expect(out).toContain('3f2b8c1e-9a7d-4e21-b0c4-5d6e7f8a9b0c');
    expect(out).not.toContain('ABCD1234');
    uninstall();
  });
});

describe('installConsoleRedaction × real openai SDK (malformed SSE chunk regression)', () => {
  it('keeps the SDK console.error output but strips the leaked key from it', async () => {
    // Spy on the ORIGINAL console.error first, then install the redaction
    // wrapper on top: the SDK calls console.error, the wrapper redacts, and
    // the spy records exactly what would have reached stdout.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const uninstall = installConsoleRedaction(console);

    // Local SSE endpoint answering with an unparsable chunk that embeds the
    // auth material, exactly like a provider echoing back a malformed body.
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      res.write(`data: {"bad json Bearer ${QA_FAKE_KEY} \n\n`);
      res.end();
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;

      const client = new OpenAI({
        apiKey: QA_FAKE_KEY,
        baseURL: `http://127.0.0.1:${port}/v1`,
        maxRetries: 0,
      });
      const stream = await client.chat.completions.create({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });

      // The SDK throws the JSON SyntaxError after logging the raw chunk.
      await expect(async () => {
        for await (const _chunk of stream) { /* drain the real stream */ }
      }).rejects.toThrow();

      const logged = errorSpy.mock.calls.map((args) => args.map((a) => String(a)).join(' ')).join('\n');
      expect(logged).toContain('Could not parse message into JSON');
      expect(logged).not.toContain(QA_FAKE_KEY);
      expect(logged).not.toContain('ABCD1234');
    } finally {
      uninstall();
      errorSpy.mockRestore();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
  });
});
