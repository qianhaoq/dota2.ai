# Contributing to dota2.ai

感谢参与 / Thanks for helping. 中文在前，English below.

## 快速开始（中文）

```bash
git clone <your-fork>
cd dota2.ai
npm ci
cp .env.example .env   # 填入你自己的 DEEPSEEK_API_KEY
npm run start:dev      # Vite (5173) + Express (8080)
```

提交 PR 前，以下命令必须全部通过（CI 会跑同样的检查）：

```bash
npm test               # vitest
npx tsc --noEmit       # 类型检查
npm run build          # 生产构建
node --check server.js # 服务端语法
```

## 约定

- **一个 PR 只做一件事**，并在 PR 描述中填写模板；涉及 SSE / API / 部署的改动请显式标注风险。
- **不要**整个重写 `server.js`，也不要在未被明确要求时更换 AI 提供方（当前为 DeepSeek + OpenAI 兼容客户端）。
- 不要绕过或削弱 CI 门禁。
- 界面保持**中文默认、英文可切换**的双语约定。
- 英雄、装备数值与背景以仓库数据和公开 API 为准；**不编造** Dota 设定或平衡数字。
- 教学演示内容必须带“教学”标识，不得冒充真实比赛数据；没有坐标/视野数据就不画“真实位置”。
- `mentorId`、`practiceHeroId`、`focusPlayerSlot` 是三个独立概念，不要合并成一个状态。
- 内部 A2UI 风格组件目录为 `dota-coach-ui/1`（`src/coach-ui/`），它**不是**官方 A2UI 线协议；不要宣称协议兼容。

## 安全

- 不要提交 `.env`、API 密钥或他人隐私数据（比赛 ID、Steam ID 属于他人数据）。
- 联系渠道只有 GitHub Issues，仓库不提供个人邮箱。
- 建议仓库管理员开启 Secret scanning 与 Push protection（见 `SECURITY.md`）。

## 商标与版权说明

本项目是开源的粉丝作品，**与 Valve Corporation 无关联，也未获得其授权或赞助**。Dota、Dota 2、Steam 以及所有英雄名称、形象和素材版权归 Valve 所有。运行时引用的英雄数据来自公开的 OpenDota / Steam 接口。请勿以暗示官方背书的方式使用这些名称或素材。

---

## Getting started (EN)

```bash
npm ci
cp .env.example .env    # add your own DEEPSEEK_API_KEY
npm run start:dev       # Vite dev server + Express API
```

All of these must pass before a PR (CI runs the same checks):

```bash
npm test && npx tsc --noEmit && npm run build && node --check server.js
```

## Conventions

- One focused PR per issue; fill in the PR template and flag streaming / API / deploy risk.
- Do **not** rewrite `server.js` wholesale or swap the AI provider (DeepSeek via the OpenAI-compatible client) without an explicit ask.
- Do not weaken or bypass CI gates.
- Keep the UI bilingual: Chinese default, English toggle.
- Hero/lore/numbers come from repo data and public APIs — never invented.
- Teaching demos must be labeled as demos; never fake live-match data, positions or vision.
- `mentorId`, `practiceHeroId` and `focusPlayerSlot` are separate concepts.
- The internal component catalog is `dota-coach-ui/1` (`src/coach-ui/`) — an internal A2UI-*inspired* domain model, **not** the official A2UI wire protocol.

## Security

- Never commit `.env`, API keys, or other people's data (match IDs / Steam IDs included).
- Contact happens through GitHub Issues only; no personal email is offered.
- Maintainers: enable Secret scanning and Push protection (see `SECURITY.md`).

## Trademark notice

This is an open-source fan project, not affiliated with, endorsed or sponsored by Valve Corporation. Dota, Dota 2, Steam, and all hero names and assets are trademarks of Valve. Hero data is fetched from public OpenDota / Steam endpoints at runtime. Do not use these names or assets in ways that imply official endorsement.
