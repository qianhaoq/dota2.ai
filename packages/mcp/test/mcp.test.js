import { it, expect } from 'vitest';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { attachMcp, createMcpServer } from '../src/index.js';

it('SDK lists coach tools and reports unknown-hero errors cleanly', async () => {
  const server = createMcpServer({ coach: { report: async () => { throw Object.assign(new Error('Match not found'), { code: 'NOT_FOUND' }); } } });
  const client = new Client({ name: 'test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(left);
    await client.connect(right);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      'recent_matches', 'coach_report', 'coach_cases', 'coach_ask', 'goal_check', 'hero_matchup',
    ]);
    const error = await client.callTool({ name: 'coach_report', arguments: { match_id: 1 } });
    expect(error.isError).toBe(true);
    expect(error.content[0].text).toBe('Match not found');
  } finally {
    await client.close();
    await server.close();
  }
});

it('stdio bin speaks MCP without stdout diagnostics', async () => {
  const client = new Client({ name: 'stdio-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL('../bin/dota2ai-mcp.js', import.meta.url).pathname] }));
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      'recent_matches', 'coach_report', 'coach_cases', 'coach_ask', 'goal_check', 'hero_matchup',
    ]);
  } finally {
    await client.close();
  }
});

it('remote /mcp handles CORS, JSON-only Accept headers, 405 on GET/DELETE, and 404s /mcp/.well-known/* subpaths', async () => {
  const app = express();
  app.use(express.json());
  attachMcp(app);
  // Mirror server.js SPA catch-all to prove /mcp/* subpaths never return index.html.
  app.get('*', (_req, res) => res.type('text/html').send('<!DOCTYPE html><p>spa</p>'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const initBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'compat', version: '1' } } });
  try {
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    expect((await fetch(`${base}/mcp`, { method: 'DELETE' })).status).toBe(405);

    const pre = await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { Origin: 'https://inspector.example' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');

    for (const accept of ['application/json', '*/*', 'application/*', null]) {
      const headers = { 'Content-Type': 'application/json', ...(accept ? { Accept: accept } : {}) };
      const r = await fetch(`${base}/mcp`, { method: 'POST', headers, body: initBody });
      expect(r.status, String(accept)).toBe(200);
      expect(r.headers.get('access-control-allow-origin'), String(accept)).toBe('*');
      const data = await r.json();
      expect(data.result.serverInfo.name).toBe('dota2ai');
    }

    for (const bad of ['text/plain', 'text/html', 'application/json;q=0, */*;q=1']) {
      const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: bad }, body: initBody });
      expect(r.status, bad).toBe(406);
    }

    for (const p of ['/mcp/.well-known/oauth-protected-resource', '/mcp/.well-known/openid-configuration', '/mcp/sse']) {
      const r = await fetch(`${base}${p}`);
      expect(r.status, p).toBe(404);
      expect(r.headers.get('content-type'), p).toMatch(/application\/json/);
      expect(r.headers.get('cache-control'), p).toBe('no-store');
      expect(await r.text(), p).not.toContain('<!DOCTYPE');
    }
  } finally {
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  }
});
