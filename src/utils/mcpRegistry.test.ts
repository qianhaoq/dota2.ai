import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MCP_URL } from '../coach/accessSnippets';

/**
 * server.json is what the official MCP registry lists (registry.modelcontextprotocol.io, read by other
 * directories); glama.json claims the repo on Glama. Published by hand with `mcp-publisher publish`.
 */
const read = (p: string) => JSON.parse(readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));

describe('MCP registry listing', () => {
  it('names the hosted endpoint the site advertises, within the registry\'s limits', () => {
    const s = read('server.json');
    expect(s.$schema).toBe('https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
    expect(s.name).toMatch(/^io\.github\.qianhaoq\/[a-zA-Z0-9._-]+$/);
    expect(s.description.length).toBeLessThanOrEqual(100);
    expect(s.remotes).toEqual([{ type: 'streamable-http', url: MCP_URL }]);
    // The version the server reports in initialize (packages/mcp) is the one listed.
    expect(s.version).toBe(read('packages/mcp/package.json').version);
    expect(readFileSync(new URL('../../packages/mcp/src/index.js', import.meta.url), 'utf8')).toContain(`version: '${s.version}'`);
  });

  it('glama.json names the repo\'s maintainer', () => {
    expect(read('glama.json')).toEqual({ $schema: 'https://glama.ai/mcp/schemas/server.json', maintainers: ['qianhaoq'] });
  });
});
