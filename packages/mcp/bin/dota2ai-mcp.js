#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from '../src/index.js';
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--offline') || args.length > 1) {
  process.stderr.write('Usage: dota2ai-mcp [--offline]\n');
  process.exitCode = 2;
} else {
  await createMcpServer({ offline: args.includes('--offline') || process.env.DOTA2AI_OFFLINE === '1' }).connect(new StdioServerTransport());
}
