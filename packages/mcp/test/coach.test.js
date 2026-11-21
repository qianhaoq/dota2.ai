import { it, expect, describe } from 'vitest';
import { readFileSync } from 'node:fs';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpServer, attachMcp } from '../src/index.js';
import { buildCoachReport } from '../../../lib/coach/analyze.js';
import { buildCaseStudies } from '../../../lib/coach/cases.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../../../src/fixtures/coach/${f}`, import.meta.url), 'utf8'));
const raw = load('match9091400302.parsed.json');
const later = load('match9094562824.parsed.json');
const report = buildCoachReport(raw);
const profiles = load('cases.tidehunter-vs-ursa.profiles.json').profiles;

/** The coach API shape (packages/cli/src/coachApi.js) over the fixtures. */
const coach = {
  report: async (id) => {
    if (String(id) === '9091400302') return report;
    if (String(id) === '9094562824') return buildCoachReport(later);
    throw Object.assign(new Error('Match not found'), { code: 'NOT_FOUND' });
  },
  cases: async (_id, seat) => buildCaseStudies({ report, slot: seat, match: raw, candidates: profiles }),
  recent: async (account) => ({ account_id: Number(account), matches: [{ match_id: 9091400302, slot: 0 }] }),
  ask: async (_id, seat, question) => ({ text: `answer about seat ${seat}: ${question}`, fallback: true, notice: 'from the report' }),
};

async function connect(options) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ review: async () => ({}), ...options });
  await server.connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  return client;
}
const call = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return r.isError ? { error: r.content[0].text } : r.structuredContent;
};

describe('coach MCP tools (stdio)', () => {
  it('lists the coach tools next to the v1 review tools', async () => {
    const client = await connect({ coach });
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['coach_ask', 'coach_cases', 'coach_report', 'get_evidence', 'goal_check', 'recent_matches', 'review_match']);
  });

  it('coach_report: roster without a hero, the causes with one', async () => {
    const client = await connect({ coach });
    const roster = await call(client, 'coach_report', { match_id: 9091400302 });
    expect(roster.roster).toHaveLength(10);
    expect(roster.note).toMatch(/never guess/);
    const why = await call(client, 'coach_report', { match_id: 9091400302, hero: 'tidehunter', section: 'why' });
    expect(why.section).toBe('why');
    expect(new Set(why.value.map((c) => c.id))).toEqual(new Set(report.reviews[0].chapters.story.why.map((c) => c.id)));
    expect(why.value[0].mine).toBe(true);
    expect(why.url).toBe('https://dota2.ai/r/9091400302?p=0');
    const all = await call(client, 'coach_report', { match_id: 9091400302, hero: 29, section: 'all' });
    expect(all.schema).toBe('dota2.ai/coach-report@1');
    expect(all.player.hero.id).toBe(29);
  });

  it('cases, ask and goal_check work on the chosen seat; errors are explicit', async () => {
    const client = await connect({ coach });
    expect((await call(client, 'coach_cases', { match_id: 9091400302, hero: 'tidehunter' })).themes.map((t) => t.key)).toEqual(['deaths', 'fights', 'laning']);
    expect((await call(client, 'coach_ask', { match_id: 9091400302, hero: 'tidehunter', question: 'why?' })).text).toBe('answer about seat 0: why?');
    const goal = report.reviews[0].findings.find((f) => f.goal).goal;
    const check = await call(client, 'goal_check', { match_id: 9094562824, hero: 'hoodwink', goal });
    expect(['met', 'missed', 'no_opportunity', 'unknown']).toContain(check.result);
    expect(check.match_id).toBe(9094562824);
    expect((await call(client, 'coach_cases', { match_id: 9091400302 })).error).toMatch(/hero/); // schema: hero required
    expect((await call(client, 'coach_report', { match_id: 9091400302, hero: 'axe' })).error).toMatch(/not in this match/);
    expect((await call(client, 'coach_report', { match_id: 1 })).error).toMatch(/not found/);
    expect((await call(client, 'recent_matches', { account: '42' })).matches).toHaveLength(1);
  });
});

it('the shared HTTP /mcp keeps to the review tools (one IP must not carry every agent\'s coach calls)', async () => {
  const app = express();
  app.use(express.json());
  attachMcp(app, { reviewForRequest: () => async () => ({}) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const client = new Client({ name: 't', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['get_evidence', 'review_match']);
    await client.close();
  } finally {
    server.close();
  }
});
