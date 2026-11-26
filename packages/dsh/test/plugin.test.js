import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '@dota2ai/mcp';
import { createCoachHandlers } from 'dota2ai/handlers';
import { TOOL_DOCS } from 'dota2ai/tools';
import { buildCoachReport } from '../../../lib/coach/analyze.js';
import { PARAMETERS, TOOL_NAMES, toolOptions } from '../src/tools.js';
import { createReplayClient } from '../src/replay.js';
import { SKILL, headersFor, skillBody, skillRegistration } from '../src/skill.js';
import { buildPlugin } from '../scripts/build.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../../src/fixtures/coach/match9091400302.parsed.json', import.meta.url), 'utf8'));
const report = buildCoachReport(fixture);
/** The coach API shape (packages/cli/src/coachApi.js) over a fixture. */
const fixtureCoach = {
  report: async (id) => {
    if (String(id) === '9091400302') return report;
    throw Object.assign(new Error('Match not found'), { code: 'NOT_FOUND' });
  },
};

const unusedReplay = { review: async () => { throw new Error('not called'); } };
const byName = (tools) => Object.fromEntries(tools.map((t) => [t.name, t]));

/** An MCP client on an in-memory server, as the hosted endpoint is built (replay_review only). */
async function mcpClient(options) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ review: async () => ({}), coachTools: false, ...options });
  await server.connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  return client;
}

describe('DSH tool definitions', () => {
  it('offers the replay review and the six coach tools, prefixed so the dota_* coach plugin can sit next to it', () => {
    const tools = toolOptions({ coach: {}, replay: unusedReplay });
    expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    expect(TOOL_NAMES).toEqual(['dota2ai_replay_review', 'dota2ai_recent_matches', 'dota2ai_coach_report', 'dota2ai_coach_cases', 'dota2ai_coach_ask', 'dota2ai_goal_check', 'dota2ai_hero_matchup']);
    for (const t of tools) {
      expect(t.description).toBe(TOOL_DOCS[t.name.replace('dota2ai_', '')].description);
      expect(t.timeoutMs).toBeGreaterThan(0);
      expect(t.output.render({}, { a: 1 })).toEqual([{ type: 'text', text: '{"a":1}' }]);
    }
  });

  it('takes the same arguments as the MCP tools, with the same ones required and the same words', async () => {
    const client = await mcpClient({ coachTools: true, coach: fixtureCoach, replay: unusedReplay });
    const mcp = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t]));
    for (const [name, params] of Object.entries(PARAMETERS)) {
      const schema = mcp[name].inputSchema;
      expect(mcp[name].description).toBe(TOOL_DOCS[name].description);
      expect(Object.keys(params).sort(), name).toEqual(Object.keys(schema.properties).sort());
      const required = Object.entries(params).filter(([, p]) => p.required).map(([k]) => k).sort();
      expect(required, name).toEqual([...(schema.required ?? [])].sort());
      for (const [k, p] of Object.entries(params)) {
        if (schema.properties[k].description) expect(p.description, `${name}.${k}`).toBe(schema.properties[k].description);
      }
    }
  });

  it('answers in the configured language when the call names none, and keeps the one it names', async () => {
    const seen = [];
    const coach = { coach_cases: async (args) => { seen.push(args.lang); return { ok: 1 }; } };
    const tools = byName(toolOptions({ coach, replay: unusedReplay, lang: 'zh' }));
    await tools.dota2ai_coach_cases.execute({ match_id: 1, hero: 'ursa' });
    await tools.dota2ai_coach_cases.execute({ match_id: 1, hero: 'ursa', lang: 'en' });
    expect(seen).toEqual(['zh', 'en']);
  });

  it('returns what the shared coach handlers return (the MCP shapes)', async () => {
    const tools = byName(toolOptions({ coach: createCoachHandlers({ coach: fixtureCoach }), replay: unusedReplay }));
    const roster = await tools.dota2ai_coach_report.execute({ match_id: 9091400302 });
    expect(roster.roster).toHaveLength(10);
    expect(roster.note).toMatch(/never guess/);
    const why = await tools.dota2ai_coach_report.execute({ match_id: 9091400302, hero: roster.roster[0].hero.slug, section: 'why' });
    expect(why.section).toBe('why');
    expect(why.url).toMatch(/^https:\/\/dota2\.ai\/r\/9091400302\?p=/);
  });

  it('fails with our own words: known codes keep theirs, anything else hides the raw message', async () => {
    const thrower = (error) => async () => { throw error; };
    const coach = {
      recent_matches: thrower(Object.assign(new Error('dota2.ai request failed'), { code: 'UPSTREAM' })),
      coach_report: thrower(Object.assign(new Error('Match not found'), { code: 'NOT_FOUND' })),
      hero_matchup: thrower(new Error('ECONNRESET 10.0.0.1:443 secret upstream body')),
    };
    const tools = byName(toolOptions({ coach, replay: unusedReplay }));
    await expect(tools.dota2ai_recent_matches.execute({ account: '1' })).rejects.toThrow('dota2.ai request failed (temporary; retry later)');
    await expect(tools.dota2ai_coach_report.execute({ match_id: 1 })).rejects.toThrow('Match not found');
    await expect(tools.dota2ai_hero_matchup.execute({ hero: 'a', vs: 'b' })).rejects.toThrow(/^Coach request failed$/);
  });
});

