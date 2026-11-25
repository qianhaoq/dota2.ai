---
applyTo: "server.js"
---

# Express server (`server.js`)

- Keep changes minimal and ESM-compatible (`"type": "module"` in package.json). New endpoints go in a router (`lib/agent/router.js`, `lib/coach/router.js`, `lib/patch/router.js`, `routes/v1`), wired here with its dependencies.
- Mounted here: `/health`, `/api/health`, `/api/agent/*`, `/api/coach/*`, `/api/patch/*`, `/api/v1/*`, `/mcp`, `/api/events`, then the built app with an SPA fallback.
- A parse or a review is a job that outlives a request and a deploy (`docs/AGENT_PIPELINE.md`): do not hold its state only in the instance's memory.
- Streaming responses: avoid stale closures over request state; clean up on client abort.
- Never log or return `DEEPSEEK_API_KEY` or any other secret; `server.js` does not load `.env` itself.
- After edits, ensure `node --check server.js` still passes.
