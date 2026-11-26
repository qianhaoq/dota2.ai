import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * dota2.ai's deep replay review runs only on the server (it fetches and parses
 * the replay, then the coach agent goes through it), so the plugin asks the
 * hosted MCP endpoint's `replay_review` for it — the same tool, wording and
 * per-caller limits an MCP client gets. A call never blocks for minutes: it
 * returns `parsing` / `reviewing` with `poll_after_sec`, and the model calls
 * again (lib/agent/replayTool.js).
 *
 * Errors: `REMOTE_TOOL` carries the server's own fixed wording (it already
 * hides upstream detail); anything else is a transport failure.
 */
export function createReplayClient({ apiBase = 'https://dota2.ai', headers = {}, version = '0', connect } = {}) {
  const endpoint = new URL('/mcp', apiBase);
  const open = connect ?? (async () => {
    const client = new Client({ name: 'dsh-dota2ai', version });
    await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers } }));
    return client;
  });
  return {
    async review(args, { signal } = {}) {
      let client;
      try {
        client = await open();
        const result = await client.callTool({ name: 'replay_review', arguments: args }, undefined, signal ? { signal } : undefined);
        if (result.isError) {
          const text = result.content?.find((c) => c.type === 'text')?.text ?? 'Replay review request failed';
          throw Object.assign(new Error(text), { code: 'REMOTE_TOOL' });
        }
        if (result.structuredContent) return result.structuredContent;
        const text = result.content?.find((c) => c.type === 'text')?.text;
        return JSON.parse(text);
      } finally {
        await client?.close?.().catch(() => {});
      }
    },
  };
}
