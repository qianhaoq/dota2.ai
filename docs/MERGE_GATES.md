# 合并门槛 | Merge gates

PR #33 在 CI 全绿、Copilot 只留下 `COMMENTED`（“Needs a closer look”）且行内讨论未解决时，仍可被自动合入。本页说明仓库级硬门槛，以及 `auto-merge.yml` 何时才会 squash。

This page is the source of truth for merge policy. Workflow automation cannot replace repository rules the human owner must enable.

---

## 人类必须在 GitHub 打开的仓库设置 | Required repo settings

这些设置**不会**随本仓库 YAML 自动生效，需要仓库管理员在 GitHub UI 确认。若尚未开启，请现在打开。

**Settings → Rules → Rulesets**（推荐）或旧版 **Settings → Branches**：

对 `main` 建一条 Ruleset（或 branch protection），至少包含：

| 设置 | 为什么 |
|------|--------|
| **Require status checks to pass before merging** | 没有绿勾不能合 |
| Required check: **`Build & Test`** | CI job 名（见 `.github/workflows/ci.yml`） |
| Required check: **`copilot-pull-request-reviewer`** | Copilot 官方审查 check；没有它 Ruleset 会等到该 check 出现并成功 |
| **Require conversation resolution before merging** | 未解决的行内线程（Copilot / Codex / 人类）会挡住 Merge 按钮 |
| （可选）**Dismiss stale pull request approvals when new commits are pushed** | 新 push 后旧的 APPROVED 作废，避免审的是过期 SHA |

不要把 **Custom LLM Review** 或本仓库 `ai-review.yml` 里的 **Copilot Review**（只负责 *request* 审查）设为必需。前者是可选补充；后者成功只表示“已请求”，不表示 Copilot 已 `APPROVED`。

---

## Auto-merge 工作流 | What `auto-merge.yml` will squash

`.github/workflows/auto-merge.yml` 只在**同时**满足时 squash 进 `main`：

1. PR 打开、非 draft、base 为 `main`
2. 没有 `no-auto-merge` label
3. head SHA 上 **Build & Test**（或名为 CI 的检查）成功
4. 相关 check 已完成且未失败（忽略 Custom LLM Review、以及本 workflow 自己的 check 名）
5. 若 head SHA 上存在 `copilot-pull-request-reviewer` check，则必须已成功结束
6. **该 head SHA 上最新一条 Copilot review 必须是 `APPROVED`**
   - `COMMENTED`（包括 “Needs a closer look”）**不会**自动合入
   - `CHANGES_REQUESTED` **不会**自动合入
7. GraphQL `reviewThreads` 全部 `isResolved: true`（解析失败且仍有 review comments 时 fail-closed）

`workflow_run` 只从 **default branch** 上的工作流定义运行。本文件合入 `main` 之后，后续 PR 才吃到新门槛。

线程被点 Resolve 后 GitHub **不会**再触发本 workflow。若 Copilot 已是 `APPROVED`、只差线程，到 Actions 里对 **Auto Merge** 跑一次 `workflow_dispatch` 并填 PR 号。

---

## Codex 不是原生必需 check | Codex is comment-only

[Codex](https://chatgpt.com/codex)（`chatgpt-codex-connector[bot]`）以 **PR review comments / 行内线程** 发言，**不会**注册成 GitHub Checks 里的必过项。

因此：

- 无法把 Codex 配成 Ruleset 的 required status check
- 硬停止靠：**Require conversation resolution before merging**（挡 Merge 按钮）+ auto-merge 的「未解决线程数必须为 0」
- 合入前请读 Codex / Copilot 的 bot 评论；点 Resolve 等于承认已处理或明确忽略

---

## `no-auto-merge` 如何关掉自动合入

给 PR 打上 label **`no-auto-merge`** 后，`auto-merge.yml` 直接 skip，即使 CI 绿、Copilot 已 `APPROVED`、线程已清。

其他挡自动合入的方式：保持 **draft**，或把 base 改成非 `main`。

去掉该 label 后，需要一次新的触发才会再评估（CI 重跑、Copilot 再次 `APPROVED`、或手动 `workflow_dispatch`）。

---

## 相关文件

| 文件 | 角色 |
|------|------|
| `.github/workflows/auto-merge.yml` | 自动 squash 的判定逻辑 |
| `.github/workflows/ci.yml` | `Build & Test` |
| `.github/workflows/ai-review.yml` | 请求 Copilot review；Custom LLM 可选 |
| `docs/COPILOT-WORKFLOW.md` | Copilot Pro 日常用法 |
| `docs/QUALITY.md` | 本地/CI 质量检查 |
