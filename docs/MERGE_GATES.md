# 合并门槛 | Merge gates

PR #33 在 CI 全绿、Copilot 只给 `COMMENTED`（“Needs a closer look”）、Codex 行内意见未解决时，仍可被合入。本页说明仓库级硬门槛。

This page is the source of truth for merge policy.

---


## Check names after devflow-gates migration

本仓库的 CI / Codex / Auto Merge 改为调用 `qianhaoq/devflow-gates` 的 reusable workflow（固定到 commit `fe7cf65`，即 fe7cf651ef515f165041738dc285b03ce3817bb9）。Check 名变为 `<caller job> / <called job>`，branch protection 与 `auto-merge.yml` 的 `required_checks` 必须使用以下名字：

- `ci / Build & Test`
- `ci / Secret Scan`
- `codex / Codex Review Gate`
- `e2e`（Playwright 视觉基准 + axe，`e2e.yml`）

**全自动流水线（2026-11-18 起）：** 不再需要任何人工标签。

1. 开 PR / 推送新 head → `codex-request.yml` 自动评论 `@codex review`；
2. CI、e2e 跑在 GitHub 托管的 `ubuntu-latest`（仓库公开，免费；不再依赖自建 runner）；
3. Codex 无 P0/P1（或未标注）发现 → `codex / Codex Review Gate` 变绿；
4. 四个必需 check 全绿、会话已解决 → `auto-merge.yml` squash 合入 main；
5. main 上的 Cloud Build 触发器自动部署到 dota2.ai。

**卡住时谁来管：`pipeline-watchdog.yml`。** CI / E2E / Codex Review Gate / Auto Merge 任一跑完即触发（事件驱动），每 10 分钟的 cron 只做兜底（GitHub 的定时任务尽力而为，新加后可能 1 小时都不触发）。 逻辑在 `.github/scripts/pipeline-watchdog.cjs`，测试在 `src/utils/pipelineWatchdog.test.ts`。它只重复流水线本来就会做的事，从不批准、打标签、解决线程或自己合入：

| 情况 | 动作 |
|---|---|
| 分支落后 main（strict 保护） | 自动 Update branch |
| 新 head 10 分钟没有**已完成**的 Codex 评审（含 Codex 回成"任务"、摘要停在 Running 或 Failed） | 再发 `@codex review`，每个 head 最多 3 次 |
| 必需 check 从未出现（>5 分钟） | 在 PR 分支上 dispatch 对应 workflow |
| 必需 check 排队 >15 分钟（没有 runner 接），或运行 >45 分钟（超过 job 自身超时） | 取消，下一轮重跑 |
| 必需 check 为 cancelled / timed_out | 重跑，最多 3 次 |
| 全绿、可合并但仍开着 >2 分钟（10 分钟冷却，防止与 Auto Merge 互相触发） | 按 PR 号 dispatch Auto Merge（独立并发组；`workflow_run` 触发的 sweep 共享一个组，可能一直 pending） |
| 上述重试用尽，或与 main 冲突 | head 超过 45 分钟后，在 PR 上 @仓库所有者说明原因（每个 head 一次） |

真实失败（测试红、Codex P0/P1）不重跑，由作者修。**必需 secret `PIPELINE_TOKEN`**：仓库所有者（已关联 Codex 的账号）的细粒度 PAT，只授权本仓库，权限 Contents / Pull requests / Issues / Actions 读写。Codex 只响应已关联账号的 `@codex review`，对 `github-actions[bot]` 回复 "To use Codex here, create a Codex account"（#144 实测），所以自动请求评审必须用它发。它同时让 Update branch 的推送正常触发 `pull_request` workflow。

**改流水线本身时：** `pull_request_target` / `issue_comment` / `workflow_run` 触发的 workflow 只读 main 上的 YAML，PR 里的改动在合入前不会生效。改这类文件时，先在 PR 分支上 `workflow_dispatch` 实跑（或用只读 dry run），把运行链接贴进 PR 描述；新的约束尽量写成 `npm test` 里的断言（例：`workflowRunners.test.ts` 禁止 `self-hosted`，`pipelineWatchdog.test.ts` 要求 `@codex review` 正文精确）。

