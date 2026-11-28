#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from '../src/index.js';
const args = process.argv.slice(2);
if (args.length > 0) {
  process.stderr.write('Usage: dota2ai-mcp\n');
  process.exitCode = 2;
} else {
  await createMcpServer().connect(new StdioServerTransport());
}
