<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />

# Dota2.ai — 战术教练 V3 | Tactical Coach V3

**教玩家做判断，不替玩家玩游戏。**
**Chinese default · English toggle · MIT License**

</div>

---

## 📖 这是什么 | What this is

Dota2.ai 是一个基于 DeepSeek 的 Dota 2 战术教练应用。它尝试回答三个问题：

- **眼前是什么局面** —— 基于可校验的比赛事实（MatchFact），而不是感觉；
- **有哪些选择及代价** —— 把“我该怎么办”拆成可比较的分支与前提；
- **下一局能练什么** —— 保存一个可检查的动作，而不是一整份战报。

四个一级入口（V3 信息架构）：

| 入口 | 内容 |
|------|------|
| **战术室** | 动机入口（刚打完 / 准备开局 / 想练一下）、赛后复盘、战前阵容、装备取舍 |
| **英雄修炼** | 冻结情境 → 先自己判断 → 再看拆解 → 保存练习动作 |
| **英雄图鉴** | 英雄/技能/属性资料层，中文/英文/别名搜索 |
| **战术笔记** | 本机保存的“触发 + 行动 + 检查”，支持完成/撤销/移除/导出 |

### 诚实的边界 | Honest limits

这个项目**承诺“判断更清楚”，不承诺**上分、胜率增益、完美出装或精确胜负预测：

- 现有比赛数据只有统计、分路推断、经济与目标事件，**没有逐时刻坐标/视野**——因此真实复盘使用非空间证据，地图仅为明确标识的教学示意；
- 装备取舍比较的是决策维度（用途/前提/牺牲/改选条件），**不冒充当前补丁的具体数值推荐**；
- 英雄修炼的情境为教学编写，完成标记是**自我报告**，不是已验证的成长分；
- 未连接比赛账号时，不伪造最近比赛、段位或成长分。

设计细节见 [`docs/design/tactical-coach-v3/`](docs/design/tactical-coach-v3/)（产品/交互/视觉设计、A2UI 内部契约、迁移与验收）。

---

## 🧱 技术栈 | Stack

- **前端**：React 18 + TypeScript + Vite + Tailwind（V3 战术色板与既有 k3 并存）
- **后端**：Node/Express（`server.js`），SSE 流式输出
- **AI**：DeepSeek（`deepseek-chat`，OpenAI 兼容客户端）——流式教练、复盘、出装与神秘商人对话
- **数据**：OpenDota / Steam 公开接口（英雄、比赛事实、趋势）

### 架构速览 | Architecture

```
src/
├── app/                  # V3 外壳：WorkspaceShell、导航、导师栏、英雄缓存
├── features/
│   ├── tactical/         # 战术室：动机入口 + 装备取舍工作区
│   ├── review/           # 复盘工作区（包装既有 CoachView 会话）
│   ├── draft/            # 战前阵容工作区
│   ├── practice/         # 英雄修炼（先答后讲）
│   ├── knowledge/        # 英雄图鉴（KnowledgeLens）
│   └── journal/          # 战术笔记（本机存储，失败退化为内存）
├── coach-ui/             # 内部 A2UI 风格组件目录 dota-coach-ui/1：
│   ├── catalog.ts        #   组件/动作白名单（不是官方 A2UI 线协议）
│   ├── runtime.ts        #   beginRun/applyPatch/finishRun/answerEvent 运行时
│   └── components/       #   CoachBrief / DecisionFork / EvidenceLens / …
├── components/           # 既有教练组件（CoachView、ReviewSurface、HeroHub…）
├── services/             # /api 客户端（SSE 流式）
└── utils/                # 复盘/流式/组合逻辑与单元测试
server.js                 # Express：/api/analyze、/api/review/:id、/api/playbook、…
lib/matchReview/          # 比赛事实解析与约束
```

---

## 🚀 本地开发 | Local Development

### 环境要求 | Prerequisites

