# dota2.ai — Copilot repository instructions

## Product

dota2.ai is a Dota 2 coach that reviews one player's game from its replay (English default UI, Chinese via toggle; model output follows the UI language):

- **Match review** (`/r/:matchId`): the replay is parsed into a trace, an agent investigates it with lookup tools, and what it writes is checked against the tool results before it ships. Evidence, a rule per finding, a goal the next game is checked on, and a chat that goes back to the replay.
- **Home and player pages** (`/`, `/p/…`): find a match by ID or friend code, recent games, the goal in progress, a patch advisor.
- **For agents**: a CLI (`packages/cli`), an MCP server (`packages/mcp`, also at `/mcp`) and the `/api/v1` review API.

Live site: `dota2.ai`. Contact / deploy owner: personal project of `qianhaoq`. Overview: `README.md`; how a match ID becomes a review: `docs/AGENT_PIPELINE.md`; what the coach understands and how that is measured: `docs/GAME_UNDERSTANDING.md`.

## Stack

- Frontend: React 18 + TypeScript + Vite + Tailwind (`src/`)
- Backend: Express in `server.js` (ESM, Node >= 20.10; CI uses Node 20), routers in `lib/*/router.js` and `routes/v1`
- Workspace packages (`packages/*`): `review-engine` (pure: no network, clock or model), `cli`, `mcp`
- AI: DeepSeek through an OpenAI-compatible client, `DEEPSEEK_API_KEY` (never commit secrets; `.env.example` is the contract). The review agent's provider is chosen in `lib/agent/providers.js`.
- Replays: a private worker (`Dockerfile.trace-worker`, `scripts/trace-worker.mjs`) runs the pinned extractor; traces and reviews are kept in a bucket
- Tests: Vitest (`npm test`), Playwright (`npm run test:e2e`, against a zero-outbound fixture server)
- Deploy: Docker → Google Cloud Run; CI on GitHub Actions

## Architecture map

- `src/agent/` — the match page: review document, evidence cards, scoreboard, chat rail
- `src/coach/` — home, player page, the goal kept in the browser (`goalStore.ts`)
- `src/patch/` — patch advisor; `src/services/` — analytics client; `src/utils/` — pure helpers and most tests (tests for `lib/*.js` live here and import `../../lib/…`)
- `lib/agent/` — the review agent: replay pipeline and stores, lookup tools (`*Report.js`, `knowledgeTools.js`, `situationTools.js`), the agent loop, the review (`review/`: schema, prompt, check, toolkit, run), chat, evidence, router
- `packages/review-engine/src/trace/` — what a trace contains (`build.js`), state at a second (`state.js`), the trace query tools (`tools.js`)
- `lib/coach/` — the deterministic engine behind the home and player pages and some agent tools; `lib/coach/data/` — snapshots (matchups, pro items, hero timing) refreshed by `scripts/refresh-data.mjs`
- `lib/data/constants/patches/` — item and ability numbers per game release
- `lib/upstream/` — OpenDota / STRATZ / Steam GC clients; `lib/matchReview/replayIngest/` — replay discovery and download
- `server.js` — `/health`, `/api/health`, mounts `/api/agent/*` (prepare, review, evidence, chat), `/api/coach/*`, `/api/patch/*`, `/api/v1/*`, `/api/events`, then the built app

## Coding standards

- Prefer TypeScript in `src/`; keep `server.js` changes small and syntax-valid (`node --check server.js`).
- Match existing bilingual (中文 | English) UX copy style where UI strings change.
- Do not invent heroes, abilities, or patch facts; use existing data modules or clearly mark unknowns.
- No secrets in code, logs, PR bodies, or commit messages.
- Prefer focused diffs. Do not drive-by refactor unrelated files.
- Streaming / SSE / chunked responses: watch closure traps and aborted-request cleanup (called out in the PR template).

### Review agent invariants

- A review states only what the lookup tools returned in that run; the check (`lib/agent/review/verify.js`) drops the rest, and evidence shown to the reader is recomputed from the trace. Do not loosen the check.
- Unknown is not false: missing or unestablished data stays `null` or a `gaps` entry, never `0`, `false`, `[]` or "none". Add the test that blanks the source.
- No tool says who could see whom; tools state facts ("not in the fight"), not motives ("refused to come").
- The prompt, the `submit_review` schema and the tool definitions are pinned (`src/utils/agentPromptPin.test.ts`): changing them, or a tool's answer, means raising `DEEP_REVIEW_PROMPT_VERSION`.
- Read a stored trace through `linkHeroNames`; keep `packages/review-engine` pure.
- Output language follows the UI `lang`; UI copy is bilingual.

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
- Prefer extending the existing page, tools and services over adding parallel frameworks. A new fact for the coach is a lookup tool with a `ref` and `gaps`, not a sentence in the prompt.
- If a task needs `DEEPSEEK_API_KEY` for runtime smoke tests, use Copilot Agents secrets / env — never hardcode. A bulk model run can draw on the account production uses: check the balance and state the expected spend first.
- Human owns merge. Copilot review is assistive, not a substitute for human review on risk areas (streaming, API, deploy).

## Review severity tagging (P0 / P1 / P2)

When leaving review comments (Copilot or Codex), **tag each finding** with severity:

- **P0** — correctness bug, security issue, or data-loss risk → must fix in code before Resolve / merge
- **P1** — substantive defect or clear behavioral regression → must fix in code before Resolve / merge
- **P2** — nit, style, optional cleanup → author may Resolve without a code change after replying `P2: defer — <reason>` or `P2: won't fix — <reason>`

Unlabeled comments: treat correctness/security/data-loss as P0/P1; treat nit/style as P2.

codex / Codex Review Gate / Auto Merge block unresolved Codex **P0/P1 (or unlabeled)**; pure Codex **P2 may stay open**, or Resolve after `P2: defer — <reason>` / `P2: won't fix — <reason>`. Non-Codex threads still must be resolved. GitHub native conversation resolution has no severity filter — see `docs/MERGE_GATES.md`.
