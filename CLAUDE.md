# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

dota2.ai is a Dota 2 coach that reviews one player's game from its replay: an agent investigates the parsed replay with lookup tools, and what it writes is checked against the tool results before it ships ("teach judgment, and prove what it says"). Authoritative agent rules live in `AGENTS.md`, `.github/copilot-instructions.md` and `.cursor/rules/dota2-coach-invariants.mdc` — read them before non-trivial changes; the essentials are summarized below.

## Commands

Node >= 20.10, npm workspaces (`packages/*`).

```bash
npm ci
cp .env.example .env          # DEEPSEEK_API_KEY is needed for the review agent and the chat
npm run start:dev             # Vite :5173 (proxies /api → localhost:8080) + Express :8080
npm run build && npm start    # prod-like: Express serves dist/ on :8080
```

Required gate (same as CI `ci / Build & Test`) — all must pass before a PR:

```bash
npx tsc --noEmit && node --check server.js && npm run build && npm test
```

- Single test file: `npx vitest run src/utils/deepReview.test.ts`; single case: add `-t "<name>"`.
- Vitest includes `src/**/*.test.{ts,tsx}` and `packages/*/test/**`. Tests for server-side `lib/*.js` live in `src/utils/*.test.ts` and import `../../lib/...` directly.
- E2E (Playwright, `e2e/`): `npm run test:e2e` builds the app and serves it with the zero-outbound fixture server `scripts/mock-review-server.mjs` on :4180 — the real agent over the trace of match 9100904020 with a scripted model (`scripts/mock-agent.mjs`). Projects `mobile-390` and `desktop-1280`, visual baselines and axe. Update baselines with `npm run test:e2e:update`.
- `server.js` does not load `.env` itself — export env vars into the process (or use a loader) when running it.
- Without a model: `node scripts/calibrate.mjs <traces dir>` (what each situation feature explains), `node packages/cli/bin/dota2ai.js trace <tool> --trace <file>` (one lookup tool on a trace).
- With a model (spends tokens): `node scripts/deep-review.mjs <trace.json.gz> --hero <hero> --lang zh --steps`, `node scripts/probe-chat.mjs`.

## Architecture

