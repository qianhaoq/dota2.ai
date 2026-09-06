# 质量门禁指南 | Quality Gates Guide

本文档说明如何配置和使用本仓库的 CI 质量门禁和 AI 代码审查功能。

This guide explains how to configure and use CI quality gates and AI code review for this repository.

---

## 📋 CI 工作流概览 | CI Workflow Overview

| 工作流 | 文件 | 触发条件 | 说明 |
|--------|------|---------|------|
| **CI** | `ci.yml` | PR / push to main | 构建、类型检查、测试 |
| **AI Review** | `ai-review.yml` | PR only | AI 代码审查（可选） |

---

## 🔒 必需检查 | Required Checks

### build-and-test

这是核心 CI 检查，包含：

| 步骤 | 命令 | 说明 |
|------|------|------|
| TypeScript Check | `npx tsc --noEmit` | 类型安全检查 |
| Server Syntax | `node --check server.js` | 服务器语法验证 |
| Build | `npm run build` | Vite 生产构建 |
| Test | `npm test` | Vitest 单元测试 |

**推荐的分支保护设置 | Recommended Branch Protection:**

1. 进入 **Settings → Branches → Add rule**
2. Branch name pattern: `main`
3. ✅ Require status checks to pass before merging
4. ✅ Require branches to be up to date
5. 选择 `build-and-test` 作为必需检查
6. ✅ Require conversation resolution before merging

---

## 🤖 AI 代码审查 | AI Code Review

AI 审查是可选功能，支持多种 LLM 提供商。当配置了 API 密钥时，每个 PR 会自动收到 AI 审查评论。

### 支持的提供商 | Supported Providers

| 提供商 | 变量值 | Secret 名称 | 默认模型 | API 端点 |
|--------|--------|-------------|----------|----------|
| OpenAI | `openai` | `OPENAI_API_KEY` | gpt-4o-mini | api.openai.com |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | deepseek-chat | api.deepseek.com |
| xAI (Grok) | `xai` | `XAI_API_KEY` | grok-2-latest | api.x.ai |

### 配置步骤 | Configuration Steps

#### 1. 添加 API 密钥 | Add API Key

进入 **Settings → Secrets and variables → Actions → New repository secret**

```
Name: DEEPSEEK_API_KEY  (或 OPENAI_API_KEY / XAI_API_KEY)
Value: sk-xxxxxx...
```

> 💡 也可以使用通用名称 `AI_REVIEW_API_KEY`，会根据 provider 自动选择端点。

#### 2. 设置提供商（可选）| Set Provider (Optional)

默认使用 DeepSeek。如需更换，进入 **Settings → Secrets and variables → Actions → Variables**：

```
Name: AI_REVIEW_PROVIDER
Value: openai  (或 deepseek / xai)
```

#### 3. 自定义模型（可选）| Custom Model (Optional)

```
Name: AI_REVIEW_MODEL
Value: gpt-4o  (或其他模型名)
```

### AI 审查内容 | What AI Reviews

AI 审查会关注以下方面：

- 🔒 **安全风险** - API 密钥泄露、XSS、注入攻击
- 🐛 **Bug 风险** - 空值检查、竞态条件、React 流式展示的闭包陷阱
- ⚡ **性能问题** - 不必要的重渲染、内存泄漏
- 🧪 **测试覆盖** - 关键路径缺少测试
- 📦 **部署风险** - 破坏性变更、环境变量问题

### 无 API 密钥时的行为 | Behavior Without API Key

当未配置 API 密钥时：
- ✅ 工作流会成功完成（不会阻塞 CI）
- ℹ️ Job Summary 显示配置说明
- ❌ 不会发布审查评论

这意味着你可以先合并代码，稍后再配置 AI 审查。

---

## 🔄 GitHub Copilot 代码审查 | GitHub Copilot Review

除了自定义 LLM 审查，还可以启用 GitHub 原生的 Copilot 代码审查。

### 启用步骤 | How to Enable

1. **组织/仓库级别启用 Copilot**
   - 进入组织设置 → Copilot → Policies
   - 或仓库设置 → General → Features

2. **启用 Copilot 代码审查**
   - Settings → General → Features → Copilot code review

3. **配置工作流变量**
   
   进入 **Settings → Secrets and variables → Actions → Variables**：
   ```
   Name: ENABLE_COPILOT_REVIEW
   Value: true
   ```

4. **工作流会自动请求 Copilot 审查**

> ⚠️ Copilot 代码审查需要 GitHub Copilot Enterprise 或 Copilot for Business。

---

## 🛡️ 完整分支保护配置 | Full Branch Protection

推荐的 `main` 分支保护配置：

### 基础配置 | Basic Setup

```yaml
# Settings → Branches → Add rule
Branch name pattern: main

✅ Require a pull request before merging
  ✅ Require approvals: 1 (可选)
  ✅ Dismiss stale pull request approvals when new commits are pushed

✅ Require status checks to pass before merging
  ✅ Require branches to be up to date
  Required checks:
    - build-and-test  ← 必需
    - ai-review       ← 可选（配置 API 密钥后启用）

✅ Require conversation resolution before merging
```

### 高级配置（可选）| Advanced Setup (Optional)

```yaml
✅ Require signed commits
✅ Require linear history
✅ Include administrators
```

---

## 🚀 本地开发检查 | Local Development Checks

在提交 PR 前，建议在本地运行以下检查：

```bash
# TypeScript 检查 | Type check
npx tsc --noEmit

# 服务器语法 | Server syntax
node --check server.js

# 构建 | Build
npm run build

# 测试 | Test
npm test
```

### Git Hooks（可选）| Git Hooks (Optional)

可以使用 husky 配置 pre-commit hooks：

```bash
npm install -D husky
npx husky init
echo "npx tsc --noEmit" > .husky/pre-commit
```

---

## 📊 CI 性能优化 | CI Performance

当前 CI 包含以下优化：

- **npm 缓存** - `setup-node` 自动缓存 npm 依赖
- **并发控制** - 同一 PR 的旧工作流会被取消
- **超时限制** - 10 分钟超时防止卡死

---

## 🔧 故障排查 | Troubleshooting

### CI 失败 | CI Failure

1. 查看 Actions 页面的具体错误
2. 本地复现：运行上述检查命令
3. 常见问题：
   - TypeScript 类型错误
   - 测试失败
   - 构建错误

### AI 审查不工作 | AI Review Not Working

1. 确认 Secret 已正确配置
2. 检查 Job Summary 中的错误信息
3. 验证 API 密钥是否有效
4. 确认 API 额度是否充足

### Copilot 审查不工作 | Copilot Review Not Working

1. 确认已启用 Copilot for the repository
2. 确认 `ENABLE_COPILOT_REVIEW` 变量设置为 `true`
3. Copilot 需要 Enterprise 或 Business 订阅

---

## 📚 相关文档 | Related Documentation

- [GitHub Actions 文档](https://docs.github.com/en/actions)
- [GitHub Branch Protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches)
- [GitHub Copilot Code Review](https://docs.github.com/en/copilot/using-github-copilot/code-review/using-copilot-code-review)
- [DeepSeek API](https://platform.deepseek.com/docs)
- [OpenAI API](https://platform.openai.com/docs)
- [xAI Grok API](https://docs.x.ai/docs)