describe('replay_review through the hosted MCP tool', () => {
  it('relays every status the server gives, call after call, with the arguments as given', async () => {
    const calls = [];
    const states = [
      { status: 'parsing', match_id: '42', poll_after_sec: 20 },
      { status: 'pick_hero', match_id: '42', heroes: [{ hero: 'ursa', team: 'radiant', en: 'Ursa', zh: '熊战士' }] },
      { status: 'reviewing', match_id: '42', hero: 'ursa', lang: 'zh', steps: 3, poll_after_sec: 20 },
      { status: 'ready', match_id: '42', hero: 'ursa', lang: 'zh', verdict: 'v', findings: [], blind_spots: [], url: 'https://dota2.ai/r/42?hero=ursa&lang=zh' },
    ];
    const replay = createReplayClient({ connect: () => mcpClient({ replay: { review: async (args) => { calls.push(args); return states[calls.length - 1]; } } }) });
    const tool = byName(toolOptions({ coach: {}, replay, lang: 'zh' })).dota2ai_replay_review;
    const seen = [];
    for (let i = 0; i < states.length; i++) seen.push(await tool.execute({ match_id: 42, hero: 'ursa' }, { signal: new AbortController().signal }));
    expect(seen.map((s) => s.status)).toEqual(['parsing', 'pick_hero', 'reviewing', 'ready']);
    expect(seen[3]).toEqual(states[3]);
    expect(calls[0]).toEqual({ match_id: 42, hero: 'ursa', lang: 'zh' });
  });

  it("passes the server's own refusal through, and hides a transport failure", async () => {
    const limited = Object.assign(new Error('Too many reviews started by this caller; try again in 60 s.'), { code: 'RATE_LIMITED' });
    const refusing = createReplayClient({ connect: () => mcpClient({ replay: { review: async () => { throw limited; } } }) });
    const tool = byName(toolOptions({ coach: {}, replay: refusing })).dota2ai_replay_review;
    await expect(tool.execute({ match_id: 42, hero: 'ursa' })).rejects.toThrow('Too many reviews started by this caller; try again in 60 s.');

    const down = createReplayClient({ connect: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:443'); } });
    const tool2 = byName(toolOptions({ coach: {}, replay: down })).dota2ai_replay_review;
    await expect(tool2.execute({ match_id: 42 })).rejects.toThrow(/^Replay review request failed \(temporary; retry later\)$/);
  });
});

describe('skill', () => {
  it('registers SKILL.md without its frontmatter, and it names every tool the plugin offers', () => {
    const reg = skillRegistration();
    expect(reg.name).toBe(SKILL.name);
    expect(reg.source).toBe('runtime');
    expect(reg.content.startsWith('# dota2.ai coach')).toBe(true);
    for (const name of TOOL_NAMES) expect(reg.content, name).toContain(name);
    expect(skillBody('---\nname: x\n---\n\n# Body\n')).toBe('# Body\n');
    expect(skillBody('# No frontmatter\n')).toBe('# No frontmatter\n');
  });

  it('marks requests internal only when asked', () => {
    expect(headersFor({ DOTA2AI_INTERNAL: '1' })).toEqual({ 'X-Dota2ai-Internal': '1' });
    expect(headersFor({})).toEqual({});
  });
});

describe('bundle', () => {
  it('carries the workspace code and leaves only the DSH packages to the host', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-dota2ai-build-'));
    try {
      const out = await buildPlugin({ outfile: join(dir, 'index.js') });
      const code = readFileSync(out, 'utf8');
      const bare = [...code.matchAll(/^import [^;]*? from "([^".][^"]*)";$/gm)].map((m) => m[1]).filter((s) => !s.startsWith('node:'));
      expect([...new Set(bare)].sort()).toEqual(['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery']);
      expect(code).not.toMatch(/from "dota2ai\//);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
