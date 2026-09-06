# 质量门禁指南 | Quality Gates Guide

本文档说明如何配置和使用本仓库的 CI 质量门禁和 AI 代码审查功能。

---

## 📋 概览 | Overview

| 检查 | 类型 | 合并要求 | 说明 |
|------|------|---------|------|
| **build-and-test** | CI | ✅ 必需 | TypeScript、构建、测试 |
| **Copilot Review** | AI | 推荐 | GitHub Copilot 代码审查（无需 API 密钥）|
| **Custom LLM Review** | AI | ⏭️ 可选 | DeepSeek/OpenAI/xAI（需 API 密钥）|

---

## 🤖 AI 代码审查 | AI Code Review

### 主要方案：GitHub Copilot（推荐）

**无需 API 密钥** — 直接使用你的 GitHub Copilot 订阅。

#### 启用自动审查

1. 进入仓库 **Settings → Copilot → Code review**
2. 在 Branch rules 下，勾选 **Automatically request Copilot review**
3. 选择审查深度：
   - **Lite**: 标准审查
   - **Balanced**: 深度分析（复杂逻辑、安全敏感代码）

#### 工作流行为

- 每个 PR 自动请求 `copilot-pull-request-reviewer` 审查
- 若要禁用，设置变量 `DISABLE_COPILOT_REVIEW=true`

#### 相关文档

- [GitHub Copilot Code Review](https://docs.github.com/en/copilot/concepts/agents/code-review)
- [配置自动审查](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-automatic-review)

---

### 可选方案：自定义 LLM 审查

如果希望在 Copilot 之外增加额外的 LLM 审查，可配置 API 密钥。

**这是可选的，不影响合并。**

#### 支持的提供商

| 提供商 | Secret 名称 | 默认模型 |
|--------|-------------|----------|
| DeepSeek | `DEEPSEEK_API_KEY` | deepseek-chat |
| OpenAI | `OPENAI_API_KEY` | gpt-4o-mini |
| xAI (Grok) | `XAI_API_KEY` | grok-2-latest |

#### 配置步骤

1. **Settings → Secrets and variables → Actions → New repository secret**
2. 添加对应的 API 密钥
3. （可选）设置变量 `AI_REVIEW_PROVIDER` = `openai` | `deepseek` | `xai`
4. （可选）设置变量 `AI_REVIEW_MODEL` 自定义模型

#### 未配置时的行为

- 工作流正常完成（SUCCESS）
- Job Summary 显示跳过说明
- 不发布审查评论
- **不阻塞 CI 或合并**

---

## 🔒 必需检查：build-and-test

这是唯一的硬性合并要求。

| 步骤 | 命令 | 说明 |
|------|------|------|
| TypeScript | `npx tsc --noEmit` | 类型安全检查 |
| Server Syntax | `node --check server.js` | 服务器语法验证 |
| Build | `npm run build` | Vite 生产构建 |
| Test | `npm test` | Vitest 单元测试 |

---

## 🛡️ 推荐分支保护配置

### 基础配置（推荐）

**Settings → Branches → Add rule**

```
Branch name pattern: main

✅ Require a pull request before merging
✅ Require status checks to pass before merging
   ✅ Require branches to be up to date
   Required checks:
     - build-and-test  ← 必需
✅ Require conversation resolution before merging
```

### 说明

- `build-and-test` 是唯一的硬性要求
- Copilot Review 和 Custom LLM Review 不设为必需检查
- AI 审查提供建议，但不阻塞合并流程

---

## 🚀 本地开发检查

提交 PR 前建议运行：

```bash
# TypeScript 检查
npx tsc --noEmit

# 服务器语法
node --check server.js

# 构建
npm run build

# 测试
npm test
```

---

## 🔧 故障排查

### Copilot 审查不工作

1. 确认已启用 Copilot 订阅（Pro/Pro+/Business/Enterprise）
2. 进入 **Settings → Copilot → Code review** 检查配置
3. 确认 `copilot-pull-request-reviewer` 已启用为协作者

### Custom LLM 审查不工作

1. 检查 Secret 是否正确配置
2. 验证 API 密钥是否有效
3. 查看 Job Summary 中的错误信息

### CI 失败

1. 查看 Actions 页面的具体错误
2. 本地复现：运行上述检查命令
3. 常见问题：TypeScript 类型错误、测试失败

---

## 📚 相关链接

- [GitHub Actions](https://docs.github.com/en/actions)
- [GitHub Copilot Code Review](https://docs.github.com/en/copilot/concepts/agents/code-review)
- [Branch Protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches)
