---
applyTo: "server.js"
---

# Express server (`server.js`)

- Keep changes minimal and ESM-compatible (`"type": "module"` in package.json).
- Endpoints in play: `/health`, `/api/health`, `/api/analyze`, `/api/chat`.
- Streaming responses: avoid stale closures over request state; clean up on client abort.
- Never log or return `DEEPSEEK_API_KEY`.
- After edits, ensure `node --check server.js` still passes.
