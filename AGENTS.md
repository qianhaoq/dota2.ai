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

Multi-session workstation note: running two full `vitest` suites concurrently on one machine can exhaust memory and trigger `earlyoom`. On a shared workstation with multiple agent worktrees, serialize full `npm test` runs with `/run/user/1000/dota2ai-vitest.lock` (`L=/run/user/1000/dota2ai-vitest.lock; until mkdir "$L" 2>/dev/null; do sleep 5; done; trap 'rmdir "$L" 2>/dev/null' EXIT; npm test`), or target single test files (`npx vitest run <file>`) during iteration.

Env: copy `.env.example` → `.env`. Required: `DEEPSEEK_API_KEY` (the review agent and the chat). `.env.example` documents the rest. `server.js` does not load `.env` itself.

## Do

- Keep PRs small; one issue → one focused PR.
- Reuse what is there: the match page is `src/agent`, the home and player pages `src/coach`, the review agent `lib/agent`, the replay trace and its query tools `packages/review-engine/src/trace`. How a match ID becomes a review: `docs/AGENT_PIPELINE.md`; what the coach understands and how that is measured: `docs/GAME_UNDERSTANDING.md`.
- Respect bilingual UI: English default, Chinese via toggle; DeepSeek/API output must follow UI lang.
- Fill the PR template; call out streaming / API / deploy risk.
- Prefer **ready-for-review** (not forever-draft) when CI should auto-merge.

## Don't

- Commit `.env` or API keys.
- Rewrite `server.js` wholesale, or change the review agent's default model or add a provider (`lib/agent/providers.js`) without an explicit ask.
- Skip TypeScript / build / tests.
- Invent Dota lore or balance numbers not backed by repo data.

## Review agent invariants

The match page is a review written by a tool-calling agent over a parsed replay (`lib/agent`). The rules below are what keeps it honest; each was a real review finding once. Longer list: `.cursor/rules/dota2-coach-invariants.mdc`.

