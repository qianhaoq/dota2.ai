# Copilot Pro 工作流 | Copilot Pro workflow

本仓库已接好 Copilot Pro 最小配置。账号侧：GitHub **Free** + **Copilot Pro**（约 1500 AI credits / 月）。

## 仓库里有什么

| 文件 | 作用 |
|------|------|
| `.github/copilot-instructions.md` | 全仓产品/栈/质量约定 |
| `AGENTS.md` | 给 Agent 的短操作手册 |
| `.github/instructions/*.instructions.md` | 按路径生效的细则 |
| `.github/workflows/copilot-setup-steps.yml` | 云端 Agent 开工前装 Node 20 + `npm ci` |
| `.github/workflows/ai-review.yml` | PR 打开时请求 Copilot review |
| `.github/workflows/auto-merge.yml` | **CI 全绿 + Copilot 审完（未要求修改）→ 自动 squash 合入** |
| 现有 `ci.yml` | PR 质量门禁（tsc / build / test） |

## 默认策略（你选的）

1. **默认 Copilot review**：Ruleset / Settings 自动请求；`ai-review.yml` 再兜底请求一次。
2. **不必等人合并**：`auto-merge.yml` 在满足下面条件时自动 squash 进 `main`：
   - 不是 draft
   - 没有 `no-auto-merge` label
   - CI（Build & Test）成功
   - Copilot 已提交 review，且不是 `CHANGES_REQUESTED`（`APPROVED` 或 `COMMENTED` 都行）
3. 需要人工把关时：给 PR 打上 `no-auto-merge`，或保持 draft。

## 推荐用法（Issue → Agent → CI → AI review → 自动合入）

1. **开 Issue**：写清验收标准（改什么、怎么验证、不要做什么）。大需求拆小。
2. **交给云端 Agent**：Issue 上 Assign Copilot，或 “Create a pull request with Copilot”。
3. **等 PR**：Agent 开分支；CI 跑自测；Copilot 自动 review。
4. **全绿即合**：通过后 `Auto Merge` workflow 会 squash；你只需在失败或 `CHANGES_REQUESTED` 时介入。

## Credits 省着用

- 行内补全 / Next Edit：**不吃** credits。
- Chat、云端 Agent、Spaces、CLI、**Code review**：**吃** credits。
- 单次云端 Agent 有时长上限；大活拆小。

## 可选加强

- Agent 要调真实 DeepSeek：在仓库 **Copilot Agents secrets** 配 `DEEPSEEK_API_KEY`。
- 强制分支保护 / CODEOWNERS：另开 **GitHub Pro**（与 Copilot 无关）。
- `workflow_run` 类自动合入要等本文件合进 **default branch** 后才对后续 PR 生效。