原 `qa / QA Gate`（`qa-passed` 标签）已移除；`QA.md` 保留为可选的人工验收清单。想让某个 PR 停在人工确认前，打 `no-auto-merge` 或保持 draft。

旧的裸名 `Build & Test` / `Codex Review Gate` 在合入后不再产生，若仍为 required 会让所有 PR 永久挂起。

Codex 线程分级（共享实现）：显式 P0/P1 阻断；未标注线程一律阻断（`block_unlabeled: true`，默认，fail-closed）；显式 P2（Codex、Copilot 或人工）不阻断；P2 可回复 `P2: defer — <理由>` 后 Resolve。线程 Resolve 不会触发 Actions（已取消每 15 分钟的定时 Refresh 以节省分钟）：Resolve 最后一个阻断线程后，在 PR 评论 `/recheck` 触发 Gate Refresh 重跑，或 `workflow_dispatch`（在 PR 分支上）填 PR 号；新 push / Codex 新评论也会自动重评。

> dota2.ai：Copilot is retired as a merge gate; Copilot review / check / invite is not required. Independent review is Codex / Claude / human; the Codex Review Gate remains required. `DISABLE_COPILOT_REVIEW=true` is set operationally; the durable workflow uses `require_copilot: false`, and the Copilot request job is disabled. Owner merge / deploy responsibility is unchanged.

## 先读：个人私有仓库 Ruleset 不生效 | Private personal repo

本仓库是 **个人账号下的 private repo**。GitHub 可能把 Repository Ruleset 显示为 **Active**，但会警告：在升级到 **Team / Organization** 之前 **不会真正 enforce**。

因此：

1. **不要指望 Ruleset 挡合并。** 它看起来开着，Merge 按钮和 API 仍可能放行。
2. **对 `main` 用经典 Branch protection**（Settings → Branches → Add rule），而不是只配 Ruleset。
3. 经典保护才能把下面的 **status checks** 变成硬门槛（需要账号具备 Branch protection 权限；私有仓库通常要 GitHub Pro）。
4. **仍然把同一套 check 写进 Ruleset**（Settings → Rules → Rulesets），以便升到 Team / Organization 后 enforce 立刻生效。现在 Ruleset 是预备，不是硬门槛。

---

## 人类必须打开的 `main` 保护 | Required protection on `main`

两处都要勾同一组 check。今天真正挡合并的是经典 Branch protection；Ruleset 留给升 Team 之后。

**Settings → Branches → Branch protection rule**（pattern: `main`）：

| 设置 | 为什么 |
|------|--------|
| **Require status checks to pass before merging** | 没有绿勾不能合 |
| Required check: **`ci / Build & Test`** | CI job 名（`.github/workflows/ci.yml`） |
| ~~Required check `copilot-pull-request-reviewer`~~ | **不设为 required**（Copilot 已退出合入门槛） |
| Required check: **`codex / Codex Review Gate`** | **job / check-run 名**（`.github/workflows/codex-gate.yml` 的 `jobs.*.name`），不是 workflow 展示名 |
| Required check: **`ci / Secret Scan`** | gitleaks（`ci.yml` 调用 devflow-gates） |
| Required check: **`e2e`** | Playwright e2e（`.github/workflows/e2e.yml`） |
| **Require conversation resolution before merging** | 未解决行内线程挡住 Merge（无严重度例外；与纯 P2 open 的关系见下方「原生保护」） |
| （可选）**Dismiss stale pull request approvals when new commits are pushed** | 新 push 后旧 APPROVED 作废 |

**Copilot 的 required check 不覆盖 Codex。** `copilot-pull-request-reviewer` 只反映 Copilot。Codex（`chatgpt-codex-connector[bot]`）从不注册那个 check。

**Settings → Rules → Rulesets**（升 Team 后才会 enforce；现在也建议配好）：

- Target: branch `main`
- Require status checks: **`ci / Build & Test`**、**`ci / Secret Scan`**、**`codex / Codex Review Gate`**、**`e2e`**（不含 `copilot-pull-request-reviewer`）
- Require conversation resolution before merging
- （可选）Dismiss stale reviews