- **Frontend (`src/`)**: React 18 + TS + Vite + Tailwind. `src/agent/` is the match page `/r/:matchId` (`AgentMatchPage` drives parse → review; `ReviewDoc` renders the review, `EvidenceCard` the records under each line, `MatchBoard` the scoreboard, `ChatRail` the chat). `src/coach/` is the home and player pages and the goal kept in the browser (`goalStore.ts`). `src/patch/` is the patch advisor. Pure helpers and most tests are in `src/utils/`.
- **Backend (`server.js`, ESM Express)**: health routes, then routers wired with their dependencies — `lib/agent/router.js` (`/api/agent/:matchId` availability, `prepare`, `review`, `evidence`, `chat`, and the internal job route), `lib/coach/router.js` (`/api/coach/*`, link previews for `/` and `/r/:matchId`), `lib/patch/router.js`, `routes/v1` (`/api/v1/review/*`, OpenAPI, `llms.txt`, MCP at `/mcp`) — then `/api/events` and the built app with an SPA fallback. Keep `server.js` edits small; don't rewrite it wholesale.
- **Review agent (`lib/agent/`)**: `tracePipeline.js` / `service.js` / `stores.js` / `tasks.js` turn a match ID into a stored trace and a stored review as jobs that outlive a request and a deploy (`docs/AGENT_PIPELINE.md`). The lookup tools are `*Report.js`, `knowledgeTools.js`, `situationTools.js` plus the trace tools; `loop.js` is the provider-independent agent loop; `review/` holds the review's schema, prompt, check (`verifyReview`), toolkit and run; `chat.js` answers questions from the replay; `evidence.js` rebuilds what a reader opens under a line. What the coach understands, and the calibration behind every quoted number: `docs/GAME_UNDERSTANDING.md`.
- **Trace (`packages/review-engine/src/trace/`)**: `build.js` turns the extractor's rows into one compact trace (what it keeps is listed at the top of the file), `state.js` answers "what was true at second t", `tools.js` are the query tools. A trace says what it does not hold under `gaps`.
- **Workspace packages**: `packages/review-engine` (pure — no network, clock or model), `packages/cli` (`dota2ai`; `dota2ai/handlers` and `dota2ai/tools` are the coach tools' code and words, shared by MCP and DSH), `packages/mcp`, `packages/dsh` (the DSH plugin `@qianhaoq/dsh-dota2ai`: Node ≥ 24.9, `@deepseek-ai/*` pinned to the DSH release in `engines.dsh`, released as a tgz from a `dsh-v*` tag by `.github/workflows/dsh-release.yml`). None are published to npm.
- **Deterministic engine (`lib/coach/`)**: behind the home and player pages and some agent tools. `lib/coach/data/` and `lib/data/constants/patches/` are snapshots (matchups, pro items, hero timing, item and ability numbers per game release), refreshed by `scripts/refresh-data.mjs`.
- **Upstreams**: `lib/upstream/` (OpenDota, STRATZ, Steam GC), `lib/matchReview/replayIngest/` (replay discovery and download), the Go extractor from the companion repo `qh-dsh-dota-coach` (pinned binary).
- **LLM**: DeepSeek via an OpenAI-compatible client; the review agent's provider is chosen in `lib/agent/providers.js`. Per-caller limits and a shared budget are in `lib/agent/router.js`.
- **Deploy**: Docker → Cloud Run. Merging to `main` deploys the site, except merges that touch only tests, docs, scripts and CI. The replay worker (`Dockerfile.trace-worker`, `scripts/trace-worker.mjs`) runs in two regions — `dota2-ai-trace-worker` (asia-east1) and the fallback `dota2-ai-trace-worker-hk` (asia-east2), which the site asks when the first cannot download a replay (`TRACE_WORKER_FALLBACK_URL`). A merge to `main` that touches what its image contains rebuilds it and deploys both (trigger `dota2-ai-trace-worker`, `cloudbuild.trace-worker.yaml`; the pinned extractor comes from the build bucket by its SHA-256). A change to what a trace contains still needs games parsed again (`TRACE_BUILD_VERSION`).

## Review agent invariants (real past review findings — do not regress)

When touching `lib/agent/**`, `packages/review-engine/src/trace/**` or `src/agent/**`, re-check `.cursor/rules/dota2-coach-invariants.mdc`. Key points:

- A review states only what the tools returned in that run: `verifyReview` drops the rest, and evidence is recomputed from the trace. Never loosen the check to let text through.
- Unknown is not false: missing or unestablished data stays `null` or a `gaps` entry, never `0`, `false`, `[]` or "none"; a field an older trace lacks is unknown. Write the tests that blank the source.
- No tool says who could see whom. Tools state facts ("not in the fight"), not motives.
- The prompt, the `submit_review` schema and the tool definitions are pinned in `src/utils/agentPromptPin.test.ts`: changing them — or a tool's answer — means raising `DEEP_REVIEW_PROMPT_VERSION` and updating the pin.
- The model judges; tools give facts and references (#405). No fixed rule decides a judgment (main reason, whose fault, what is a finding) or forces what a review covers; prefer a lookup tool or a reference in a tool's answer to a prompt rule, and removing prompt rules to adding them. Corpus numbers the model sees are references in tool output, measured by `scripts/calibrate.mjs` with their sample — not a gate before the model may see a feature. The fact checks above stay.
- Read a stored trace through `linkHeroNames`. Tools speak from the player's side (`me` / `ally` / `enemy`).
- Output language follows the UI `lang` (`zh` → 简体中文, `en` → English); the UI defaults to English with a Chinese toggle. Keep UI copy bilingual.
- A bulk model run can draw on the account production uses: check the provider's balance and state the expected spend before starting.

## Project rules

- Don't change the review agent's default model or add a provider without an explicit ask, invent hero/ability/patch facts not backed by repo data, or commit `.env`/keys.
- One issue → one focused PR; fill `.github/pull_request_template.md` and include evidence (commands run + key output). Call out streaming/API/deploy risk.
- Never weaken tests to get green (no deleting/loosening assertions, `skip`/`.only`, fixture tweaks). Fix product code, or explain in the PR why an assertion was wrong.
- Review severity: P0/P1 must be fixed in code before resolve; P2 may stay open or be resolved with `P2: defer — <reason>` / `P2: won't fix — <reason>`. Auto-merge (`.github/workflows/auto-merge.yml`) requires green CI + `codex / Codex Review Gate` and no unresolved P0/P1; label `no-auto-merge` or draft status blocks it. Details: `docs/MERGE_GATES.md`.
