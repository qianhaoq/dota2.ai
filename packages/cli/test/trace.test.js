import { describe, it, expect, vi } from 'vitest';
import { run } from '../src/cli.js';
import { parseTraceArgs } from '../src/trace.js';
import { TRACE_TOOLS } from '@dota2ai/review-engine';

const FIXTURE = new URL('../../review-engine/test/fixtures/trace-9100904020.json.gz', import.meta.url).pathname;
async function invoke(args) {
  const stdout = { write: vi.fn() }, stderr = { write: vi.fn() };
  const code = await run(args, { stdout, stderr });
  return { code, out: stdout.write.mock.calls.flat().join(''), err: stderr.write.mock.calls.flat().join('') };
}

describe('dota2ai trace', () => {
  it('lists the tools without arguments', async () => {
    const r = await invoke(['trace']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).tools.map((t) => t.name)).toEqual(TRACE_TOOLS.map((t) => t.name));
  });
  it('runs a tool on a trace file and prints its JSON', async () => {
    const r = await invoke(['trace', 'ability_audit', '--trace', FIXTURE, '--hero', 'beastmaster', '--ability', 'primal_roar']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ tool: 'ability_audit', casts_total: 10 });
    const one = await invoke(['trace', 'death_context', '--trace', FIXTURE, '--hero', 'beastmaster', '--index', '9']);
    expect(JSON.parse(one.out).deaths[0].clock).toBe('36:05');
    const fight = await invoke(['trace', 'fight_timeline', '--trace', FIXTURE, '--from', '30:05', '--to', '31:00']);
    expect(JSON.parse(fight.out).events.length).toBeGreaterThan(10);
  });
  it('types arguments from the tool schema', () => {
    const tool = TRACE_TOOLS.find((t) => t.name === 'death_context');
    expect(parseTraceArgs(tool, ['--trace', 'f', '--hero', 'axe', '--index', '2'])).toEqual({ file: 'f', args: { hero: 'axe', index: 2 } });
    for (const bad of [['--trace', 'f'], ['--hero', 'axe'], ['--trace', 'f', '--hero', 'axe', '--index', 'x'], ['--trace', 'f', '--hero', 'axe', '--nope', '1'], ['--trace', 'f', '--hero'], ['x']]) expect(() => parseTraceArgs(tool, bad)).toThrow();
  });
  it('exits 2 on bad input and 3 on an unreadable trace', async () => {
    expect((await invoke(['trace', 'nope', '--trace', FIXTURE])).code).toBe(2);
    expect((await invoke(['trace', 'death_context', '--trace', FIXTURE])).code).toBe(2);
    const unknown = await invoke(['trace', 'death_context', '--trace', FIXTURE, '--hero', 'pudge']);
    expect(unknown.code).toBe(2);
    expect(JSON.parse(unknown.out).error).toBe('unknown_hero');
    expect((await invoke(['trace', 'match_overview', '--trace', '/nonexistent/trace.json.gz'])).code).toBe(3);
    expect((await invoke(['trace', 'match_overview', '--trace', new URL('../package.json', import.meta.url).pathname])).code).toBe(3);
  });
});