不要把 **Custom LLM Review** 或 `ai-review.yml` 里的 **Copilot Review**（只负责 *request* 审查）设为必需。

---

## Codex Review Gate

[Codex](https://chatgpt.com/codex) 只发 **issue comment**（`<!-- codex-pull-request-review-summary -->`）和行内 review threads，**不是** GitHub 原生 required check。

`.github/workflows/codex-gate.yml` 的 caller job id `codex` + reusable job 名 `Codex Review Gate` 产生 check **`codex / Codex Review Gate`**。经典 branch protection / Ruleset 勾选的是这个 **check-run / job 名**，不要只看 workflow 文件标题。

| 情况 | 结果 |
|------|------|
| Label `skip-codex-gate` | 通过（逃生舱） |
| Draft | 通过（ready 后重跑） |
| 还没有 Codex Review Summary，head 提交未满约 20 分钟 | 失败（等待；Codex 发评论会重跑） |
| 20 分钟内从未发 Summary | 失败（超时；`@codex review` 或 `skip-codex-gate`） |
| Summary 仍是 Running / in progress | 失败 |
| Summary 是 Failed / cancelled / error | 失败 |
| Summary 没有明确 **Completed** 或 👍 | 失败（不能只靠「不是 Running」放行） |
| Summary 已完成，但正文没有提到当前 head SHA（反引号 / 纯文本 / commit URL 均可；synchronize 后的旧审查不算） | 失败（等 Codex 重审或 `@codex review`） |
| Summary 已完成，但仍有未解决的 Codex **P0/P1（或未标注）** 行内线程（含人类开帖、Codex 后跟评） | 失败 |
| 完成且无未解决阻塞级 Codex 线程（纯 P2 可保持 open；含 👍 无 finding） | 通过 |

点 Resolve 不会自动重跑。清完线程后：Actions 里 **Re-run** `codex / Codex Review Gate`，或 `workflow_dispatch` 填 PR 号。

---

## Auto-merge 工作流 | What `auto-merge.yml` will squash

`.github/workflows/auto-merge.yml` 只在**同时**满足时 squash 进 `main`：

1. PR 打开、非 draft、base 为 `main`
2. 没有 `no-auto-merge` label
3. head SHA 上必须有一条**成功的 `ci / Build & Test` check run**（或同名 CI）。没有这条 check run → **fail closed**，不用 legacy combined status 凑合
4. 相关 check 已完成且未失败（忽略 Custom LLM Review、以及 Auto Merge 自己的 check 名）。同一 check 名只看**最新一次尝试**，按 **`created_at`** 排名（`id` 平局打破），不用 `completed_at`（旧 run 后结束不能盖住新失败）
5. （已取消）head 上的 `copilot-pull-request-reviewer` check 不再参与判断（缺失、运行中、失败都不阻断）
6. head 上必须有 **`codex / Codex Review Gate`**（这是 **job / check-run 名**，不是 workflow 展示名），且 **`conclusion: success`**（缺失 / `skipped` / `neutral` 都不合）
7. Copilot review 不再是前置条件（`require_copilot: false`）；不自动邀请 Copilot
8. GraphQL `reviewThreads`：**非 Codex** 未解决线程一律阻断；**Codex** 仅阻断未解决 **P0/P1（或未标注）**（纯 P2 可保持 open）。解析失败且仍有 review comments 时 fail-closed

`workflow_run` 只从 **default branch** 上的工作流定义运行。本文件合入 `main` 之后，后续 PR 才吃到新门槛。触发源：CI 成功、`codex / Codex Review Gate` 成功后的 **`workflow_dispatch`**（dispatch 失败则 Gate 记 failure，不发绿勾）、`workflow_run`（Codex Gate / CI）、Copilot 提交 review、或手动 `workflow_dispatch`。没有 `check_run` 触发。`pulls.merge` 带已评估的 **head SHA**，head 变了就拒绝合入。

线程被点 Resolve 后 GitHub **不会**再触发 auto-merge。到 Actions 对 **Auto Merge** 跑一次 `workflow_dispatch`。

---

## `no-auto-merge` 如何关掉自动合入

给 PR 打上 **`no-auto-merge`** 后，`auto-merge.yml` 直接 skip，即使 CI / e2e / Codex 全绿、线程已清。

其他挡自动合入的方式：保持 **draft**，或把 base 改成非 `main`。

去掉该 label 后需要一次新触发才会再评估（CI 重跑、Copilot 再次提交 review、或手动 `workflow_dispatch`）。

---


### GitHub 原生保护 vs 工作流软门槛 | Native protection vs workflow soft gates

GitHub branch protection **没有**严重度 / soft-path 过滤器：

| 原生设置 | 与本仓工作流的关系 |
|----------|-------------------|
| Required check `copilot-pull-request-reviewer` | 不应设为 required；Copilot 已退出 Auto Merge 门槛（`require_copilot: false`）。若原生保护仍要求该 check，缺失时仍会挡合入，应移除这一项；Codex Gate、Build、Secret Scan、QA 仍须通过。 |
| Require conversation resolution | 无作者/严重度例外。若开启，**未 Resolve 的纯 P2 也会挡住** merge。建议：Codex Gate 可对纯 P2 先行绿灯；合入前仍用 `P2: defer — …` Resolve（或关原生 conversation resolution，改信 Auto Merge 的 GraphQL 严重度门槛；若要「P2 真·保持 open 也能 API 合入」，给 `github-actions` bypass）。 |

## 评审严重度 | Review severity (P0 / P1 / P2)

合入前 review 意见按严重度分级。**codex / Codex Review Gate 只阻断未解决的 P0/P1（以及未标注严重度的线程；未标注默认按高优先级 fail-closed）**。P2 可保持 open，或回复 rationale 后 Resolve（无需改代码）；P0/P1 必须先改代码再 Resolve。

| 级别 | 含义 | 合入前要求 |
|------|------|------------|
| **P0** | 阻断：正确性错误、安全漏洞、数据丢失风险 | **必须改代码**，修复后再 Resolve |
| **P1** | 高优先级：实质性缺陷或明显行为回归 | **必须改代码**，修复后再 Resolve |
| **P2** | 可选：风格、命名、小优化、非阻塞建议 | **可不改代码**；可保持 open，或回复后 Resolve |

### P2 无代码改动时的 Resolve 话术

在 thread 中回复其一，再点 Resolve（也可不 Resolve，Gate 不因纯 P2 失败）：

- `P2: defer — <reason>`（本次不做，后续再跟）
- `P2: won't fix — <reason>`（明确不做）

### 未标注严重度时

- Gate / 正确性风险默认按 **P0/P1** 处理（须改代码；未标注会挡住 Codex Gate）
- 纯 nit / style → 显式标 **P2**（可保持 open 或 Resolve + rationale）

### 对 Copilot / Codex

审查评论应显式标注 **P0 / P1 / P2**，便于作者与 Gate 操作对齐。

## 相关文件

| 文件 | 角色 |
|------|------|
| `.github/workflows/auto-merge.yml` | 自动 squash 的判定逻辑 |
| `.github/workflows/ci.yml` | `ci / Build & Test` |
| `.github/workflows/codex-gate.yml` | `codex / Codex Review Gate`（把 Codex 评论变成 check） |
| `.github/workflows/ai-review.yml` | Copilot 请求 job 已禁用；Custom LLM 可选 |
| `docs/COPILOT-WORKFLOW.md` | Copilot Pro 日常用法 |
| `docs/QUALITY.md` | 本地/CI 质量检查 |

<!-- gate e2e 2026-09-09 -->

## 自动修上限（2026-10-20）

- Gate 仍只挡 **P0/P1（及未标注）**；**不要求人类 approve**。
- **同类 P1** 自动修复超过 **3 轮**仍未清零（写死）：三轮上限**只**停自动修循环。**未 Resolve 的 P1 永远挡合入**；重试次数不改变严重度。开跟进 issue/PR 交给人/产品继续修。**严禁**因重试次数 observe / won't-fix / Resolve 放行。禁止为凑绿弱化测试。