- **A review states only what the tools returned in that run.** `verifyReview` (`lib/agent/review/verify.js`) drops what is unsupported, and the evidence a reader opens is recomputed from the trace (`lib/agent/evidence.js`), never taken from the model. Do not loosen the check to let text through.
- **Unknown is not false.** Data that is missing or cannot be established stays `null` or a `gaps` entry — never `0`, `false`, `[]` or "none". A field an older trace does not have is unknown. For anything derived from trace samples, write the tests that blank the source.
- **No tool says who could see whom.** A sentence about vision is dropped unless a tool record backs it. The same goes for anything listed under a tool's `gaps`.
- **What the model is told is pinned.** The prompt, the `submit_review` schema and every tool's definition are hashed in `src/utils/agentPromptPin.test.ts`. Changing any of them means raising `DEEP_REVIEW_PROMPT_VERSION` and updating the pin; a tool whose *answer* changes needs the bump too (stored reviews are kept per version).
- **A feature reaches the model after it is calibrated.** A number quoted in the prompt or in `docs/GAME_UNDERSTANDING.md` comes from `scripts/calibrate.mjs`, not from intuition.
- **Read a stored trace through `linkHeroNames`** (`packages/review-engine/src/trace`): without it some heroes lose their casts, deaths and damage.
- **Tools speak from the player's side** (`me`, `ally`, `enemy`); nothing downstream translates to Radiant / Dire.
- **Output language follows the UI `lang`** (zh → 简体中文, en → English; `lib/aiLanguage.js`). UI copy is bilingual; English is the default.
- **A replay is fetched only from a Valve or Perfect World replay host, for that match, without following redirects**, and the worker that parses it is never public (`lib/matchReview/replayIngest/discovery.js`, `lib/agent/tracePipeline.js`).
- **A bulk model run can draw on the account production uses.** Before probes, batch reviews or any run of more than a few dozen calls: query the provider's balance, state the expected spend, and stop well above zero.
- **Mark your own runs on the live site.** The funnel (`scripts/funnel.mjs`) and the logs are how we know whether a visitor who asked for a review got one, and our own checks used to be counted as visitors. A browser of ours: open any page once with `?internal=1` (it sticks in that browser's storage; `?internal=0` clears it) — a Playwright check opens its first page that way. A script or `curl` that starts a parse or a review on production: send `X-Dota2ai-Internal: 1`. The mark only labels: nothing is served differently.

## Handoff

- When handing work to the next bot, DM it and wake it by name. A mention in a group chat alone does not count as a handoff.

## Merge policy

Human merge is **optional** only when every auto-merge gate passes. `.github/workflows/auto-merge.yml` squash-merges into `main` only if a successful **ci / Build & Test check run** exists on the head SHA (fail closed if missing), **`codex / Codex Review Gate` succeeded**. Head-SHA freshness comes from the Codex Gate, CI and QA. Copilot is retired as a merge gate and is not required or auto-requested; independent review is Codex / Claude / human. Repo variable `DISABLE_COPILOT_REVIEW=true` is set; the durable workflow default is `require_copilot: false`. **Blocking threads:** unresolved non-Codex threads, plus unresolved Codex **P0/P1 (or unlabeled)**; pure Codex **P2 may stay open**. Codex Gate dispatches Auto Merge on success and fails the check if dispatch fails. Merge is pinned to the evaluated head SHA. To block auto-merge, add label `no-auto-merge` or keep the PR as draft. See `docs/MERGE_GATES.md`.
**Green → product-owner merge (2026-11-02):** after required checks are green and P0/P1 are cleared, the product owner may Approve/squash or let auto-merge run — **do not wait for 钱浩**. If GitHub “≥1 approving review from someone with write access” blocks self-Approve: product owner/agent may (1) temporarily set `main` `required_approving_review_count` to `0`, (2) squash-merge, (3) **restore to `1` immediately**. No `--admin` bypass; P0/P1 must still be clear. Steady state stays at `1` — never leave it at `0`.


- **评审严重度**：P0/P1 须改代码后再 Resolve；P2 可保持 open，或回复 `P2: defer — <reason>` / `P2: won't fix — <reason>` 后 Resolve（无需改代码）。Codex Gate / Auto Merge 仅阻断 Codex P0/P1（及未标注）。未标注时：正确性/安全/数据丢失→P0/P1，nit/style→P2。详见 `docs/MERGE_GATES.md`「评审严重度」。

## Cloud agent environment

`.github/workflows/copilot-setup-steps.yml` installs Node 20 + `npm ci` before the agent starts. Prefer those tools; do not assume global CLIs beyond that.

## Coding 工具顺序（2026-11-02 起）

**适用范围（写死）**：下列 Codex / `coding` / `/home/box/.../codex-quota.sh` 顺序**仅**适用于已预装这些工具的**本机或 `/home/box` 工作站**。Copilot cloud、仅 Node·npm 的云端 agent、以及任何未预装 Codex/`coding` 的环境：**必须按该环境已有工具执行**；**严禁**把本机/box 工具序、`codex`/`coding` 或 `/home/box` 路径当作云端硬性要求。

1. **（本机/box）优先用 Codex CLI**（ChatGPT 账号登录），模型 `gpt-6.1-sol`（`~/.codex/config.toml`）；出口优先 box（美区）。
2. **Codex 不可用**（区域 403 / 额度与 credits 耗尽 / 鉴权失败等）再切：`coding glm`（一般代码）/ `coding kimi`（前端/交互/UI）。
3. **不默认 Cursor Cloud Agent**（Cloud 上 OpenAI/Codex 常不可用；真要开只能选非 OpenAI 模型，一般不必）。
4. 查额度（仅本机/box）：`/home/box/.coding-plans/codex-quota.sh`（退出码 0=继续 Codex，1=切 glm/kimi，2=未知；`--json`、`--probe`），或 Codex TUI 内 `/status`。云端无此脚本时跳过。
5. 凭证 `~/.codex/auth.json` 及任何 API key **绝不打印、外传或提交**；`.codex/`、`auth.json` 已在 `.gitignore`。

## 测试与门禁（禁止弱化凑绿）

- **禁止**为过 CI / Gate 而弱化、删改断言，或用 `skip` / `xit` / `.only`、改 fixture、放宽阈值等方式凑绿；也禁止让测试迁就错误实现。
- 红灯时优先修产品代码，或按真实意图**加强**测试；若断言本身写错，须在 PR 写明「原断言为何错、新断言覆盖什么」再改测试。
- AI 同时写代码与测试时，须用独立评审（Codex Gate / 人工）或既有回归交叉验证，勿代码与测试互相迁就。


## PR 证据与自动修上限（2026-10-20）

- **不要求人类 approve**；Gate 仍只挡 **P0/P1（及未标注）**（纯 P2 不挡）。
- **PR 必须贴证据**：正文写清「跑了什么测试 + 关键输出」（命令与摘要即可）；口头 done / 只勾 checkbox 不算。
- **同类 P1 自动修超 3 轮仍未清（写死）**：三轮上限**只**停止自动修循环（不得继续盲推）。**未 Resolve 的 P1 永远挡合入**——重试次数不改变严重度、不降级门禁。交给人/产品开跟进 issue/PR 继续修。**严禁**因重试次数把 P1 标成 observe、won't-fix、或 Resolve 后放行合入。
