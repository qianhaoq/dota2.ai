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
- Respect bilingual UI: English default, Chinese via toggle; DeepSeek/API output must follow UI lang.
- Fill the PR template; call out streaming / API / deploy risk.
- Prefer **ready-for-review** (not forever-draft) when CI should auto-merge.

## Don't

- Commit `.env` or API keys.
- Rewrite `server.js` wholesale or swap the AI provider without an explicit ask.
- Skip TypeScript / build / tests.
- Invent Dota lore or balance numbers not backed by repo data.

## Coach invariants

Worst pitfalls from Codex P1s (#54, #56) — full rules: `.cursor/rules/dota2-coach-invariants.mdc`.

- Any draft / side / practice change that invalidates in-flight Analyze / Playbook / Next-pick MUST bump `contextRevision` (sync `contextRevisionRef` **before** `setContextRevision`) **and** call `cancelStream()` together, and retire stale suggestion cards (`clearStaleSuggestionsForRevision`). On leaving review (`applyLessonSwitch`), `cancelStream()` before the revision bump.
- No-op interactions (re-tapping the already-selected "My side") MUST NOT bump the revision or cancel streams.
- Respect explicit My side (`mySideExplicitRef`): never infer `mySide` from the first pick when the user set it; a practice-hero-only board is non-empty for side inference.
- Accepting a suggestion / Next-pick binds to the request-time ally side + practice hero stamped on the message — not live controls.
- Streaming `onChunk` functional-appends only (`setMessages(prev => appendStreamChunk(prev, …))`); never `messages.find` overwrite.
- Analyze / Next-pick enablement derives from the resolved lineup (`resolveCoachingLineup`), not the raw empty draft.
- DeepSeek output language follows UI `lang` (zh → 简体中文, en → English); preserve the product-approved default (English after #57).

## Merge policy

Human merge is **optional** only when every auto-merge gate passes. Copilot often submits `COMMENTED`, not `APPROVED` — do not require `APPROVED`. `.github/workflows/auto-merge.yml` squash-merges into `main` only if a successful **Build & Test check run** exists on the head SHA (fail closed if missing), **`copilot-pull-request-reviewer` and `Codex Review Gate` check runs exist and succeeded** (missing skips), the latest Copilot review for that SHA exists and is not `CHANGES_REQUESTED` (`APPROVED` or `COMMENTED` OK), and **all review threads are resolved** (#33: COMMENTED + open threads must not merge). Missing Copilot review does not auto-merge. Codex Gate dispatches Auto Merge on success and fails the check if dispatch fails. Merge is pinned to the evaluated head SHA. To block auto-merge, add label `no-auto-merge` or keep the PR as draft. See `docs/MERGE_GATES.md`.

- **评审严重度**：P0/P1 须改代码后再 Resolve；P2 可回复 `P2: defer — <reason>` 或 `P2: won't fix — <reason>` 后 Resolve（无需改代码）。未标注时：正确性/安全/数据丢失→P0/P1，nit/style→P2。详见 `docs/MERGE_GATES.md`「评审严重度」。

## Cloud agent environment

`.github/workflows/copilot-setup-steps.yml` installs Node 20 + `npm ci` before the agent starts. Prefer those tools; do not assume global CLIs beyond that.