- Node.js ≥ 18（CI 使用 20）
- npm ≥ 9
- DeepSeek API Key（[获取 | get one](https://platform.deepseek.com/)）

### 安装 | Install

```bash
git clone https://github.com/qianhaoq/dota2.ai.git
cd dota2.ai
npm ci
cp .env.example .env   # 填入 DEEPSEEK_API_KEY
```

### 开发 | Dev

```bash
npm run start:dev      # Vite (http://localhost:5173) + Express (8080)
# 或分开跑 | or separately: npm start (8080) + npm run dev (5173)
```

### 生产 | Production

```bash
npm run build
npm start              # http://localhost:8080
```

### 验证命令 | Verification（PR 前必须全部通过）

```bash
npm test               # vitest 单元测试
npx tsc --noEmit       # 类型检查
npm run build          # 生产构建
node --check server.js # 服务端语法
```

---

## 🔧 环境变量 | Environment Variables

| 变量 | 必需 | 默认 | 说明 |
|------|------|------|------|
| `DEEPSEEK_API_KEY` | ✅ | — | DeepSeek 密钥（GitHub Actions 同名 secret） |
| `STEAM_WEB_API_KEY` | ❌ | — | 本地化英雄名；缺省时回退 OpenDota 常量 |
| `PORT` | ❌ | `8080` | 服务端口（Cloud Run 注入同名变量） |
| `HOST` | ❌ | `0.0.0.0` | 绑定地址 |

完整说明与云端命名见 [`.env.example`](.env.example)。`.env` 已被 gitignore；请勿提交密钥。

---

## 🐳 部署 | Deployment

```bash
# Docker（仅本地 / 受信网络；不要把带密钥的容器直接挂到公网）
docker build -t dota2-ai .
docker run -p 8080:8080 -e DEEPSEEK_API_KEY=your_api_key dota2-ai

# Google Cloud Run（概要；镜像与区域按需调整）
# 推荐：默认 IAM 鉴权（不要加 --allow-unauthenticated），调用方带 identity token；
# 或在前方加 IAP / API Gateway / Cloud Armor 等网关做鉴权与限流。
gcloud builds submit --tag REGION-docker.pkg.dev/YOUR_PROJECT/REPO/dota2-ai
gcloud run deploy dota2-ai --image REGION-docker.pkg.dev/YOUR_PROJECT/REPO/dota2-ai \
  --no-allow-unauthenticated \
  --set-secrets DEEPSEEK_API_KEY=DEEPSEEK_API_KEY:latest
```

容器内 `HOST=0.0.0.0`、`PORT=8080` 已由 Dockerfile 设定；密钥用 Secret Manager（`--set-secrets`）注入，不要写进镜像，也尽量避免明文 `--set-env-vars`。

**诚实说明 / Honest limits：** 当前 Express AI 路由（`/api/analyze`、`/api/review/:matchId`、`/api/chat` 等）**没有**应用层登录鉴权或请求限流；`SECURITY.md` 要求不要在无网关的情况下把服务裸露到公网。生产若仍需公网可达，请先用 **IAM 鉴权 Cloud Run**，或 **IAP / API Gateway / Cloud Armor**（或同类反向代理）挡在前面；应用内真实 auth / rate-limit 仍是后续跟进项，本文不假装代码里已经有。不要把 `--allow-unauthenticated` 当作默认安全部署路径。

---

## 🔄 开发与 CI | Development & CI

| 阶段 | 触发 | 说明 |
|------|------|------|
| GitHub Actions CI | PR / push to main | `tsc` + `node --check` + `build` + `vitest` |
| AI Code Review | PR | Copilot / 自定义 LLM 审查（可选） |
| 合并门禁 | PR | 见 [docs/MERGE_GATES.md](docs/MERGE_GATES.md) 与 [AGENTS.md](AGENTS.md) |

质量与协作规范：[docs/QUALITY.md](docs/QUALITY.md)、[CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 🌍 开源说明 | Open-source notes

- **许可证**：[MIT](LICENSE)（Copyright © 2026 dota2.ai contributors）。
- **商标**：本项目为粉丝作品，与 Valve Corporation 无关联。Dota、Dota 2、Steam 及英雄素材版权归 Valve 所有；运行时数据来自公开 OpenDota / Steam 接口。
- **参与贡献**：见 [CONTRIBUTING.md](CONTRIBUTING.md) —— 一个 PR 一件事、保持双语、不换 AI 提供方、不绕过 CI。
- **安全**：见 [SECURITY.md](SECURITY.md)。建议仓库管理员开启 **Secret scanning + Push protection**（Settings → Code security），防止密钥进入历史。
- **联系**：通过 GitHub Issues（仓库不提供个人邮箱）。

---

## English Summary

Dota2.ai is an open-source (MIT) Dota 2 tactical coach powered by DeepSeek. It teaches judgment instead of playing for you: **Tactical Room** (post-match review, draft preview, item tradeoffs), **Hero Training** (decide first, see the breakdown after), **Hero Codex** (reference layer), and a local-only **Tactical Journal** (trigger / action / check).

Honest limits: match facts include stats, lane inference, economy and objectives — **no per-moment coordinates or vision**, so real reviews use non-spatial evidence and maps are clearly-labeled teaching diagrams. Item tradeoffs compare decision dimensions, not patch-number recommendations. Training completion marks are self-reports, not verified growth.

Stack: React 18 + TypeScript + Vite + Tailwind frontend; Express backend (`server.js`) streaming SSE; DeepSeek (`deepseek-chat`) for coaching; OpenDota/Steam public data. The internal A2UI-style component catalog (`src/coach-ui`, `dota-coach-ui/1`) is an internal domain model — not a claim of official A2UI wire-protocol compatibility. Design docs: [`docs/design/tactical-coach-v3/`](docs/design/tactical-coach-v3/).

Quick start: `npm ci` → `cp .env.example .env` (add `DEEPSEEK_API_KEY`) → `npm run start:dev`. Verify with `npm test && npx tsc --noEmit && npm run build && node --check server.js`. Not affiliated with Valve; see LICENSE, CONTRIBUTING.md and SECURITY.md.
