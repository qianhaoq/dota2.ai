import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createToolHandlers, createMcpServer } from '../src/index.js';
import { createV1Router } from '../../../routes/v1/index.js';
import { buildReview, validateReview } from '@dota2ai/review-engine';
const raw = JSON.parse(gunzipSync(readFileSync(new URL('../../review-engine/test/fixtures/gold/9035042364.json.gz', import.meta.url))));
const now = () => '2026-01-01T00:00:00.000Z';
const args = { match_id: raw.match_id, hero: 'pudge' };
it('includes referenced learning context separately from verified match facts', async () => {
  const snapshot = JSON.parse(readFileSync(new URL('../../review-engine/test/fixtures/site-knowledge.json', import.meta.url)));
  const result = buildReview(raw,{heroId:14,lang:'en',fetchedAt:now(),kb:snapshot.entries});
  const tools = createToolHandlers({review:async()=>result});
  const evidence = await tools.get_evidence({...args,insight_id:'next_game'});
  const context = Object.values(evidence.contextual_facts);
  expect(context).toHaveLength(1);
  expect(context[0].value).toMatchObject({title:snapshot.entries[0].title,summary:snapshot.entries[0].summary,locator:snapshot.entries[0].locator,verification:'material_linked_not_independently_verified'});
  expect(Object.keys(evidence.facts).some(id=>id.startsWith('kb.'))).toBe(false);
  expect((await tools.get_evidence({...args,insight_id:'turning_point'})).contextual_facts).toBeUndefined();
});
it('handlers return the full engine review and only referenced facts/citations', async () => {
  const tools = createToolHandlers({ fetchMatch: async () => raw, now });
  const review = await tools.review_match(args);
  expect(validateReview(review).ok).toBe(true);
  expect(review).toEqual(buildReview(raw, { heroId: 14, lang: 'en', fetchedAt: now(), presetFollowups: true }));
  for (const insight of review.insights) {
    const evidence = await tools.get_evidence({ ...args, insight_id: insight.id });
    expect(evidence).toEqual({ insight, facts: Object.fromEntries(insight.fact_ids.map(id => [id, review.facts[id]])), evidence: insight.evidence, citations: review.citations.filter(c => insight.citations.includes(c.id)), data_gap: insight.data_gap });
  }
  await expect(tools.get_evidence({ ...args, insight_id: 'missing' })).rejects.toThrow('Unknown insight_id');
  await expect(tools.get_evidence({ match_id: raw.match_id, insight_id: 'fix_this' })).rejects.toThrow('Hero is required');
});
it('SDK lists tools, returns structured reviews, and reports tool errors cleanly', async () => {
  const server = createMcpServer({ fetchMatch: async () => raw });
  const client = new Client({ name: 'test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(left); await client.connect(right);
    // v1 review tools, then the coach tools (stdio / in-process servers only).
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['review_match', 'get_evidence', 'recent_matches', 'coach_report', 'coach_cases', 'coach_ask', 'goal_check', 'hero_matchup']);
    const result = await client.callTool({ name: 'review_match', arguments: args });
    expect(validateReview(result.structuredContent).ok).toBe(true);
    const error = await client.callTool({ name: 'get_evidence', arguments: { ...args, insight_id: 'bad' } });
    expect(error.isError).toBe(true); expect(error.content[0].text).toBe('Unknown insight_id');
  } finally { await client.close(); await server.close(); }
});
it('stdio bin speaks MCP without stdout diagnostics', async () => {
  const client = new Client({ name: 'stdio-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL('../bin/dota2ai-mcp.js', import.meta.url).pathname, '--offline'] }));
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['review_match', 'get_evidence', 'recent_matches', 'coach_report', 'coach_cases', 'coach_ask', 'goal_check', 'hero_matchup']);
  } finally { await client.close(); }
});
it('remote /mcp initializes, lists tools and uses injected fetchMatch', async () => {
  const app = express(); app.use(express.json());
  let calls = 0;
  app.use(createV1Router({ fetchMatch: async () => { calls++; return raw; } }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const client = new Client({ name: 'http-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    expect((await client.listTools()).tools).toHaveLength(2);
    const result = await client.callTool({ name: 'review_match', arguments: args });
    expect(validateReview(result.structuredContent).ok).toBe(true); expect(calls).toBe(1);
    const evidence = await client.callTool({ name: 'get_evidence', arguments: { ...args, insight_id: 'turning_point' } });
    expect(evidence.structuredContent.insight.id).toBe('turning_point');
    const cached = await (await fetch(new URL('/api/v1/review/9035042364?hero=pudge', url))).json();
    expect(cached.meta.cache).toBe('hit'); expect(calls).toBe(1);
    const invalid = await client.callTool({ name: 'review_match', arguments: { match_id: 'bad' } });
    expect(invalid.isError).toBe(true); expect(calls).toBe(1);
    // API and MCP misses share the same per-IP budget (one miss above).
    for (let id = 1; id <= 29; id++) {
      const response = await fetch(new URL(`/api/v1/review/${id}`, url));
      expect(response.status).toBe(200);
    }
    const limited = await client.callTool({ name: 'review_match', arguments: { match_id: 30 } });
    expect(limited.isError).toBe(true); expect(calls).toBe(30);
    expect((await fetch(url)).status).toBe(405);
  } finally { await client.close(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); }
});
it('remote /mcp handles CORS, JSON-only Accept headers, and 404s /mcp/.well-known/* subpaths', async () => {
  const app = express(); app.use(express.json());
  app.use(createV1Router({ fetchMatch: async () => raw }));
  // Mirror server.js SPA catch-all to prove /mcp/* subpaths never return index.html.
  app.get('*', (_req, res) => res.type('text/html').send('<!DOCTYPE html><p>spa</p>'));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const initBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'compat', version: '1' } } });
  try {
    // Browser / Inspector preflight and CORS headers.
    const pre = await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { Origin: 'https://inspector.example' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');

    // Clients sending Accept: application/json, */*, or omitting Accept work in stateless JSON mode.
    for (const accept of ['application/json', '*/*', 'application/*', null]) {
      const headers = { 'Content-Type': 'application/json', ...(accept ? { Accept: accept } : {}) };
      const r = await fetch(`${base}/mcp`, { method: 'POST', headers, body: initBody });
      expect(r.status, String(accept)).toBe(200);
      expect(r.headers.get('access-control-allow-origin'), String(accept)).toBe('*');
      const data = await r.json();
      expect(data.result.serverInfo.name).toBe('dota2ai');
    }

    // Explicitly non-JSON Accept headers are still rejected with 406.
    for (const bad of ['text/plain', 'text/html', 'application/json;q=0, */*;q=1']) {
      const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: bad }, body: initBody });
      expect(r.status, bad).toBe(406);
    }

    // OAuth/OpenID discovery probes under /mcp/.well-known/* must return 404 JSON, never 200 HTML.
    for (const p of ['/mcp/.well-known/oauth-protected-resource', '/mcp/.well-known/openid-configuration', '/mcp/sse']) {
      const r = await fetch(`${base}${p}`);
      expect(r.status, p).toBe(404);
      expect(r.headers.get('content-type'), p).toMatch(/application\/json/);
      expect(r.headers.get('cache-control'), p).toBe('no-store');
      expect(await r.text(), p).not.toContain('<!DOCTYPE');
    }
  } finally { await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); }
});
