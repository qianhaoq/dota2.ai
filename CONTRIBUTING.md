# Contributing to dota2.ai

感谢参与 / Thanks for helping. 中文在前，English below.

## 免 key 快速路径（大多数贡献只需要这个）

改教练知识表、英雄/装备名称、复盘规则、文案或前端，**不需要任何 API key**。复盘引擎是纯函数，不联网、不调大模型：

```bash
git clone <your-fork> && cd dota2.ai
npm ci
npx vitest run src/utils/coach    # 教练相关测试，几秒跑完
npm start                         # 可选：先 npm run build；不配 key 也能跑，复盘照常出，追问会退回确定性回答
```

常见的入门改动：

| 想改什么 | 文件 | 验证 |
|---|---|---|
| 某英雄算什么威胁（魔法爆发、连控、闪避…） | `lib/coach/knowledge.js` → `THREAT_TAGS` | `npx vitest run src/utils/coachReport.test.ts` |
| 哪些装备能应对某类威胁 | `lib/coach/knowledge.js` → `ANSWERS` | 同上；装备 key 必须存在于 `lib/coach/data/names.json` |
| 新版本的英雄/装备名称 | `node scripts/coach-names.mjs <版本号>` | `npx vitest run src/utils/coachNames742.test.ts src/coach` |
| 新版本的全部数据快照（OpenDota 常量 + 名称 + 技能 + 职业出装） | `node scripts/refresh-data.mjs --all` | `npx vitest run src/utils/constantsSnapshot.test.ts src/utils/coach*` |

