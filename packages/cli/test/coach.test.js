import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildCoachReport } from '../../../lib/coach/analyze.js';
import { parseCoachArgs, findSlot, renderCoach, runCoach } from '../src/coach.js';

const report = buildCoachReport(JSON.parse(readFileSync(new URL('../../../src/fixtures/coach/match9091400302.unparsed.json', import.meta.url), 'utf8')));
const sink = () => { let s = ''; return { write: (x) => { s += x; }, get text() { return s; } }; };

describe('dota2ai coach', () => {
  it('parses arguments strictly', () => {
    expect(parseCoachArgs(['coach', '9091400302', '--hero', 'spectre', '--lang', 'zh', '--json'])).toEqual({ matchId: '9091400302', hero: 'spectre', lang: 'zh', json: true });
    expect(() => parseCoachArgs(['coach', 'x'])).toThrow(/Usage/);
    expect(() => parseCoachArgs(['coach', '1', '--lang', 'fr'])).toThrow(/Language/);
  });

  it('finds a hero by slug, English name, Chinese name or id', () => {
    const s = findSlot(report, 'spectre');
    expect(findSlot(report, 'Spectre')).toBe(s);
    expect(findSlot(report, '幽鬼')).toBe(s);
    expect(findSlot(report, String(report.players[s].hero.id))).toBe(s);
    expect(() => findSlot(report, 'axe')).toThrow(/not in this match/);
  });

  it('renders the read with questions and the parse gap', () => {
    const text = renderCoach(report, findSlot(report, 'spectre'), 'en');
    expect(text).toContain('Dire victory 34–75');
    expect(text).toContain('Ask yourself:');
    expect(text).toContain('Not parsed yet');
  });

  it('maps HTTP outcomes to exit codes', async () => {
    const reply = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });
    const out = sink(); const err = sink();
    expect(await runCoach(['coach', '9091400302', '--json'], { stdout: out, stderr: err, env: {}, fetchImpl: reply(200, report) })).toBe(0);
    expect(JSON.parse(out.text).match.id).toBe(9091400302);
    expect(await runCoach(['coach', '9091400302'], { stdout: out, stderr: err, env: {}, fetchImpl: reply(404, { error: 'nf' }) })).toBe(3);
    expect(await runCoach(['coach', '9091400302'], { stdout: out, stderr: err, env: {}, fetchImpl: reply(502, { error: 'up' }) })).toBe(4);
    expect(await runCoach(['coach', 'nope'], { stdout: out, stderr: err, env: {} })).toBe(2);
  });
});
