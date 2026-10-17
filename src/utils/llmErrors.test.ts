import { describe, it, expect, vi } from 'vitest';
import {
  isLlmSdkError,
  logLlmError,
  redactSecrets,
  sanitizeLlmErrorForClient,
} from '../../lib/llmErrors.js';

// Mock credential shapes only — never a real key format/value from any account.
const MOCK_SK_KEY = 'sk-test-mock1234567890abcd';
const MOCK_LONG_TOKEN = 'd41d8cd98f00b204e9800998ecf8427e';
const MOCK_BEARER = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.mocksig';
const MOCK_AIZA_KEY = 'AIzaSyD-mock1234567890abcdefg';

/** openai v4 SDK errors subclass APIError without ever setting `name`. */
class AuthenticationError extends Error {}
class APIConnectionError extends Error {}

describe('redactSecrets', () => {
  it('redacts sk- style keys (OpenAI/DeepSeek)', () => {
    const out = redactSecrets(`401 Incorrect API key provided: ${MOCK_SK_KEY}.`);
    expect(out).not.toContain(MOCK_SK_KEY);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts Authorization Bearer tokens', () => {
    const out = redactSecrets(`request rejected: ${MOCK_BEARER} invalid`);
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIs');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts key= / api_key= / api_key: style params and pairs', () => {
    expect(redactSecrets('GET /v1/chat?key=mockkey12345678 failed')).not.toContain('mockkey12345678');
    expect(redactSecrets('bad api_key=mockkey12345678')).not.toContain('mockkey12345678');
    expect(redactSecrets('config api_key: "mockkey12345678" wrong')).not.toContain('mockkey12345678');
    expect(redactSecrets('token=mocktoken123456 rejected')).not.toContain('mocktoken123456');
  });

  it('redacts Google AIza keys', () => {
    const out = redactSecrets(`Gemini rejected ${MOCK_AIZA_KEY} (key invalid)`);
    expect(out).not.toContain(MOCK_AIZA_KEY);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts masked key tails (…abcd / ****abcd)', () => {
    expect(redactSecrets('key ****abcd is invalid')).not.toContain('abcd');
    expect(redactSecrets('provided key ...wxyz expired')).not.toContain('wxyz');
    expect(redactSecrets('invalid key: sk-mock***ef12')).not.toContain('ef12');
    // Single Unicode ellipsis (U+2026) masking, as providers render it.
    expect(redactSecrets('Incorrect API key: \u2026abcd')).not.toContain('abcd');
  });

  it('redacts long secret-shaped runs without a known prefix', () => {
    expect(redactSecrets(`auth token ${MOCK_LONG_TOKEN} rejected`)).not.toContain(MOCK_LONG_TOKEN);
  });

  it('leaves benign provider/host text intact', () => {
    const benign = 'HTTP 503 Service Unavailable from api.deepseek.com (upstream overloaded)';
    expect(redactSecrets(benign)).toBe(benign);
    expect(redactSecrets('Request timed out after 60000 ms')).toBe('Request timed out after 60000 ms');
  });

  it('caps output length', () => {
    expect(redactSecrets('x'.repeat(5000)).length).toBeLessThanOrEqual(500);
    expect(redactSecrets(null)).toBe('');
  });
});

describe('sanitizeLlmErrorForClient', () => {
  it('returns only the stable code + localized English message', () => {
    expect(sanitizeLlmErrorForClient('en')).toEqual({
      error: 'ai_unavailable',
      message: 'AI service temporarily unavailable',
    });
  });

  it('localizes the message for zh', () => {
    const zh = sanitizeLlmErrorForClient('zh');
    expect(zh.error).toBe('ai_unavailable');
    expect(zh.message).toContain('AI');
    expect(zh.message).toMatch(/[一-鿿]/);
  });

  it('never carries provider text, regardless of the triggering error', () => {
    // Simulated SDK auth failure carrying a mock key tail — the payload shape
    // has nowhere to put it, but pin the invariant for future field additions.
    const err = new AuthenticationError(`401 Incorrect API key provided: ${MOCK_SK_KEY}.`);
    (err as unknown as { status: number }).status = 401;
    for (const lang of ['en', 'zh']) {
      const payload = JSON.stringify(sanitizeLlmErrorForClient(lang));
      expect(payload).not.toContain('sk-');
      expect(payload).not.toContain('Incorrect');
      expect(payload).not.toContain('401');
    }
  });
});

describe('logLlmError', () => {
  it('emits one structured JSON line with provider, status, class, redacted message', () => {
    const sink = vi.fn();
    const err = new AuthenticationError(`401 Incorrect API key provided: ${MOCK_SK_KEY}.`);
    (err as unknown as { status: number }).status = 401;
    const line = logLlmError(sink, { event: 'review_followup_provider_error', provider: 'deepseek', error: err, matchId: 8985182860, failure: 'http_401' });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toBe(line);
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({
      severity: 'WARNING',
      event: 'review_followup_provider_error',
      provider: 'deepseek',
      status: 401,
      errorClass: 'AuthenticationError',
      matchId: 8985182860,
      failure: 'http_401',
    });
    expect(parsed.message).toContain('[REDACTED]');
    expect(parsed.message).not.toContain(MOCK_SK_KEY);
  });

  it('defaults event/severity/status and redacts Bearer + key= shapes', () => {
    const sink = vi.fn();
    const line = logLlmError(sink, {
      provider: 'gemini',
      error: new APIConnectionError(`connect failed ${MOCK_BEARER} at url?key=mockkey123456`),
    });
    const parsed = JSON.parse(line);
    expect(parsed.event).toBe('llm_error');
    expect(parsed.status).toBeNull();
    expect(parsed.errorClass).toBe('APIConnectionError');
    expect(parsed.message).not.toContain('eyJhbGciOiJIUzI1NiIs');
    expect(parsed.message).not.toContain('mockkey123456');
  });
});

describe('isLlmSdkError', () => {
  it('classifies openai SDK subclass instances (which never set name)', () => {
    expect(isLlmSdkError(new AuthenticationError('401'))).toBe(true);
    expect(isLlmSdkError(new APIConnectionError('down'))).toBe(true);
  });

  it('classifies explicitly named API… errors (abort/timeout shapes)', () => {
    expect(isLlmSdkError(Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' }))).toBe(true);
    expect(isLlmSdkError(Object.assign(new Error('timeout'), { name: 'APIConnectionTimeoutError' }))).toBe(true);
  });

  it('does not classify app errors, strings, or nulls', () => {
    expect(isLlmSdkError(new Error('HTTP 500'))).toBe(false);
    expect(isLlmSdkError(Object.assign(new Error('deadline'), { name: 'CompletionDeadlineError' }))).toBe(false);
    expect(isLlmSdkError('APIError')).toBe(false);
    expect(isLlmSdkError(null)).toBe(false);
  });
});

describe('internalErrorForClient + server.js fallthrough guard', () => {
  it('returns a fixed localized payload with nothing error-derived', async () => {
    const { internalErrorForClient } = await import('../../lib/llmErrors.js');
    expect(internalErrorForClient('en')).toEqual({ error: 'internal_error', message: 'Internal Server Error' });
    expect(internalErrorForClient('zh').error).toBe('internal_error');
  });

  it('server.js never echoes error.message / streamErr.message to clients', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'server.js'), 'utf8');
    // Unclassified errors (e.g. SDK SyntaxError with a provider-body excerpt)
    // must take the generic path too.
    expect(src).not.toMatch(/JSON\.stringify\(\{\s*error:\s*error\.message/);
    expect(src).not.toMatch(/json\(\{\s*error:\s*error\.message/);
    expect(src).not.toMatch(/streamErr\.message\s*\|\|/);
    expect(src).not.toMatch(/const errorMsg = error\.message/);
  });

  it('redacts SDK stream-parsing SyntaxErrors (chunk JSON / headers embed credentials)', () => {
    // The openai SDK can throw plain SyntaxError while parsing a malformed
    // stream chunk; the message may quote the raw chunk or request headers.
    const syntaxErr = new SyntaxError(
      `Unexpected token '<' in JSON at position 0 (headers: Bearer ${MOCK_BEARER}, chunk: {"key":"${MOCK_SK_KEY}"})`,
    );
    expect(isLlmSdkError(syntaxErr)).toBe(false); // unclassified — still needs redaction
    const sink = vi.fn();
    const line = logLlmError(sink, { event: 'review_stream_error', matchId: 123, error: syntaxErr });
    const parsed = JSON.parse(line);
    expect(parsed.errorClass).toBe('SyntaxError');
    expect(parsed.message).toContain('[REDACTED]');
    expect(parsed.message).not.toContain('Bearer eyJhbGciOiJIUzI1NiIs');
    expect(parsed.message).not.toContain(MOCK_SK_KEY);
    expect(parsed.message).not.toContain('sk-test-mock');
    expect(redactSecrets(syntaxErr.message)).not.toContain('sk-abc');
  });

  it('server.js routes provider/fetch error logging through redaction (no raw console dumps)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'server.js'), 'utf8');
    // Every call site that used to print the raw error object/message from
    // provider/fetch paths is now a structured logLlmError / redactSecrets line.
    expect(src).not.toMatch(/console\.error\("Suggestions Error:", error\)/);
    expect(src).not.toMatch(/console\.error\('Review suggestions error:', err\)/);
    expect(src).not.toMatch(/console\.error\('Match facts error:', error\)/);
    expect(src).not.toMatch(/console\.error\('OpenDota fetch error:', err\.message\)/);
    expect(src).toMatch(/logLlmError\(console\.error, \{ event: 'suggestions_error', error \}\)/);
    expect(src).toMatch(/logLlmError\(console\.error, \{ event: 'review_suggestions_error', error: err \}\)/);
    expect(src).toMatch(/logLlmError\(console\.error, \{ event: 'match_facts_error', error \}\)/);
    expect(src).toMatch(/console\.error\('OpenDota fetch error:', redactSecrets\(err\?\.message \?\? err\)\)/);
  });
});
