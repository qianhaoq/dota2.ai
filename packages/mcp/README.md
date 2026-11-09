# @dota2ai/mcp

This package and its workspace dependencies are not published on npm yet.
From a repository checkout with Node >=20.10:

```sh
npm ci
node packages/mcp/bin/dota2ai-mcp.js
# Or: node packages/mcp/bin/dota2ai-mcp.js --offline
```

For a local MCP client, set `command` to `node` and `args` to the checkout's
`packages/mcp/bin/dota2ai-mcp.js` path (resolved by the client).

Stdio defaults to the public API. Set `DOTA2AI_API_BASE` to override its origin.
`--offline` or `DOTA2AI_OFFLINE=1` uses OpenDota + template phrasing without keys.
Optional: `OPENDOTA_API_KEY`. Stdout is reserved for MCP protocol messages.

Tools:

- `review_match({match_id, hero?, lang?})`: full Review JSON.
- `get_evidence({match_id, hero, insight_id})`: insight, referenced facts,
  evidence, citations and data gap.

`lang` defaults to `en` and also accepts `zh`; hero accepts a slug or numeric ID.
Tool failures return MCP `isError` responses.

`createMcpServer(options)` creates the SDK server. `attachMcp(expressApp, options)`
mounts stateless Streamable HTTP at `/mcp` (override with `path`). Mount
`express.json()` first. Supply `fetchMatch` to use a local template pipeline,
or `reviewForRequest(req, res)` returning a review function to reuse an existing
pipeline. Each request gets a fresh transport; GET and DELETE return 405.
The application server shares the API's fetch concurrency, cache and rate limits.
