# @dota2ai/mcp

```sh
npx -p @dota2ai/mcp dota2ai-mcp
npx -p @dota2ai/mcp dota2ai-mcp --offline
```

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
