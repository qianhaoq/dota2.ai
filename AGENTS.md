# Agent guide — dota2.ai

Short operational brief for Copilot cloud agent / IDE agents. Full product rules live in `.github/copilot-instructions.md`.

## Quick start

```bash
npm ci
npm test
npm run build
npx tsc --noEmit
node --check server.js
```

Dev: `npm run start:dev` (Vite + Express). Prod-like: `npm run build && npm start` on port 8080.

Env: copy `.env.example` → `.env`. Required: `DEEPSEEK_API_KEY`.

## Do

- Keep PRs small; one issue → one focused PR.
- Reuse `src/components`, `src/services`, `src/types.ts`.
- Respect bilingual UI defaults (中文 first).
- Fill the PR template; call out streaming / API / deploy risk.
- Prefer **ready-for-review** (not forever-draft) when CI should auto-merge.

## Don't

- Commit `.env` or API keys.
- Rewrite `server.js` wholesale or swap the AI provider without an explicit ask.
- Skip TypeScript / build / tests.
- Invent Dota lore or balance numbers not backed by repo data.

## Merge policy

Human merge is **optional** only when every auto-merge gate passes. Copilot often submits `COMMENTED`, not `APPROVED` — do not require `APPROVED`. `.github/workflows/auto-merge.yml` squash-merges into `main` only if a successful **Build & Test check run** exists on the head SHA (fail closed if missing), **`copilot-pull-request-reviewer` and `Codex Review Gate` check runs exist and succeeded** (missing / skipped / neutral block), the latest Copilot review for that SHA exists and is not `CHANGES_REQUESTED` (`APPROVED` or `COMMENTED` OK), and **all review threads are resolved** (#33: COMMENTED + open threads must not merge). Missing Copilot review does not auto-merge. Codex Gate publishes a successful head-SHA check first, then dispatches Auto Merge; dispatch failure replaces that check with a newer failure. Merge is pinned to the evaluated head SHA. To block auto-merge, add label `no-auto-merge` or keep the PR as draft. See `docs/MERGE_GATES.md`.

## Cloud agent environment

`.github/workflows/copilot-setup-steps.yml` installs Node 20 + `npm ci` before the agent starts. Prefer those tools; do not assume global CLIs beyond that.