每条知识改动**必须在 PR 里附官方出处**（[官方更新日志](https://www.dota2.com/patches) 的具体条目，或技能/装备说明原文）。凭感觉或二手攻略的数字不收。

## 完整开发环境（需要 key）

只有改大模型相关功能（追问、旧版战术室）时才需要：

```bash
cp .env.example .env   # 填入你自己的 DEEPSEEK_API_KEY
npm run start:dev      # Vite (5173) + Express (8080)
```

## 提交 PR 前

不管走哪条路径，以下命令都必须全部通过（CI 会跑同样的检查）。这些命令都不需要 key：

```bash
npm test               # vitest
npx tsc --noEmit       # 类型检查
npm run build          # 生产构建
node --check server.js # 服务端语法
```

## 外部 PR 如何合并

只有仓库所有者本人的 PR 会自动合并。其他所有 PR（fork、Dependabot 等机器人、协作者的分支）都会被自动加上 `no-auto-merge` 标签（`External PR Guard`）：CI 和 Codex 审查照常运行，但**只有所有者人工审核后才会合并上线**。之后每次推送新提交都会重新加上这个标签。维护者批准的方式是手动合并，或者移除标签，让自动合并接手。

## 约定

- **一个 PR 只做一件事**，并在 PR 描述中填写模板；涉及 SSE / API / 部署的改动请显式标注风险。
- **不要**整个重写 `server.js`，也不要在未被明确要求时更换 AI 提供方（当前为 DeepSeek + OpenAI 兼容客户端）。
- 不要绕过或削弱 CI 门禁。
- 界面保持**英文默认、中文可切换**的双语约定；DeepSeek/API 输出须跟随 UI 语言。
- 英雄、装备数值与背景以仓库数据和公开 API 为准；**不编造** Dota 设定或平衡数字。
- 教学演示内容必须带“教学”标识，不得冒充真实比赛数据；没有坐标/视野数据就不画“真实位置”。
- `mentorId`、`practiceHeroId`、`focusPlayerSlot` 是三个独立概念，不要合并成一个状态。
- 内部 A2UI 风格组件目录为 `dota-coach-ui/1`（`src/coach-ui/`），它**不是**官方 A2UI 线协议；不要宣称协议兼容。

## 安全

- 不要提交 `.env`、API 密钥或他人隐私数据（比赛 ID、Steam ID 属于他人数据）。
- 产品反馈：应用内「反馈 / Feedback」打开站内留言表单，提交到 `/api/feedback`（stdout `[feedback:record]` → Cloud Logging；本地另有 best-effort `data/feedback.jsonl`）；贡献与缺陷讨论仍走 GitHub Issues。
- 建议仓库管理员开启 Secret scanning 与 Push protection（见 `SECURITY.md`）。

## 商标与版权说明

本项目是开源的粉丝作品，**与 Valve Corporation 无关联，也未获得其授权或赞助**。Dota、Dota 2、Steam 以及所有英雄名称、形象和素材版权归 Valve 所有。运行时引用的英雄数据来自公开的 OpenDota / Steam 接口。请勿以暗示官方背书的方式使用这些名称或素材。

---

## No-key quick path (EN) — most contributions need only this

Changing the coach's knowledge tables, hero/item names, review rules, copy or UI needs **no API key**. The review engine is pure: no network, no LLM.

```bash
git clone <your-fork> && cd dota2.ai
npm ci
npx vitest run src/utils/coach    # coach tests, a few seconds
npm start                         # optional, after npm run build; runs without keys (follow-ups fall back to deterministic answers)
```

| To change | File | Check with |
|---|---|---|
| Which threat a hero poses (magic burst, chain disables, evasion…) | `lib/coach/knowledge.js` → `THREAT_TAGS` | `npx vitest run src/utils/coachReport.test.ts` |
| Which items answer a threat | `lib/coach/knowledge.js` → `ANSWERS` | same; item keys must exist in `lib/coach/data/names.json` |
| Names after a new patch | `node scripts/coach-names.mjs <patch>` | `npx vitest run src/utils/coachNames742.test.ts src/coach` |
| Every data snapshot after a patch (OpenDota constants, names, abilities, pro items) | `node scripts/refresh-data.mjs --all` | `npx vitest run src/utils/constantsSnapshot.test.ts src/utils/coach*` |

Every knowledge change **must cite an official source** in the PR (the exact line from the [patch notes](https://www.dota2.com/patches), or the ability/item text). Numbers from memory or third-party guides are not accepted.

## Full setup (EN, needs a key)

Only for LLM features (follow-up questions, the legacy tactical room):

```bash
cp .env.example .env    # add your own DEEPSEEK_API_KEY
npm run start:dev       # Vite dev server + Express API
```

## Before you open a PR (EN)

Whichever path you took, all of these must pass (CI runs the same checks; none needs a key):

```bash
npm test && npx tsc --noEmit && npm run build && node --check server.js
```

## How external PRs merge

Only the repository owner's own PRs merge automatically. Every other PR (forks, Dependabot and other bots, collaborators' branches) gets the `no-auto-merge` label automatically (`External PR Guard`). CI and the Codex review still run, but **nothing merges or deploys until the owner has reviewed it**. The label is re-added on every new push. A maintainer approves by merging by hand, or by removing the label so Auto Merge can take over.

## Conventions

- One focused PR per issue; fill in the PR template and flag streaming / API / deploy risk.
- Do **not** rewrite `server.js` wholesale or swap the AI provider (DeepSeek via the OpenAI-compatible client) without an explicit ask.
- Do not weaken or bypass CI gates.
- Keep the UI bilingual: English default, Chinese via toggle; DeepSeek/API output must follow UI lang.
- Hero/lore/numbers come from repo data and public APIs — never invented.
- Teaching demos must be labeled as demos; never fake live-match data, positions or vision.
- `mentorId`, `practiceHeroId` and `focusPlayerSlot` are separate concepts.
- The internal component catalog is `dota-coach-ui/1` (`src/coach-ui/`) — an internal A2UI-*inspired* domain model, **not** the official A2UI wire protocol.

## Security

- Never commit `.env`, API keys, or other people's data (match IDs / Steam IDs included).
- Product feedback: in-app Feedback opens a leave-a-message form that POSTs to `/api/feedback` (durable: stdout `[feedback:record]` → Cloud Logging; local best-effort `data/feedback.jsonl`); contribution/bug discussion still via GitHub Issues.
- Maintainers: enable Secret scanning and Push protection (see `SECURITY.md`).

## Trademark notice

This is an open-source fan project, not affiliated with, endorsed or sponsored by Valve Corporation. Dota, Dota 2, Steam, and all hero names and assets are trademarks of Valve. Hero data is fetched from public OpenDota / Steam endpoints at runtime. Do not use these names or assets in ways that imply official endorsement.
