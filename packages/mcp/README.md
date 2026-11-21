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

### Add it to your agent

- **Claude Code**: `claude mcp add dota2ai -- node /absolute/path/to/packages/mcp/bin/dota2ai-mcp.js`
- **Any MCP client** (JSON config):
  ```json
  { "mcpServers": { "dota2ai": { "command": "node", "args": ["/absolute/path/to/packages/mcp/bin/dota2ai-mcp.js"] } } }
  ```
- Pair it with the skill `packages/cli/skills/dota2ai-coach/SKILL.md` (how to
  read the results, workflows, what never to do).

Coach tools (local stdio server; same public API and shapes as the `dota2ai` CLI):

- `recent_matches({account})`: a player's recent public games; `account` is a
  Steam friend code or a Steam/OpenDota/Dotabuff/STRATZ profile link.
- `coach_report({match_id, hero?, section?, lang?})`: without `hero`, the roster
  (ask the user which hero was theirs). `section`: `summary` (default), `why`,
  `lane`, `deaths`, `items`, `fights`, `plan`, `all`.
- `coach_cases({match_id, hero})`: pro games on the same problem.
- `coach_ask({match_id, hero, question})`: a follow-up answered from the report;
  `fallback: true` when no AI was available.
- `goal_check({match_id, hero, goal})`: judge a later game against a finding's
  `goal` (`met | missed | no_opportunity | unknown` + evidence). Only for the
  goal owner's own games.
- `hero_matchup({hero, vs, rank?})`: hero vs hero from pro games, no match needed —
  win rate and lane gold at 10:00 (verdict only on a real gap, with the number
  of games; `null` when too few), counter items pros build each way, Valve
  facts on the other hero's abilities, and `lines` in English and Chinese.
  `by_rank` has the same pair in public games per rank bracket (`hg`, `ca`,
  `la`, `di`) from STRATZ — win rate and same-lane won / even / lost; pass
  `rank` to get that bracket in `lines`. Credit STRATZ
  (`rank_source.attribution`) when you quote these numbers.

The shared HTTP endpoint (`/mcp`, below) keeps to the review tools: coach calls
from every agent would otherwise share one IP and one rate limit.

Review tools:

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
