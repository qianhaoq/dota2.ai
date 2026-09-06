# 合并门槛 | Merge gates

PR #33 在 CI 全绿、Copilot 只给 `COMMENTED`（“Needs a closer look”）、Codex 行内意见未解决时，仍可被合入。本页说明仓库级硬门槛。

This page is the source of truth for merge policy.

---

## 先读：个人私有仓库 Ruleset 不生效 | Private personal repo

本仓库是 **个人账号下的 private repo**。GitHub 可能把 Repository Ruleset 显示为 **Active**，但会警告：在升级到 **Team / Organization** 之前 **不会真正 enforce**。

因此：

1. **不要指望 Ruleset 挡合并。** 它看起来开着，Merge 按钮和 API 仍可能放行。
2. **对 `main` 用经典 Branch protection**（Settings → Branches → Add rule），而不是只配 Ruleset。
3. 经典保护才能把下面的 **status checks** 变成硬门槛（需要账号具备 Branch protection 权限；私有仓库通常要 GitHub Pro）。

---

## 人类必须打开的 `main` 保护 | Required protection on `main`

**Settings → Branches → Branch protection rule**（pattern: `main`）：

| 设置 | 为什么 |
|------|--------|
| **Require status checks to pass before merging** | 没有绿勾不能合 |
| Required check: **`Build & Test`** | CI job 名（`.github/workflows/ci.yml`） |
| Required check: **`copilot-pull-request-reviewer`** | Copilot 官方审查 check |
| Required check: **`Codex Review Gate`** | 本仓库 workflow 把 Codex 评论变成原生 check（见下） |
| **Require conversation resolution before merging** | 未解决的行内线程挡住 Merge 按钮 |
| （可选）**Dismiss stale pull request approvals when new commits are pushed** | 新 push 后旧 APPROVED 作废 |

**Copilot 的 required check 不覆盖 Codex。** `copilot-pull-request-reviewer` 只反映 Copilot。Codex（`chatgpt-codex-connector[bot]`）从不注册那个 check。

不要把 **Custom LLM Review** 或 `ai-review.yml` 里的 **Copilot Review**（只负责 *request* 审查）设为必需。

---

## Codex Review Gate

[Codex](https://chatgpt.com/codex) 只发 **issue comment**（`<!-- codex-pull-request-review-summary -->`）和行内 review threads，**不是** GitHub 原生 required check。

`.github/workflows/codex-gate.yml` 提供名为 **`Codex Review Gate`** 的 job，供经典 branch protection 勾选：

| 情况 | 结果 |
|------|------|
| Label `skip-codex-gate` | 通过（逃生舱） |
| Draft | 通过（ready 后重跑） |
| 还没有 Codex Review Summary，head 提交未满约 20 分钟 | 失败（等待；Codex 发评论会重跑） |
| 20 分钟内从未发 Summary | 失败（超时；`@codex review` 或 `skip-codex-gate`） |
| Summary 仍是 Running / in progress | 失败 |
| Summary 已完成，但仍有未解决的 Codex 行内线程 | 失败 |
| 完成且无未解决 Codex 线程（含 👍 无 finding） | 通过 |

点 Resolve 不会自动重跑。清完线程后：Actions 里 **Re-run** `Codex Review Gate`，或 `workflow_dispatch` 填 PR 号。

---

## Auto-merge 工作流 | What `auto-merge.yml` will squash

`.github/workflows/auto-merge.yml` 只在**同时**满足时 squash 进 `main`：

1. PR 打开、非 draft、base 为 `main`
2. 没有 `no-auto-merge` label
3. head SHA 上 **Build & Test**（或名为 CI 的检查）成功
4. 相关 check 已完成且未失败（忽略 Custom LLM Review、以及 Auto Merge 自己的 check 名；**不忽略** Codex Review Gate）
5. 若 head SHA 上存在 `copilot-pull-request-reviewer` check，则必须已成功结束
6. **该 head SHA 上最新一条 Copilot review 必须是 `APPROVED`**
   - `COMMENTED`（包括 “Needs a closer look”）**不会**自动合入
   - `CHANGES_REQUESTED` **不会**自动合入
7. GraphQL `reviewThreads` 全部 `isResolved: true`（解析失败且仍有 review comments 时 fail-closed）

`workflow_run` 只从 **default branch** 上的工作流定义运行。本文件合入 `main` 之后，后续 PR 才吃到新门槛。

线程被点 Resolve 后 GitHub **不会**再触发 auto-merge。若 Copilot 已是 `APPROVED`、只差线程，到 Actions 对 **Auto Merge** 跑一次 `workflow_dispatch`。

---

## `no-auto-merge` 如何关掉自动合入

给 PR 打上 **`no-auto-merge`** 后，`auto-merge.yml` 直接 skip，即使 CI 绿、Copilot 已 `APPROVED`、线程已清。

其他挡自动合入的方式：保持 **draft**，或把 base 改成非 `main`。

去掉该 label 后需要一次新触发才会再评估（CI 重跑、Copilot 再次 `APPROVED`、或手动 `workflow_dispatch`）。

---

## 相关文件

| 文件 | 角色 |
|------|------|
| `.github/workflows/auto-merge.yml` | 自动 squash 的判定逻辑 |
| `.github/workflows/ci.yml` | `Build & Test` |
| `.github/workflows/codex-gate.yml` | `Codex Review Gate`（把 Codex 评论变成 check） |
| `.github/workflows/ai-review.yml` | 请求 Copilot review；Custom LLM 可选 |
| `docs/COPILOT-WORKFLOW.md` | Copilot Pro 日常用法 |
| `docs/QUALITY.md` | 本地/CI 质量检查 |
