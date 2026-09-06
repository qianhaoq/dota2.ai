# Copilot Pro 工作流 | Copilot Pro workflow

本仓库已接好 Copilot Pro 最小配置。账号侧：GitHub **Free** + **Copilot Pro**（约 1500 AI credits / 月）。

## 仓库里有什么

| 文件 | 作用 |
|------|------|
| `.github/copilot-instructions.md` | 全仓产品/栈/质量约定 |
| `AGENTS.md` | 给 Agent 的短操作手册 |
| `.github/instructions/*.instructions.md` | 按路径生效的细则 |
| `.github/workflows/copilot-setup-steps.yml` | 云端 Agent 开工前装 Node 20 + `npm ci` |
| 现有 `ci.yml` | PR 质量门禁 |

## 推荐用法（Issue → Agent → CI → Review → 人合并）

1. **开 Issue**：写清验收标准（改什么、怎么验证、不要做什么）。大需求拆成多个 Issue。
2. **交给云端 Agent**：在 Issue 上 Assign Copilot，或用 “Create a pull request with Copilot”。
3. **等 Draft PR**：Agent 会开分支；确认 CI `build-and-test` 绿。
4. **Copilot review**：Settings → Copilot → Code review → Auto-review（或手动 Request Copilot review）。
5. **人合并**：你看完再 merge；AI approve ≠ 可以免审。

## Credits 省着用

- 行内补全 / Next Edit：**不吃** credits。
- Chat、云端 Agent、Spaces、CLI：**吃** credits。
- 单次云端 Agent 有时长上限；大活拆小。

## 可选加强

- 需要 Agent 调真实 DeepSeek：在仓库 **Copilot Agents secrets** 配 `DEEPSEEK_API_KEY`（不要写进代码）。
- 私有仓要强制 CODEOWNERS / 分支保护：另开 **GitHub Pro**（与 Copilot 无关）。
