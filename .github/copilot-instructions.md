# dota2.ai — Copilot repository instructions

## Product

Dota2.ai is a DeepSeek-powered Dota 2 tactical assistant (English default UI, Chinese via toggle; DeepSeek/API output follows UI lang):

- **Draft Strategy**: Radiant/Dire hero picks + optional strategy context → matchup analysis
- **Lore Keeper**: chat with the Secret Shopkeeper about Dota 2 lore

Live site: `dota2.ai`. Contact / deploy owner: personal project of `qianhaoq`.

## Stack

- Frontend: React 18 + TypeScript + Vite + Tailwind (`src/`)
- Backend: Express in `server.js` (ESM, Node >= 18; CI uses Node 20)
- AI: DeepSeek via `DEEPSEEK_API_KEY` (never commit secrets; use `.env.example` as the contract)
- Tests: Vitest (`npm test`)
- Deploy: Docker → Google Cloud Run; CI on GitHub Actions

## Architecture map

- `src/components/` — UI (DraftAssistant, LoreChat, HeroCard, …)
- `src/services/` — client/API helpers (e.g. dotaApiService, geminiService naming may lag; prefer current DeepSeek paths)
- `src/types.ts`, `src/constants.ts`, `src/data/` — shared types, constants, static data
- `server.js` — `/health`, `/api/health`, `/api/analyze`, `/api/chat` (streaming-sensitive)

## Coding standards

- Prefer TypeScript in `src/`; keep `server.js` changes small and syntax-valid (`node --check server.js`).
- Match existing bilingual (中文 | English) UX copy style where UI strings change.
- Do not invent heroes, abilities, or patch facts; use existing data modules or clearly mark unknowns.
- No secrets in code, logs, PR bodies, or commit messages.
- Prefer focused diffs. Do not drive-by refactor unrelated files.
- Streaming / SSE / chunked responses: watch closure traps and aborted-request cleanup (called out in the PR template).

### Coach / streaming invariants (Codex P1s #54, #56)

- Draft / side / practice changes that invalidate in-flight Analyze / Playbook / Next-pick must bump `contextRevision` and call `cancelStream()` together; retire stale suggestion cards for the new revision.
- Re-tapping the already-selected "My side" is a no-op — must not bump the revision or cancel streams.
- Respect explicit My side (`mySideExplicitRef`); never infer `mySide` from the first pick when set explicitly, and treat a practice-hero-only board as non-empty for inference.
- Accepting a suggestion / Next-pick uses the request-time ally side + practice hero stamped on the message, not live controls.
- Streaming chunks functional-append only (`setMessages(prev => appendStreamChunk(prev, …))`); never `messages.find` overwrite.
- Analyze / Next-pick enablement derives from the resolved lineup (`resolveCoachingLineup`), not the raw empty draft.

Full list: `.cursor/rules/dota2-coach-invariants.mdc`.

## Quality bar (must stay green)

Before finishing a change, the agent should be able to run locally / in setup:

```bash
npm ci
npx tsc --noEmit
node --check server.js
npm run build
npm test
```

PRs must fill `.github/pull_request_template.md` and pass the `CI` workflow (`build-and-test`).

## Agent behavior

- Scope work to the issue / problem statement. Split large work; do not re-architect the app in one PR.
- Open a **draft** PR when uncertain; leave a short note of what was verified.
- Prefer extending existing components/services over adding parallel frameworks.
- If a task needs `DEEPSEEK_API_KEY` for runtime smoke tests, use Copilot Agents secrets / env — never hardcode.
- Human owns merge. Copilot review is assistive, not a substitute for human review on risk areas (streaming, API, deploy).

## Review severity tagging (P0 / P1 / P2)

When leaving review comments (Copilot or Codex), **tag each finding** with severity:

- **P0** — correctness bug, security issue, or data-loss risk → must fix in code before Resolve / merge
- **P1** — substantive defect or clear behavioral regression → must fix in code before Resolve / merge
- **P2** — nit, style, optional cleanup → author may Resolve without a code change after replying `P2: defer — <reason>` or `P2: won't fix — <reason>`

Unlabeled comments: treat correctness/security/data-loss as P0/P1; treat nit/style as P2.

Codex Review Gate / Auto Merge block unresolved Codex **P0/P1 (or unlabeled)**; pure Codex **P2 may stay open**, or Resolve after `P2: defer — <reason>` / `P2: won't fix — <reason>`. Non-Codex threads still must be resolved. GitHub native conversation resolution has no severity filter — see `docs/MERGE_GATES.md`.
