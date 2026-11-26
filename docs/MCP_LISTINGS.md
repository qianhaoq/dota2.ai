# Listing the MCP server

The hosted endpoint is `https://dota2.ai/mcp` (Streamable HTTP, no install, no key). These are the places it is listed, and how.

| Where | How | What it reads |
|---|---|---|
| Official MCP Registry (registry.modelcontextprotocol.io) | `mcp-publisher publish` from the repo root, by the repo owner | `server.json` |
| Glama (glama.ai/mcp/servers) | indexes public GitHub repos; "Claim" the server while signed in with GitHub | `glama.json` (maintainers) |
| Smithery (smithery.ai) | "Add server" → external / remote URL `https://dota2.ai/mcp`, signed in with GitHub | the live `tools/list` |
| mcp.so | "Submit" with the repo URL and the endpoint | the repo README |
| PulseMCP, other directories | most import from the official registry | `server.json` |

## Official registry

Install the publisher (once), sign in as the GitHub user that owns the `io.github.qianhaoq/*` namespace, publish:

```sh
brew install mcp-publisher        # or the release tarball, see modelcontextprotocol.io/registry/quickstart
mcp-publisher validate            # server.json against the registry schema
mcp-publisher login github        # device flow: open github.com/login/device and enter the code
mcp-publisher publish
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.qianhaoq/dota2-ai"
```

A new publish needs a new `version`: bump `packages/mcp/package.json`, the `version` in `createMcpServer` (`packages/mcp/src/index.js`) and `server.json` together (`src/utils/mcpRegistry.test.ts` holds them equal). The registry limits `description` to 100 characters.

## What to say (for forms that ask)

- **Name**: dota2.ai — Dota 2 post-match coach
- **One line**: Reviews a Dota 2 game from its replay; every point is backed by replay evidence that was checked.
- **Longer**: Give it a match ID and the hero the user played. `replay_review` has the coach go through the replay (deaths, ultimates, fights, items) and returns the verdict, findings with times and numbers checked against the replay, what to do next game, and what the replay cannot show, with a link to the review page. Instant tools give a scoreboard-level report, recent games from a friend code, pro games on the same problem, hero matchups and next-game goal checks. English and Chinese.
- **Category**: Gaming / Sports & games
- **Auth**: none. Rate-limited per caller (a few reviews per ten minutes).
