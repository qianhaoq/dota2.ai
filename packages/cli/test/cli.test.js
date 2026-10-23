import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildReview, validateReview } from '@dota2ai/review-engine';
import { parseArgs, run } from '../src/cli.js';
import { createReviewClient } from '../src/client.js';
const raw = JSON.parse(gunzipSync(readFileSync(new URL('../../review-engine/test/fixtures/gold/9035042364.json.gz', import.meta.url))));
const now = () => '2026-01-01T00:00:00.000Z';
async function invoke(args, options = {}) {
  const stdout = { write: vi.fn() }, stderr = { write: vi.fn() };
  const code = await run(args, { stdout, stderr, ...options });
  return { code, out: stdout.write.mock.calls.flat().join(''), err: stderr.write.mock.calls.flat().join('') };
}
const args = ['review', '9035042364', '--hero', 'pudge', '--json'];
describe('CLI', () => {
  it('parses defaults, IDs and options; rejects malformed inputs', () => {
    expect(parseArgs(args)).toMatchObject({ hero: 'pudge', lang: 'en', offline: false, json: true });
    for (const input of [[], ['review', '0'], ['review', '1.5'], ['review', '1099511627777'], ['review', '1', '--hero'], ['review', '1', '--hero', 'nope'], ['review', '1', '--lang', 'fr'], ['review', '1', '--bad'], ['review', '1', '--json', '--json']]) expect(() => parseArgs(input)).toThrow();
  });
  for (const hero of ['pudge', '14']) it(`offline ${hero} matches engine with no LLM environment reads`, async () => {
    const env = new Proxy({}, { get: (_, name) => { if (name !== 'OPENDOTA_API_KEY') throw new Error(`Unexpected environment read: ${String(name)}`); } });
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => raw }));
    const result = await invoke(['review', '9035042364', '--hero', hero, '--json', '--offline'], { env, fetchImpl, now });
    expect(result.code).toBe(0);
    const review = JSON.parse(result.out);
    expect(validateReview(review)).toEqual({ ok: true, errors: [] });
    expect(review).toEqual(buildReview(raw, { heroId: 14, lang: 'en', fetchedAt: now(), presetFollowups: true }));
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://api.opendota.com/api/matches/9035042364');
    expect(result.err).toBe('');
  });
  it('calls the configured API and prints the exact JSON or human summary', async () => {
    const review = buildReview(raw, { heroId: 14, lang: 'zh', fetchedAt: now() });
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => review }));
    const result = await invoke(args, { env: { DOTA2AI_API_BASE: 'http://localhost:1234' }, fetchImpl });
    expect(JSON.parse(result.out)).toEqual(review);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://localhost:1234/api/v1/review/9035042364?hero=14&lang=en');
    const summary = await invoke(args.filter(a => a !== '--json'), { fetchImpl });
    expect(summary.out).toContain('pudge:');
    for (const insight of review.insights) expect(summary.out).toContain(insight.claim.text);
  });
  it('uses an optional OpenDota key only on offline requests', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => raw }));
    await createReviewClient({ offline: true, env: { OPENDOTA_API_KEY: 'test-only' }, fetchImpl })({ match_id: 1 });
    expect(fetchImpl.mock.calls[0][0].searchParams.get('api_key')).toBe('test-only');
  });
  it('maps input errors, insufficient and unparsed states', async () => {
    expect((await invoke(['review', 'bad'])).code).toBe(2);
    const insufficient = { ...raw, players: [] };
    expect((await invoke([...args, '--offline'], { fetchMatch: async () => insufficient })).code).toBe(3);
    expect((await invoke([...args, '--offline'], { fetchMatch: async () => ({ match_id: 1, players: [] }) })).code).toBe(0);
  });
  for (const [code, status, expected] of [['INVALID_INPUT', 400, 2], ['MATCH_NOT_FOUND', 404, 4], ['UPSTREAM_TIMEOUT', 504, 4], ['RATE_LIMITED', 429, 4], ['INTERNAL', 500, 4]]) it(`maps ${code}`, async () => {
    const result = await invoke(args, { fetchImpl: async () => ({ ok: false, status, json: async () => ({ code }) }) });
    expect(result.code).toBe(expected); expect(result.out).toBe(''); expect(result.err).not.toBe('');
  });
  it('maps fetch, timeout, invalid JSON and invalid review errors to 4', async () => {
    for (const fetchImpl of [async () => { throw new Error('fetch failed'); }, async () => { throw new DOMException('timeout', 'TimeoutError'); }, async () => ({ ok: true, json: async () => { throw new Error('bad JSON'); } }), async () => ({ ok: true, json: async () => ({}) })]) expect((await invoke(args, { fetchImpl })).code).toBe(4);
  });
});
