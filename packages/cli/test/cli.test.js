import { describe, it, expect, vi } from 'vitest';
import { HELP, run } from '../src/cli.js';
import { normalizeInput } from '../src/client.js';

async function invoke(args, options = {}) {
  const stdout = { write: vi.fn() };
  const stderr = { write: vi.fn() };
  const code = await run(args, { stdout, stderr, ...options });
  return { code, out: stdout.write.mock.calls.flat().join(''), err: stderr.write.mock.calls.flat().join('') };
}

describe('CLI dispatch & input helpers', () => {
  it('prints help for help/--help/-h/empty args', async () => {
    for (const args of [[], ['help'], ['--help'], ['-h']]) {
      const res = await invoke(args);
      expect(res.code).toBe(0);
      expect(res.out).toContain(HELP);
      expect(res.err).toBe('');
    }
  });

  it('rejects unknown or retired commands with exit 2', async () => {
    for (const cmd of ['review', 'unknown']) {
      const res = await invoke([cmd, '9035042364']);
      expect(res.code).toBe(2);
      expect(res.err).toContain(`Unknown command: ${cmd}`);
    }
  });

  it('normalizes match IDs, heroes and languages and rejects malformed inputs', () => {
    expect(normalizeInput({ match_id: '9035042364', hero: 'pudge', lang: 'zh' })).toEqual({
      matchId: 9035042364,
      heroId: 14,
      lang: 'zh',
    });
    expect(normalizeInput({ match_id: 9035042364 })).toEqual({
      matchId: 9035042364,
      heroId: undefined,
      lang: 'en',
    });
    for (const bad of [
      { match_id: '0' },
      { match_id: '1.5' },
      { match_id: '1099511627777' },
      { match_id: '1', hero: 'nope' },
      { match_id: '1', lang: 'fr' },
    ]) {
      expect(() => normalizeInput(bad)).toThrow();
    }
  });
});
