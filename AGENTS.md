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

Env: copy `.env.example` → `.env`. Required: `DEEPSEEK_API_KEY`. Recommended: `GEMINI_API_KEY` (review-card fallback provider).

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

## Handoff

- When handing work to the next bot, DM it and wake it by name. A mention in a group chat alone does not count as a handoff.

## Merge policy

Human merge is **optional** only when every auto-merge gate passes. Copilot often submits `COMMENTED`, not `APPROVED` — do not require `APPROVED`. `.github/workflows/auto-merge.yml` squash-merges into `main` only if a successful **ci / Build & Test check run** exists on the head SHA (fail closed if missing), **`codex / Codex Review Gate` succeeded**, and Copilot is satisfied: Copilot has reviewed the PR **at least once, on any commit** (`copilot_scope: any`; Copilot is requested only on opened / ready_for_review and never re-reviews pushes), and the latest Copilot review is not `CHANGES_REQUESTED`. Head-SHA freshness comes from the Codex Gate, CI and QA. Repo variable `DISABLE_COPILOT_REVIEW=true` turns off both the request and this requirement. **Blocking threads:** unresolved non-Codex threads, plus unresolved Codex **P0/P1 (or unlabeled)**; pure Codex **P2 may stay open**. A PR that Copilot never reviewed does not auto-merge. Codex Gate dispatches Auto Merge on success and fails the check if dispatch fails. Merge is pinned to the evaluated head SHA. To block auto-merge, add label `no-auto-merge` or keep the PR as draft. See `docs/MERGE_GATES.md`.

- **评审严重度**：P0/P1 须改代码后再 Resolve；P2 可保持 open，或回复 `P2: defer — <reason>` / `P2: won't fix — <reason>` 后 Resolve（无需改代码）。Codex Gate / Auto Merge 仅阻断 Codex P0/P1（及未标注）。未标注时：正确性/安全/数据丢失→P0/P1，nit/style→P2。详见 `docs/MERGE_GATES.md`「评审严重度」。

## Cloud agent environment

`.github/workflows/copilot-setup-steps.yml` installs Node 20 + `npm ci` before the agent starts. Prefer those tools; do not assume global CLIs beyond that.

## Coding 工具顺序（2026-10-20 起）

**适用范围（写死）**：下列 Codex / `coding` / `/home/box/.../codex-quota.sh` 顺序**仅**适用于已预装这些工具的**本机或 `/home/box` 工作站**。Copilot cloud、仅 Node·npm 的云端 agent、以及任何未预装 Codex/`coding` 的环境：**必须按该环境已有工具执行**；**严禁**把本机/box 工具序、`codex`/`coding` 或 `/home/box` 路径当作云端硬性要求。

1. **（本机/box）默认用 Codex CLI**（ChatGPT 账号登录），模型 `gpt-6.1-sol`（`~/.codex/config.toml`）。
2. **周额度用完后继续用 credits** 跑 Codex；**credits 也用完**再切：`coding glm`（一般代码）/ `coding kimi`（前端/交互/UI）。
3. 查额度（仅本机/box）：`/home/box/.coding-plans/codex-quota.sh`（退出码 0=继续 Codex，1=切 glm/kimi，2=未知；`--json`、`--probe`），或 Codex TUI 内 `/status`。云端无此脚本时跳过。
4. 凭证 `~/.codex/auth.json` 及任何 API key **绝不打印、外传或提交**；`.codex/`、`auth.json` 已在 `.gitignore`。

## 测试与门禁（禁止弱化凑绿）

- **禁止**为过 CI / Gate 而弱化、删改断言，或用 `skip` / `xit` / `.only`、改 fixture、放宽阈值等方式凑绿；也禁止让测试迁就错误实现。
- 红灯时优先修产品代码，或按真实意图**加强**测试；若断言本身写错，须在 PR 写明「原断言为何错、新断言覆盖什么」再改测试。
- AI 同时写代码与测试时，须用独立评审（Codex Gate / 人工）或既有回归交叉验证，勿代码与测试互相迁就。


## PR 证据与自动修上限（2026-10-20）

- **不要求人类 approve**；Gate 仍只挡 **P0/P1（及未标注）**（纯 P2 不挡）。
- **PR 必须贴证据**：正文写清「跑了什么测试 + 关键输出」（命令与摘要即可）；口头 done / 只勾 checkbox 不算。
- **同类 P1 自动修超 3 轮仍未清（写死）**：三轮上限**只**停止自动修循环（不得继续盲推）。**未 Resolve 的 P1 永远挡合入**——重试次数不改变严重度、不降级门禁。交给人/产品开跟进 issue/PR 继续修。**严禁**因重试次数把 P1 标成 observe、won't-fix、或 Resolve 后放行合入。
