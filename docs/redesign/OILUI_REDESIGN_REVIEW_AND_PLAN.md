# dota2.ai 改版计划独立评审与修订执行方案（v2）

> 基准：`main @ d80c061` · 评审对象：[`docs/redesign/OILUI_REDESIGN_PLAN.md`](./OILUI_REDESIGN_PLAN.md)
> 参考方法：[Oil UI](https://ui.oiloil.org/)（`fix-ai-ui-slop`、`landing-page-design`、`dashboard-workspace-design`）
> 状态：**独立评审与修订计划（待确认后按 PR-1 → PR-4 依次实施）**

---

## 一、总体评审结论

**方向认可，拆分顺序正确，但不建议按原稿直接开工。**

原计划的 4 个 PR 顺序（`PR-1 远程 MCP` → `PR-2 首页` → `PR-3 复盘工作台` → `PR-4 玩家页`）逻辑自洽：先兑现远程 8 工具的后端承诺，再在首页把 Web / MCP / CLI / HTTP 四种入口摆到首屏，最后升级复盘页和玩家页。

但对照 `main @ d80c061` 源码、现有单测/E2E 以及 Oil UI 原则逐项核查后，发现 **14 处明确的技术盲区、已有测试冲突与 P1 风险点**（下表标注了精确文件行号）。若不先修正，将在 PR-1～PR-4 实施阶段反复触发 Codex P1 或 CI/E2E 红灯。

---

## 二、独立评审发现清单（按 PR 与严重度）

### PR-1：远程 MCP 补齐 8 工具

| # | 严重度 | 核实位置 | 原计划盲区 / 风险 | 修订方案 |
|---|---|---|---|---|
| 1.1 | **P1** | `server.js:689` vs `705–779`；`lib/coach/router.js:57` | `createV1Router` 在 `coachCases`、`recent`、`createCoachRouter` 和 `trustedProxyHops` **之前**挂载，且 `createCoachRouter` 内部私有创建 `limiter`。直接改 `routes/v1/index.js` 拿不到同一套服务与限流实例。 | 抽取共享的 `createCoachService(...)`（`lib/coach/service.js`），并在 `server.js` 中将 `trustedProxyHops`、共享 `coachLimiter`、`coachCases`、`recent`、`coachAsk` 提升到 `createV1Router` 与 `createCoachRouter` 之前共同注入。 |
| 1.2 | **P1** | `packages/mcp/src/index.js:22`；`packages/cli/src/coachApi.js:37`；`lib/coach/recent.js:14` | `recent_matches({ account })` 文档和 stdio 支持好友码、SteamID64、`[U:1:n]` 及 Steam/OpenDota/Dotabuff/STRATZ 链接（靠 `coachApi.js:parseAccount`），但服务端 `lib/coach/recent.js:parseAccountId` **只认纯 32 位数字**。进程内适配器若误用 `parseAccountId`，远程 MCP 会静默拒绝 URL/SteamID64。 | 进程内适配器使用与 CLI 一致的 `parseAccount`（抽取共享纯函数或复用），确保 stdio 与远程 `/mcp` 行为完全一致。 |
| 1.3 | **P1** | `lib/coach/router.js:162–245`；`lib/matchReview/reviewRequestGuard.js:76` | `POST /api/coach/:id/ask` 直接写 SSE 流且挂了同源校验 `validateReviewPostRequest`。MCP `coach_ask` 需要返回 `{ text, fallback, notice }` JSON 对象，且不能因浏览器 MCP Inspector 携带跨源 `Origin` 而误 403，同时必须响应 `res.on('close')` 中止 LLM、执行 `coachLimiter` + `reviewLlmLimit.acquire(req)`（触发 `cost_guard` 时降级 `fallbackAnswer`，触发 per-IP 限流时拒绝）并复用 `cases.peek`。 | 在 `lib/coach/service.js` 中抽出纯流程 `runCoachAsk(...)`，HTTP 路由按 chunk 写 SSE，MCP 适配器收集 chunk 返回 `{ text, fallback, notice }`；两者共用 `parseAskBody`、`coachLimiter`、`reviewLlmLimit`、`decideFollowUpOutcome` 和 `AbortController`。 |
| 1.4 | **P1** | `packages/mcp/src/index.js:85,99,135`；`packages/mcp/test/mcp.test.js:68`；`packages/mcp/test/coach.test.js:86` | ① MCP 现有错误过滤只放行 `INVALID_INPUT` / `NOT_FOUND`，`RATE_LIMITED` 会被吞成泛化的 `'Coach request failed'`；② Streamable HTTP 工具错误返回 HTTP 200 JSON-RPC `isError: true`（非 HTTP 429），可附带 `Retry-After` 头；③ 现有两处单测在不传 `coachForRequest` 时断言只暴露 2 个工具。 | ① `attachMcp` 仅在传入 `coachForRequest`（或显式 `coachTools: true`）时注册 6 个教练工具，保持旧单测向后兼容；② `packages/mcp/src/index.js` 识别 `error.code === 'RATE_LIMITED'`，透出清晰限流文案（含 `retryAfterSec`）并设置 `Retry-After` 头。 |
| 1.5 | **P1** | `lib/coach/router.js:98` vs `lib/llmRateLimit.js:95` | `lib/coach/router.js` 目前直接用 `resolveClientIp(req)` 作限流键，**未经过 `rateLimitKey()` 的 IPv6 `/64` 归并**（`reviewLlmLimit` 和 `/api/events` 已归并）。暴露远程 MCP 后，IPv6 调用方可轮换同网段地址绕过限流。 | 共享 `coachLimiter` 统一按 `rateLimitKey(resolveClientIp(req))` 计费（同时覆盖 `/api/coach/*` 与远程 `/mcp`）。 |
| 1.6 | **P2** | `routes/v1/openapi.js:38`；`scripts/mock-review-server.mjs:44` | `llms.txt` 仍写着已退役并 301 跳转的 `/m/{matchId}`；`mock-review-server.mjs` 未给 `createV1Router` 注入 fixture 教练适配器，本地 mock 无法验证 8 工具 `/mcp`。 | PR-1 同步清理 `llms.txt` 的 `/m/` 过时路径、更新 `/mcp` 8 工具说明（`openapi.js`、`README.md`、`packages/mcp/README.md`），并在 `mock-review-server.mjs` 接入 fixture 教练适配器。 |

### PR-2：首页改版

| # | 严重度 | 核实位置 | 原计划盲区 / 风险 | 修订方案 |
|---|---|---|---|---|
| 2.1 | **P1** | `OILUI_REDESIGN_PLAN.md:106,109`；`README.md:32,86,110` | 原计划 CLI 示例写了旧 v1 的 `review 9091400302 --hero tidehunter`，HTTP 只写了 `/api/v1/review/...`。主产品已是 Coach（`dota2ai coach 9091400302 --hero tidehunter --section why` 与 `GET /api/coach/9091400302`）。 | CLI 主命令展示 `coach 9091400302 --hero tidehunter --section why` + `matchup tidehunter ursa --rank legend`；HTTP 主示例展示 `GET /api/coach/9091400302`（可附 `/api/v1/review/...` 链接到 `/openapi.json` 和 `/llms.txt`）。 |
| 2.2 | **P1** | `src/coach/api.ts`；`src/App.test.tsx:11`；`src/coach/PatchNews.test.tsx:26` | ① `api.ts` 尚无 `fetchCoachCards`；② 首页每次访问即请求 `/api/coach/9091400302/cards?seat=0`，切换 0/2/4 若不做前端内存缓存会重复消耗 40/min 限额；③ 必须过 `validateSurface()` 遵守 `A2UI_CARDS.md` 不可信网络边界；④ `App.test.tsx` 将 `fetch` mock 为 reject，`PatchNews.test.tsx` 未 stub `fetch`，必须静默降级且不触发未处理 Promise 拒绝。 | 新增 `fetchCoachCards(matchId, seat, signal)` + 客户端内存缓存 + `validateSurface` 校验；加载期用定高骨架防止布局抖动；失败/中止平滑降级为「示例暂时不可用」，并提供跳转完整复盘链接，**零假数据**。 |
| 2.3 | **P1** | `src/coach/PatchNews.test.tsx:27–34`；`src/coach/CoachPlayerPage.test.tsx:83–105` | ① `PatchNews.test.tsx` 硬断言了 `.cx-principles` 的存在与顺序 `['cx-hero', 'cx-patch', 'cx-principles']`；原计划删掉 `.cx-principles` 却说"照常通过"，实则必然红灯；② 原计划遗漏了老用户回访的 `LatestGame`（及 `LatestGoal`）区块位置。 | ① `PatchNews` 用语义 `<details>` 保留 7.42 标题、6 件新装备、高亮项和更新日志链接，并**明确改写** `PatchNews.test.tsx` 的顺序断言为新结构（在 PR 中写清理由，断言严格度不降）；② 明确保留 `LatestGame`（紧接主输入下方或右侧首屏顶部）。 |
| 2.4 | **P1** | `src/coach/CoachApp.tsx:528,675,809` | `AgentSnippets` 同时出现在首页（L675）和复盘页（L809），且内部写错了工具名（`coach_recent`、`coach_goal_check`，实际是 `recent_matches`、`goal_check`，还缺了 `hero_matchup`、`review_match`、`get_evidence`）。只替换首页会留下复盘页错误清单。 | 抽出单一真源配置 `src/coach/accessSnippets.ts`，首页使用全新的「四种用法 + 发给 Agent」模块，复盘页底部复用同一真源（含正确 8 工具名与当前 `matchId`）。 |
| 2.5 | **P2** | 1440×900 / 1280×800 首屏高度预算 | 在单栏里竖排堆叠「定位+河道输入框」「示例迷你复盘」「四种用法+复制提示词」，900px 高度装不下。 | 桌面端（`≥1024px`）采用**非对称双栏首屏**：左栏 = 定位标题/副标题 + 模式切换 + 河道主输入 + 4 入口快速锚点；右栏 = 9091400302 实时迷你复盘（0/2/4 座位切换）；首屏紧接下一带 = 完整「四种用法」分段切换 + 「发给你的 Agent」一键复制提示词 + 单行可展开的 7.42 版本条。 |

### PR-3：复盘页改成工作台

| # | 严重度 | 核实位置 | 原计划盲区 / 风险 | 修订方案 |
|---|---|---|---|---|
| 3.1 | **P1** | `lib/coach/cards.js:148`；`src/coach/CoachApp.tsx:786–807`；`src/coach/CardFeed.test.tsx:33` | ① **未解析比赛没有 `GoldTimeline`**；② 队友点团队链接 `/r/:id?ref=team` 进入时 **`selected === null`**（尚未选英雄）；③ 切换英雄时 `ParsePanel` **绝不能卸载重挂**，否则会中断正在进行的解析轮询（Codex P1 #206）。 | 明确三态布局：① 已解析+已选人：顶部时间轴 + 三栏工作台；② 未解析+已选人：顶部紧凑摘要 + 置顶稳定挂载的 `ParsePanel`（跨座位切换保持同实例）；③ 未选人：10 人选英雄面板居中，不渲染空抽屉。 |
| 3.2 | **P1** | `e2e/coach.spec.ts:26,35–81,100–107`；`src/coach/RedesignInteractions.test.tsx:82–120` | `e2e/coach.spec.ts` 在 `desktop-1280` 与 `mobile-390` 上都直接断言：`#cx-ch-story`（含热力图）和 `#cx-ch-plan` 首屏可见，且 `.cx-ask-form textarea` 可直接填写。若抽屉默认关闭或所有章节默认折叠，E2E 与单测将大面积失败。 | ① 桌面端（`≥1200px`，覆盖 1280px E2E）右侧检查抽屉**默认停靠展开**，内置「证据 / 追问 / 对比」视图切换且 `AskPanel` 保持稳定挂载（`askRef.current.prefill` 同步可靠）；移动端（`<1200px`）折叠为底部弹层并保留顶部/浮动「追问/检查」入口，同步更新移动端 E2E 交互路径；② 章节中 `Story`（核心归因）和 `Plan`（下局练习）**默认展开**，`Lane`/`Deaths`/`Items`/`Fights` 可折叠并在时间轴点击或 `inspect` 动作触发时自动展开并高亮目标行。 |
| 3.3 | **P1** | `playwright.config.ts:30`（`1280×800`） | 当前 `.cx-top`（~52px）+ `.cx-ctxbar`（~64px）已占 116px；若再把完整高度的 `GoldTimeline`（~190px）设成 `position: sticky`，在 800px 视口下粘性头部会吃掉 **306px（38% 屏高）**，严重遮挡正文。 | 桌面端将时间轴压成紧凑工作台条（SVG 高度 84–96px，图例并入标题行），仅在 `min-width: 1200px` 且 `min-height: 820px` 时粘性固定（或在工作台内局部滚动）；移动端与矮屏不粘性固定时间轴。 |
| 3.4 | **P1** | `src/coach/coach.css`（58KB）、`src/coach/cards.css`（11.8KB）；`e2e/coach.spec.ts:111` | 实测两份 CSS 存在 **25+ 种不同 `font-size`**（10.5px～28px + 6 组 `clamp()`）；且 `--text-3: #69727d` 在 `--panel: #10141a` 上对比度仅约 **3.9:1**（未达 WCAG AA 4.5:1），`e2e/coach.spec.ts:111` 目前被迫 `disableRules(['color-contrast'])`。 | 在 `cards.css` 定义 4 档字号令牌（`--fs-display` / `--fs-h` / `--fs-body` / `--fs-meta`），逐步收敛两份 CSS；将 `--text-3` 提升至 `≥#8b949e`（约 5.7:1），目标是在 PR-3 恢复或单独验证 WCAG AA 对比度。 |
| 3.5 | **P2** | `src/coach/CoachApp.tsx:1100–1334` | `CoachApp.tsx` 已膨胀至 1,625 行（81KB），其中 `ReadColumn`、`Group`、`RoleCard`、`BenchCard`、`ItemsCard`、`ThreatCard`、`MatchupsCard`、`TimelineCard`、`DeathsCard` 共约 235 行在 #206 后已是无引用死代码。 | PR-2 拆出 `Home.tsx`，PR-3 拆出 `ReportWorkbench.tsx` + `InspectorDrawer.tsx` 并删除上述 235 行死代码，PR-4 拆出 `PlayerPage.tsx`。 |

### PR-4：玩家页

| # | 严重度 | 核实位置 | 原计划盲区 / 风险 | 修订方案 |
|---|---|---|---|---|
| 4.1 | **P1** | `src/coach/CoachApp.tsx:349` vs `392` | 发现一处**线上已有 Bug**：L349 屏蔽了非目标所有者的行级达成徽章，但 L392 的 `{goal && <div className="cx-goal cx-recent-goal">}` **未校验 `isGoalOwner`**，导致查看别人的 `/p/:otherId` 时错误显示自己的训练目标卡片！ | 新增目标进度状态条必须严格校验 `isGoalOwner`（`goal.accountId == null || String(goal.accountId) === accountId`）；且 `tl.n === 0` 时诚实显示「尚未核验新对局」，绝不显示 `0/0` 或假进度条。 |
| 4.2 | **P2** | `src/coach/cards.css:113–119` | `.cx-recent-row` 现已有 3px 绿/红左边线，但每行套在带渐变+阴影+圆角的独立卡片里，反而踩中 Oil UI 的「满屏卡片+左粗彩条」套路。 | 改为**无外框卡片的紧凑表格列表**（细横线分隔、数字全部 `tabular-nums` 右对齐、2px 极简胜负色标或紧凑状态点、顶部/行内紧凑训练目标进度条）。 |

### 流程与仓库卫生补充发现

- **E2E 覆盖缺口**：`e2e/coach.spec.ts` 目前只覆盖 `/r/9091400302`，`/` 与 `/p/:id` 为 0 覆盖。PR-2 与 PR-4 需补齐对应页面的 Playwright E2E 及 1440×900 / 390×844 横向滚动断言。
- **过时背景文档提醒**：当前工作区未跟踪的 `CLAUDE.md` 与已提交的 `.github/copilot-instructions.md` 仍包含退役前的旧架构描述（`src/components/`、`server.js ~3k lines`）；执行时一律以 `main @ d80c061` 实有文件为准（`server.js` 现 835 行，前端仅 `src/coach/`）。

---

## 三、修订后的执行计划（PR-1 → PR-4）

每个 PR 遵循：**单一目标** · **不碰 `#209`（身份迁移）** · **填写 `.github/pull_request_template.md` 并贴命令与摘要** · **双语 `{ en, zh }` 默认英文** · **数据诚实**。

### PR-1：`feat(mcp): expose all 8 coach tools on remote /mcp with per-IP limits`

1. **后端架构改动**：
   - 新增 `lib/coach/service.js`：`createCoachService({ getMatchDetail, resolveClientIp, mapError, limiter, cases, recent, ask, log })`，统一封装 `report`、`cases`、`recent`（使用支持 SteamID64 / `[U:1:n]` / 4 站点链接的 `parseAccount`）、`matchup`、`ask`（流式回调 + 汇总返回双模式，支持 `AbortSignal` 与 `reviewLlmLimit` 成本护栏降级）。
   - `lib/coach/router.js`：改为消费 `createCoachService`，限流键统一改为 `rateLimitKey(resolveClientIp(req))`。
   - `packages/mcp/src/index.js`：
     - `attachMcp(app, { path, reviewForRequest, coachForRequest, ...options })`：当传入 `coachForRequest` 时开启全部 8 工具（未传时保持 2 工具，不破坏旧测试）；
     - 错误处理识别 `RATE_LIMITED`（透出明确限流信息，并在 `res` 未发送头时写入 `Retry-After`）。
   - `routes/v1/index.js`：`createV1Router` 接受可选 `coachForRequest` 并透传给 `attachMcp`。
   - `server.js`：将 `trustedProxyHops`、`coachLimiter`、`coachCases`、`recentService`、`coachService` 提升至 `createV1Router` 与 `createCoachRouter` 之前构造并共享。
   - `scripts/mock-review-server.mjs`：为 `createV1Router` 注入 fixture `coachForRequest`。
2. **文档同步**：更新 `routes/v1/openapi.js`（`/openapi.json` + `/llms.txt`，同时移除过时的 `/m/` 说明）、`packages/mcp/README.md`、`README.md`。
3. **测试与验收**：
   - 新增/扩展 `packages/mcp/test/coach.test.js` 与 `packages/mcp/test/mcp.test.js`：
     - 注入 `coachForRequest` 后远程 `/mcp` `tools/list` 返回全部 8 个工具；
     - 进程内调用 `coach_report`、`hero_matchup`、`recent_matches`（含 Steam 链接 / SteamID64）、`coach_ask`（含 LLM cost guard 降级与 per-IP 限流）；
     - **IP 隔离限流测试**：IP-A 打满限额返回 `isError: true` 且含限流提示，IP-B 同一时刻正常返回 200 成功数据；撤掉按 IP 限流即失败。
   - 本地启动 `server.js`，用 `curl` 实测 `/mcp` 的 `initialize`、`tools/list`（8 个）和 `hero_matchup`。

---

### PR-2：`feat(ui): redesign home page with live sample review and 4 access modes`

> 前置条件：PR-1 已合并上线（首页所列 8 个 MCP 工具必须与线上 `/mcp` `tools/list` 严格一致）。

1. **代码拆分与新增**：
   - 新增 `src/coach/accessSnippets.ts`：单一真源，维护 Web / Agent (MCP) / CLI / HTTP 命令、8 个工具名（与 `packages/mcp/src/index.js` 一致）以及中英双语「发给你的 Agent」提示词。
   - 扩展 `src/coach/api.ts`：新增 `fetchCoachCards(matchId, seat, signal)`，经 `validateSurface` 校验并按 `matchId:seat` 做会话级内存缓存。
   - 新增 `src/coach/Home.tsx`（由 `CoachApp.tsx` 导出 `CoachHome`，避免影响路由/测试导入）：
     - **首屏非对称双栏（`≥1024px`）**：
       - 左：去 eyebrow 的简洁 H1 + 副标题（融合「每条结论有据可查、看不到的数据直说」）+ 「比赛 / 好友码」切换 + 保留河道动效的单一输入框（`role="textbox"` 数量仍为 1）；老用户记忆账号时展示紧凑 `LatestGame`；
       - 右：实时拉取 `GET /api/coach/9091400302/cards?seat=0` 的迷你复盘（阵容条、要点、第一条发现），支持 0 / 2 / 4 座位切换与「进入完整复盘」；加载用定高骨架，失败降级显示「示例暂时不可用」，绝不硬编码假数据；替换 `SAMPLE_CARDS`。
     - **紧接首屏「四种用法」区块**：分段切换 `Web | Agent (MCP) | CLI | HTTP`，等宽命令块支持手机端横向滚动不撑破视口，配「复制」按钮及已复制反馈：
       - **Web**：锚点跳回并聚焦主输入框；
       - **Agent (MCP)**：`claude mcp add --transport http dota2ai https://dota2.ai/mcp`，说明 Cursor / Claude Desktop 等支持远程 MCP 的客户端填此 URL 即可，列出全部 8 个工具；
       - **CLI**：`git clone https://github.com/qianhaoq/dota2.ai && cd dota2.ai && npm ci` + `node packages/cli/bin/dota2ai.js coach 9091400302 --hero tidehunter --section why` + `matchup tidehunter ursa --rank legend`，明确注明「未发布到 npm」；
       - **HTTP**：`curl 'https://dota2.ai/api/coach/9091400302'`（附 `/api/v1/review/9091400302?hero=tidehunter`）与 `/openapi.json`、`/llms.txt` 链接；
       - 底部「发给你的 Agent」一键复制提示词块。
     - **7.42 版本条**：压缩为单行摘要（`7.42 已上线 · 新装备 6 件 · 更新日志 ↗`），用 `<details>` 展开完整高亮、6 件新装备与对复盘影响。
     - **删除** `01/02/03` 三列原则（`.cx-principles`）；替换首页旧 `AgentSnippets` 并同步修正复盘页 `AgentSnippets` 引用 `accessSnippets.ts`。
2. **测试与验收**：
   - `App.test.tsx`、`CoachPlayerPage.test.tsx` 保持原有核心断言全绿（单一 textbox、h1、占位符、好友码模式、LatestGame）；
   - 更新 `PatchNews.test.tsx` 的区块顺序断言（去掉已删的 `.cx-principles`，改为断言新首页区块顺序并在 PR 中说明理由，保持所有 7.42 数据项断言）；
   - 新增 `src/coach/Home.test.tsx`：四种用法切换、8 工具名、CLI/HTTP 命令文本、mock `navigator.clipboard` 断言写入内容、`/cards` 成功渲染 + 座位切换 + 接口失败降级文案；
   - 补齐 `e2e/coach.spec.ts` 首页用例（1440×900 & 390×844 无横向滚动、axe 检查、截图验收 + 50% 缩放检查）。

---

### PR-3：`feat(ui): rebuild match review as a 3-column object-driven workbench`

1. **架构与样式重构**：
   - 在 `src/coach/cards.css` 建立 4 档字号令牌与对比度修复：
     - `--fs-display`（主标题）、`--fs-h`（区块标题）、`--fs-body`（正文，14–15px，55–75ch）、`--fs-meta`（辅助说明，≥12px）；
     - 提升 `--text-3` 至 `≥#8b949e` 满足 WCAG AA；
     - 饱和色严格收敛：绿/红/金仅用于胜负、异常/需改进项及对位劣势判定，其余使用中性石板色；数字全部 `font-variant-numeric: tabular-nums`。
   - 拆出 `src/coach/ReportWorkbench.tsx` 与 `src/coach/InspectorDrawer.tsx`，删除 `CoachApp.tsx` 中约 235 行无用旧卡片组件（`ReadColumn` 等）。
   - **三栏布局（`≥1200px`）与三态完整覆盖**：
     - **顶部主轴**：已解析展示紧凑 `GoldTimeline`（点击死亡点 / 团战刻度打开并定位右侧抽屉 + 展开对应章节行）；未解析展示紧凑摘要 + 稳定挂载的优先 `ParsePanel`（换座位绝不中断轮询）；
     - **左栏（~220px）**：10 人阵容竖排选择器，替代横排 `Lineup`（保留完整装备图标提示与选中状态）；未选座位时居中呈献 10 人选人视图；
     - **中栏（`1fr`，阅读宽 55–75ch）**：去掉卡中卡（证据改行内键值对 + 细分隔线）、去多余 `cx-eyebrow` 与非状态类小标签；`Headline` → `Findings` → 章节（`Story`、`Plan` 默认展开，`Lane`/`Deaths`/`Items`/`Fights` 可折叠并在跳转时自动展开）；
     - **右栏（~340px）检查抽屉**：桌面端默认停靠，支持 `证据/详情`、`问教练`（`AskPanel` 移入抽屉，保持稳定挂载以支持同步 `prefill`）、`对位对比`（`CompareCard`）；`<1200px` 转为底部弹层 + 清晰触发按钮。
   - **协议不变量保持**：`buildSurface`、`validateSurface`、`CardFeed` 的 `run()` 白名单动作分发不变，仅把 `inspect`/`ask`/`compare` 路由到抽屉与章节展开状态。
2. **测试与验收**：
   - 更新受布局结构变化影响的断言（`CoachReportPage.test.tsx`、`CardFeed.test.tsx`、`RedesignInteractions.test.tsx`、`e2e/coach.spec.ts`），严格度不降并在 PR 说明每处改写原因；
   - 新增工作台行为测试：点发现打开抽屉展示证据、抽屉内追问携带卡片上下文、点击时间轴死亡/团战点打开抽屉并展开对应行（含清除过滤与重新展开折叠）、未解析换座位轮询不中断、职业案例跳转与对比卡片正常；
   - 1440×900、1280×800、390×844 无横向滚动 + 截图验收 + 尝试开启 axe `color-contrast` 校验。

---

### PR-4：`feat(ui): streamline player match table and owner-scoped goal progress bar`

1. **改动内容**：
   - 拆出 `src/coach/PlayerPage.tsx`；
   - 去掉每行比赛的阴影渐变卡片外壳，改为清爽的细分隔线表格行（`tabular-nums` 对齐 KDA、时长、日期），胜负仅用一条 2px 细色边/极简标签表达；
   - 保留现有全部筛选（全部 / 未复盘 / 天梯 + 常用英雄筛选，切换账号自动重置）；
   - **修复目标所有者隔离 Bug**（`isGoalOwner`）：仅在查看目标所属账号时显示紧凑训练目标状态条（如「已完成 X / Y 局」，`Y === 0` 时诚实提示待下一局核验）；
   - 行内紧凑状态指示与既有 `ResultPill` 协调呈现。
2. **测试与验收**：
   - `CoachPlayerPage.test.tsx` 与 `RedesignInteractions.test.tsx` 目标隔离用例全绿；
   - 新增回归测试：查看他人 `/p/:otherId` 时**不渲染**训练目标进度条（撤掉 `isGoalOwner` 修复即失败）；有目标且 `0` 局核验时不显示 `0/0`；有核验记录时准确显示 `met / total` 进度条；
   - 补齐 `e2e/coach.spec.ts` `/p/:id` 检查 + 双尺寸截图验收。

---

## 四、开工前待确认的 3 个决策点（均附推荐项）

1. **PR-3 桌面端检查抽屉默认状态**：
   - **推荐**：桌面端（`≥1200px`）默认停靠展开（初始展示「追问教练」或第一条发现的证据+追问），移动端（`<1200px`）默认收起为底部弹层入口。这样既满足 Oil UI 工作台密度，又不隐藏高频追问功能，且与 1280px E2E 无冲突。
2. **PR-1 远程 MCP `coach_ask` 的 `Origin` 策略**：
   - **推荐**：按 `/mcp` 无状态接口标准校验 JSON + `parseAskBody` 长度上限 + `coachLimiter`（IPv6 `/64`）+ `reviewLlmLimit` 成本护栏，**不对 `/mcp` 施加浏览器同源 `Origin` 拦截**（与现有 `review_match` 一致，方便 Claude Desktop / Cursor / MCP Inspector 连接）。
3. **PR-2 首页首屏布局**：
   - **推荐**：桌面端（`≥1024px`）采用左「河道主输入」+ 右「9091400302 实时迷你复盘」的非对称双栏，下方紧接「四种用法 + 发给 Agent」与单行 7.42 版本条，确保 1440×900 与 1280×800 首屏同时看到输入框与真实可用对象。
