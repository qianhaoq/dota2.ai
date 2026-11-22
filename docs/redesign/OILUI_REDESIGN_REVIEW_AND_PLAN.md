# dota2.ai 改版计划独立评审与修订执行方案（v2.1）

> 基准：`main @ d80c061` · 评审对象：[`docs/redesign/OILUI_REDESIGN_PLAN.md`](./OILUI_REDESIGN_PLAN.md)
> 参考方法：[Oil UI](https://ui.oiloil.org/)（`fix-ai-ui-slop`、`landing-page-design`、`dashboard-workspace-design`）
> 状态：**独立评审与修订计划（含「结论可读性与 Dota 2 机制可落地性」专项，待确认后按 PR-1 → PR-5 依次实施）**

---

## 一、总体评审结论

**方向认可，但有两类必须前置解决的问题：**

1. **技术与测试盲区（14 处）**：对照 `main @ d80c061` 源码、现有单测与 E2E 逐项核查，原计划在 `server.js` 装配顺序、远程 MCP 限流与参数解析、首页 `/cards` 实时请求、既有断言冲突、未解析/未选人状态及玩家页目标归属隔离上存在明确 P1 风险点。
2. **结论可读性与可落地性短板（新增核心专项，直接决定产品价值）**：实测 `9091400302` 的真实引擎输出后发现，哪怕把 UI 改得再漂亮，**首屏头条目前展示的仍是空洞套话甚至违背 Dota 2 常识的建议**——例如：
   - 潮汐猎人（0 号位）头条：`最大的提升点：12 次死亡，代价大于收益。`（废话，玩家不需要教练告诉他死了 12 次），行动建议居然叫 **3 号位前排团控潮汐**「开团前站在队伍后面，别做他跳进来第一个够得着的人」；
   - 幽鬼（4 号位）1 号位大核被推荐出 **洞察烟斗** 和 **幽魂权杖**（因为装备池只粗分 `core / support`，不区分 1 号位敏捷大核与 3 号位光环前排）；
   - 真正有 Dota 2 价值的归因（熊战士 16:56 跳刀后击杀 6 次、潮汐跳刀拖到 29:20、职业潮汐对熊战士 37% 出 Eul 的神圣法杖、熊战士「怒意狂击」为无视魔免且不可驱散的物理伤害）**仓库里其实已有权威快照数据**，却被埋在底部章节或完全没接进 `findings`、`headline` 和 `plan`。

**关键排期调整**：因为新版首页首屏会直接嵌入 `9091400302` 的实时迷你复盘，如果不在首页改版前先修好教练结论质量，新首页首屏第一句话就会是「12 次死亡，代价大于收益」。因此建议将**「教练结论可读性与 Dota 2 机制落地」作为独立引擎 PR（PR-2）前置到首页改版（PR-3）之前**，同时让 PR-1 的远程 MCP 与 PR-3 的首页首屏一起受益。

---

## 二、结论可读性与 Dota 2 机制可落地性诊断（以 `9091400302` 为实测样本）

> 原则重申：**严禁编造任何英雄、技能数值或版本事实**。以下改进全部依托仓库已提交的权威快照（`lib/coach/data/abilities.json` Valve 数据、`item-vs.json` 职业针对装、`hero-items.json` 职业核心装节奏、`matchups.json` / `matchups-rank.json` 对位数据）与经过测试校验的 `lib/coach/knowledge.js`。

### 2.1 现网输出中的 5 类典型问题

| # | 问题类型 | 实测位置与反面案例（`9091400302`） | 根因定位 | 整改标准 |
|---|---|---|---|---|
| Q1 | **把结果统计当头条，充斥无意义废话** | 潮汐/萨满/幽鬼：`12/19/15 次死亡，代价大于收益`；`headline` 直接拼 `最大的提升点：12 次死亡，代价大于收益。` | `lib/coach/analyze.js:384`（`deaths.high` 固定废话标题）+ `L829–841`（`headline` 只从 `findings[0]` 取，早于 `chapters/why` 计算）。 | **彻底废除「X 次死亡，代价大于收益」这类空洞标题**。已解析对局优先把「关键装备断档 / 被核心滚雪球缺针对装 / 关键团战大招未放 / 线上被特定组合打穿」等**因果级个人杠杆**提升为头条与首卡；死亡类结论标题必须直指具体对手/时间节点/死因（如：`熊战士 16:56 跳刀后击杀你 6 次，缺少风杖/绿杖拉扯`）。 |
| Q2 | **无视己方英雄定位与技能机制，产出反常识建议** | ① 叫 3 号位前排团控 **潮汐猎人**（海妖外壳+毁灭）「开团前站在队伍后面」；② 叫 1 号位 **幽鬼** 出 `洞察烟斗`、`幽魂权杖`。 | ① `lib/coach/analyze.js:351–352` 对所有被跳刀击杀的英雄套用同一句后排站位模板；② `lib/coach/knowledge.js:49–82` `ANSWERS` 仅粗分 `core / support`，未区分英雄原型（1 号位平 A 大核 vs 3 号位光环/先手前排 vs 法核 vs 后排辅助）。 | 在 `lib/coach/knowledge.js` 引入经测试校验的**英雄原型分组**（如 `frontline_initiator`、`right_click_carry`、`spell_core`、`backline_support`）与**原型适配装备池**（1 号位平 A 核禁用幽魂权杖/烟斗，优先 BKB/幻影斧/刃甲/撒旦/林肯/否决等；3 号位前排先手按跳刀先后手与拉扯装给出团战站位与先手建议，绝不叫潮汐躲后排）。 |
| Q3 | **仓库已有技能/克制/职业装数据，却没接进核心结论** | `abilities.json` 里明确写着熊战士「怒意狂击」`dmg:"P", pierces:true, dispel:"no"`、「激怒」`pierces:true, dispel:"no"`；`item-vs.json` 写着职业潮汐对熊战士 37% 出 **Eul 的神圣法杖**（平时 8%）；`hero-items.json` 写着潮汐 61% 25 分钟前出跳刀。但顶部 `findings` 完全没提这些！ | 只有 `why.js` 零星使用了 `abilities`/`item-vs`/`hero-items`，顶部的 `deathFinding`、`laningFinding`、`itemFinding`、`planFrom` 仍大量走通用模板。 | 将 `abilities.json`（伤害类型、是否无视魔免、可否弱/强驱散）、`item-vs.json`（职业同对位高提升针对装）与 `hero-items.json`（英雄核心装节奏）接入顶部 `findings`、`headline` 与 `planFrom` 的文案生成器，并建立机制-装备映射（例：敌方核心物理输出+不可驱散大招/爆发 → 优先拉扯/风筝装：风杖/绿杖/推推/天堂之戟；敌方可弱驱散沉默如天怒「上古封印」→ 优先弱驱散装：幻影斧/莲花/风杖/BKB）。 |
| Q4 | **大量「换任何英雄都能套」的鸡汤话术** | ① `team.turning_point`：「先定一个目标五人一起行动，三人消失退回视野」；② `farm.low`：「核心的任务是把地图上的钱变成装备，这条转化链断了…团战后吃最近一波兵」；③ `laning.lost`：「把兵线控在塔附近，只在对面补刀时换血」；④ `planFrom`：「减少死于熊战士：每次进团前看小地图，控制在 4 次以内」。 | `analyze.js:291–297, 369–379, 496–498, 547–550` 与 `chapters.js:656–705` 使用脱离英雄与局势的泛化模板。 | 建立**反空话红线（测试约束）**：行动建议必须绑定**至少两项本局/Dota 2 具体要素**（敌方具体英雄+技能机制 / 我方英雄核心装顺序与时间点 / 职业同对位针对装 / 实际伤害类型与团战状态）。例如把「减少死于熊战士」改写为：`把闪烁匕首提前到法师克星之前（职业潮汐 61% 在 25 分钟前做出），并在熊战士跳刀期（~17 分钟）前补出 Eul 的神圣法杖（职业对位 37%，平时 8%）或幽魂权杖，用来拖过其不可驱散的「激怒」与无视魔免物理爆发「怒意狂击」`。 |
| Q5 | **顶部 `Findings` 与底部 `Why` 割裂、重点倒挂** | 潮汐顶部只显示 2 条空泛结论，真正致命的「29:20 才买跳刀」「对线森海飞霞爆栗出击 CD 窗口」「41:46 才买绿杖」全埋在下面 `Story/Why` 里。 | `analyze.js` 先算 `findings`、后算 `chapters.story.why`，没有把 `why` 中的高影响个人归因反哺或去重整合到首屏 `headline` / `findings`。 | 重构 `analyze.js` 组装顺序：在已解析对局中，由 `chapters` + `why` + `findings` 统一评分排序，选出 Top 1–3 **具体、可落地、不重复**的个人核心结论作为首屏 `Headline` 与 `Finding` 卡；并同步改善 `Ask` 的 `fallbackAnswer`，让无 LLM 时也能直接给到机制化建议。 |

### 2.2 改造前后效果对照示例（`9091400302` 潮汐猎人 & 幽鬼）

- **改造前（现网，潮汐 0 号位）**：
  - 头条：`最大的提升点：12 次死亡，代价大于收益。`
  - 建议：`开团前站在队伍后面，别做他跳进来第一个够得着的人……`
- **改造后（目标，完全基于仓库已有快照 + 本局数据）**：
  - 头条：`核心装与反制节奏滞后：跳刀 29:20 才出（先买了法师克星），熊战士 16:56 跳刀后连续击杀你 6 次。`
  - 建议：`潮汐作为先手前排需要抢在团战前拿到闪烁匕首（职业潮汐 61% 在 25 分钟前做出，这局被法师克星 16:06 与圣洁裹布 21:25 拖慢）；面对熊战士无视魔免且不可驱散的物理爆发「怒意狂击」与不可驱散大招「激怒」，职业潮汐 37% 会出 Eul 的神圣法杖（平时仅 8%）拉扯其爆发窗口，本局幽魂权杖拖到 41:46（连输 9 波团后）已来不及。`
- **改造前（现网，幽鬼 4 号位）**：
  - 建议：`下一局遇到天怒法师、森海飞霞：……其它可选：洞察烟斗、永世法衣、法师克星。` / `做出 幽魂权杖、天堂之戟、刃甲 之一。`
- **改造后（目标，1 号位平 A 大核原型过滤）**：
  - 建议：`面对天怒法师（上古封印可弱驱散、魔法爆发）与森海飞霞，1 号位幽鬼本局夜叉拖到 33:39（职业幽鬼 73% 在 25 分钟前做出，39% 合成幻影斧）：优先提速夜叉 → 幻影斧（弱驱散沉默且不中断输出）或黑皇杖，而不是在缺驱散与刷钱装时硬扛魔法爆发；面对熊战士物理单切，优先靠幻影斧/刃甲/先手切后排而非与 1 号位冲突的幽魂权杖或洞察烟斗。`

---

## 三、原计划其他技术与测试盲区清单（14 处）

### PR-1：远程 MCP 补齐 8 工具

| # | 严重度 | 核实位置 | 原计划盲区 / 风险 | 修订方案 |
|---|---|---|---|---|
| 1.1 | **P1** | `server.js:689` vs `705–779`；`lib/coach/router.js:57` | `createV1Router` 在 `coachCases`、`recent`、`createCoachRouter` 和 `trustedProxyHops` **之前**挂载，且 `createCoachRouter` 内部私有创建 `limiter`。 | 抽取共享 `createCoachService(...)`（`lib/coach/service.js`），在 `server.js` 中把 `trustedProxyHops`、共享 `coachLimiter`、`coachCases`、`recent`、`coachAsk` 提升到两个路由之前共同注入。 |
| 1.2 | **P1** | `packages/mcp/src/index.js:22`；`packages/cli/src/coachApi.js:37`；`lib/coach/recent.js:14` | stdio `recent_matches` 支持好友码、SteamID64、`[U:1:n]` 及 4 站点链接，但服务端 `parseAccountId` **只认纯 32 位数字**。 | 进程内适配器使用与 CLI 一致的 `parseAccount`，保证 stdio 与远程 `/mcp` 行为一致。 |
| 1.3 | **P1** | `lib/coach/router.js:162–245`；`lib/matchReview/reviewRequestGuard.js:76` | `POST /api/coach/:id/ask` 直接写 SSE 且含浏览器同源校验；MCP `coach_ask` 需返回 `{ text, fallback, notice }`，并响应 `res.on('close')` 中止 LLM、执行 `coachLimiter` + `reviewLlmLimit` 成本护栏降级。 | 在 `lib/coach/service.js` 抽出共享 `runCoachAsk(...)`，HTTP 路由写 SSE、MCP 适配器收集 chunk 返回对象，共用限流与 `AbortController`。 |
| 1.4 | **P1** | `packages/mcp/src/index.js:85,99,135`；`packages/mcp/test/mcp.test.js:68`；`coach.test.js:86` | `RATE_LIMITED` 目前会被吞成 `'Coach request failed'`；Streamable HTTP 工具错误返回 HTTP 200 JSON-RPC `isError: true`；旧单测在不传 `coachForRequest` 时断言只返回 2 个工具。 | `attachMcp` 仅在传入 `coachForRequest`（或显式 `coachTools: true`）时注册 6 个教练工具；错误处理识别 `RATE_LIMITED` 透出清晰限流文案并写 `Retry-After`。 |
| 1.5 | **P1** | `lib/coach/router.js:98` vs `lib/llmRateLimit.js:95` | `lib/coach/router.js` 未经 `rateLimitKey()` 做 IPv6 `/64` 归并，暴露远程 MCP 后可轮换同网段地址绕过限流。 | 共享 `coachLimiter` 统一按 `rateLimitKey(resolveClientIp(req))` 计费。 |
| 1.6 | **P2** | `routes/v1/openapi.js:38`；`scripts/mock-review-server.mjs:44` | `llms.txt` 仍写已退役的 `/m/{matchId}`；`mock-review-server.mjs` 未注入 fixture `coachForRequest`。 | 同步清理 `/m/`、更新 `/mcp` 8 工具文档（`openapi.js`、`README.md`、`packages/mcp/README.md`），并在 mock 服务接入 fixture 教练适配器。 |

### PR-3（原 PR-2）：首页改版

| # | 严重度 | 核实位置 | 原计划盲区 / 风险 | 修订方案 |
|---|---|---|---|---|
| 3.1 | **P1** | `OILUI_REDESIGN_PLAN.md:106,109`；`README.md:32,86,110` | 原计划 CLI 示例写了旧 v1 `review`，HTTP 只写 `/api/v1/review/...`，主产品应是 `coach` 与 `/api/coach/:id`。 | CLI 展示 `coach 9091400302 --hero tidehunter --section why` + `matchup tidehunter ursa --rank legend`；HTTP 主示例展示 `GET /api/coach/9091400302`（附 `/api/v1/review/...`、`/openapi.json`、`/llms.txt`）。 |
| 3.2 | **P1** | `src/coach/api.ts`；`src/App.test.tsx:11`；`src/coach/PatchNews.test.tsx:26` | 缺 `fetchCoachCards`；切换 0/2/4 座位若不缓存会重复打 40/min 限流；必须过 `validateSurface()`；`App.test.tsx` reject `fetch`、`PatchNews.test.tsx` 未 stub `fetch`。 | 新增 `fetchCoachCards` + 会话内存缓存 + `validateSurface` + 定高骨架；失败/中止静默降级「示例暂时不可用」，零假数据。 |
| 3.3 | **P1** | `src/coach/PatchNews.test.tsx:27–34`；`src/coach/CoachPlayerPage.test.tsx:83–105` | `PatchNews.test.tsx` 硬断言 `['cx-hero', 'cx-patch', 'cx-principles']`；原计划遗漏老用户 `LatestGame` 区块位置。 | `<details>` 保留 7.42 全部内容并明确改写顺序断言（在 PR 说明原因）；保留 `LatestGame` 入口。 |
| 3.4 | **P1** | `src/coach/CoachApp.tsx:528,675,809` | `AgentSnippets` 在首页和复盘页两处出现，且写了错误工具名（`coach_recent`、`coach_goal_check`）。 | 抽单一真源 `src/coach/accessSnippets.ts`，首页替换、复盘页同步修正工具名。 |
| 3.5 | **P2** | 1440×900 / 1280×800 首屏高度 | 单栏竖排堆叠会超出 900px 首屏。 | 桌面端（`≥1024px`）用非对称双栏首屏（左河道输入，右 9091400302 实时迷你复盘），紧接「四种用法 + 发给 Agent」与单行 7.42 版本条。 |

### PR-4（原 PR-3）：复盘页工作台

| # | 严重度 | 核实位置 | 原计划盲区 / 风险 | 修订方案 |
|---|---|---|---|---|
| 4.1 | **P1** | `lib/coach/cards.js:148`；`src/coach/CoachApp.tsx:786–807`；`CardFeed.test.tsx:33` | 未解析比赛无 `GoldTimeline`；团队分享链接进入时 `selected === null`；换座位时 `ParsePanel` 卸载会中断轮询（Codex P1 #206）。 | 明确三态布局（已解析+已选人 / 未解析+已选人且 `ParsePanel` 稳定挂载 / 未选人居中 10 人选英雄）。 |
| 4.2 | **P1** | `e2e/coach.spec.ts:26,35–81,100–107`；`RedesignInteractions.test.tsx:82–120` | E2E 在 `desktop-1280` 与 `mobile-390` 上断言 `#cx-ch-story`、`#cx-ch-plan` 和 `.cx-ask-form textarea` 可用。 | 桌面端（`≥1200px`）抽屉默认停靠展开且 `AskPanel` 稳定挂载；移动端为底部弹层；`Story`/`Plan` 默认展开，其余章节可折叠并在跳转时自动展开。 |
| 4.3 | **P1** | `playwright.config.ts:30`（`1280×800`） | `.cx-top` + `.cx-ctxbar` + 完整高度 `GoldTimeline` 粘性叠加会吃掉 ~38% 屏高。 | 压紧工作台时间轴（84–96px），仅在宽且高屏（`≥1200px` & `≥820px`）粘性固定，移动端与矮屏不粘性。 |
| 4.4 | **P1** | `coach.css`（58KB）、`cards.css`（11.8KB）；`e2e/coach.spec.ts:111` | 实测存在 25+ 种 `font-size`；`--text-3: #69727d` 对比度仅 ~3.9:1（未达 WCAG AA）。 | 定义 4 档字号令牌（`--fs-display`/`--fs-h`/`--fs-body`/`--fs-meta`），提升 `--text-3` 至 `≥#8b949e`（约 5.7:1）。 |
| 4.5 | **P2** | `src/coach/CoachApp.tsx:1100–1334` | `CoachApp.tsx` 达 1,625 行，内含约 235 行无用旧组件死代码（`ReadColumn` 等）。 | 拆出 `ReportWorkbench.tsx` + `InspectorDrawer.tsx` 并删除死代码。 |

### PR-5（原 PR-4）：玩家页

| # | 严重度 | 核实位置 | 原计划盲区 / 风险 | 修订方案 |
|---|---|---|---|---|
| 5.1 | **P1** | `src/coach/CoachApp.tsx:349` vs `392` | **线上已有 Bug**：L392 的 `cx-recent-goal` 横幅未校验 `isGoalOwner`，查看他人 `/p/:otherId` 时会漏出自己的目标卡片。 | 新目标进度状态条严格校验 `isGoalOwner`，`tl.n === 0` 时诚实提示待核验，不显示 `0/0` 或假进度。 |
| 5.2 | **P2** | `src/coach/cards.css:113–119` | `.cx-recent-row` 现已是带渐变阴影的卡片套 3px 彩边，踩中 Oil UI 套路。 | 去卡片外壳，改为细分隔线表格行 + `tabular-nums` + 2px 极简胜负色标 + 紧凑目标进度条。 |

---

## 四、修订后的执行路线（PR-1 → PR-5）

每个 PR 遵循：**单一目标** · **不碰 `#209`（身份迁移）** · **填完整 PR 模板并贴命令与输出** · **双语 `{ en, zh }` 默认英文** · **数据诚实（零编造）**。

### PR-1：`feat(mcp): expose all 8 coach tools on remote /mcp with per-IP limits`
- 抽 `lib/coach/service.js`（共享 `report`/`cases`/`recent`/`matchup`/`ask` 与 IPv6 `/64` `coachLimiter`），`server.js` 先装配再分别注入 `createV1Router` 与 `createCoachRouter`。
- `recent_matches` 复用 `parseAccount`；`coach_ask` 收集流返回 `{ text, fallback, notice }`，遵守 `AbortController` 与 `reviewLlmLimit` 成本护栏降级。
- `packages/mcp/src/index.js` 新增 `coachForRequest`，识别 `RATE_LIMITED` 透出限流文案与 `Retry-After`；更新 `openapi.js`（含清 `/m/`）、`README.md`、`packages/mcp/README.md`、`scripts/mock-review-server.mjs`。
- 测试：8 工具 `tools/list`、进程内调用、IP-A 超额拒绝且 IP-B 正常通过（撤掉修复必挂）、`curl` 本地实测验收。

### PR-2：`feat(coach): replace generic platitudes with hero/skill/item-grounded advice`（新增引擎专项）
- **核心改动**：
  1. `lib/coach/knowledge.js`：增加经 `names.json` 校验的**英雄原型表**（如 `frontline_initiator` / `right_click_carry` / `spell_core` / `backline_support`）与**按原型过滤的克制装备表**（彻底杜绝叫 1 号位幽鬼出烟斗/绿杖、叫 3 号位潮汐躲后排）；新增基于 `abilities.json` 的机制规则（不可驱散 / 可弱驱散 / 无视魔免物理或控制 → 对应的机制化打法与装备类别）。
  2. `lib/coach/analyze.js`：
     - **移除** `"X deaths cost more than they bought"` / `"X 次死亡，代价大于收益"` 这类空泛标题；
     - `deathFinding` 按「我方英雄原型 × 敌方主杀手 × 关键跳刀/装备节点 × 职业对位针对装（`item-vs.json`）× 敌方技能特性（`abilities.json`）」生成具体标题与可落地建议；
     - `itemFinding` 按我方英雄原型过滤推荐装，并优先突出职业对位高提升装与英雄核心装节奏（`hero-items.json`）；
     - 重写 `farm.low`、`laning.lost`、`team.turning_point` 的鸡汤话术，绑定本局具体装备延误、技能 CD/驱散机制、经济差与团战条件；
     - 调整 `headline` 与顶部 `findings` 优先级：在已解析对局中，将 `why` 的高影响个人归因（核心装拖延、关键对位缺反制装、大招未放、被特定核心跳刀期连杀）晋升为头条，避免空泛统计霸屏。
  3. `lib/coach/chapters.js`（`planFrom`）：把「减少死于 X」「防御装先防主要伤害来源」「对线期先活下来」升级为**具体到装备顺序 + 敌方技能应对机制 + 触发时间点**的 3 条可落地练习项（与 `goal` 可核验指标保持兼容）。
  4. `lib/coach/cards.js`：确保新晋升的机制化发现与卡片动作（`inspect` / `ask` / `compare` / `save_goal` / `open_cases`）无缝衔接，`validateSurface` 100% 通过。
- **测试与验收**：
  - 既有全部引擎单测（`coachReport.test.ts`、`coachWhy.test.ts`、`coachThreatFallback.test.ts`、`coachHardestMatchup.test.ts`、`coachGoals.test.ts`、`coachCards.test.ts`）通过，若旧断言锁死了旧废话文案（如 `"代价大于收益"`），在 PR 中逐条说明原因并升级为更严格的机制断言；
  - 新增**反空话与 Dota 2 常识回归测试**（基于 `9091400302` 全部 10 座位 + 多原型回归用例）：
    - 断言全员 `headline` 与 `findings[].title` 不再出现 `"代价大于收益"` / `"cost more than they bought"`；
    - 断言潮汐（前排先手）不被建议「站在队伍后面」，且顶部结论包含熊战士/跳刀节奏或职业风杖/绿杖针对建议及 Valve 技能机制；
    - 断言幽鬼（1 号位平 A 核）不被推荐 `pipe`（洞察烟斗）或 `ghost`（幽魂权杖），优先给出适配原型的驱散/生存/核心装建议；
    - 断言新增的所有英雄/装备/技能引用 100% 校验自 `lib/coach/data/names.json` 与 `abilities.json`（杜绝编造或拼写错误）。

### PR-3：`feat(ui): redesign home page with live sample review and 4 access modes`
- 抽 `src/coach/accessSnippets.ts`（单一真源，同步修复复盘页错误工具名）、`src/coach/Home.tsx`；`api.ts` 新增带缓存与 `validateSurface` 的 `fetchCoachCards`。
- 桌面端非对称双栏首屏（左河道主输入 + `LatestGame`，右 `9091400302` 实时迷你复盘 0/2/4 座位切换，已展示 PR-2 升级后的高质量结论）；紧接「四种用法（Web / MCP / CLI / HTTP）」+「发给你的 Agent」复制块 + 单行可展开 7.42 版本条；删除 `.cx-principles`。
- 测试：更新 `PatchNews.test.tsx` 顺序断言，新增 `Home.test.tsx`（4 种用法、8 工具名、clipboard mock、`/cards` 降级）与首页 Playwright E2E + 1440×900 & 390×844 截图验收。

### PR-4：`feat(ui): rebuild match review as a 3-column object-driven workbench`
- 拆 `src/coach/ReportWorkbench.tsx` + `src/coach/InspectorDrawer.tsx`，删除 `CoachApp.tsx` 约 235 行死代码。
- 4 档字号令牌 + `--text-3 ≥ #8b949e` 对比度修复 + 饱和色严格收敛 + `tabular-nums`；去掉卡中卡与泛滥 `cx-eyebrow`。
- 三栏工作台（`≥1200px`）覆盖已解析/未解析（`ParsePanel` 稳定挂载）/未选人三态；紧凑顶部 `GoldTimeline`；桌面端右侧检查抽屉默认停靠（证据 / 追问 / 对比），移动端底部弹层；`Story`/`Plan` 默认展开，其余章节可折叠并在跳转时自动展开。
- 测试：适配并加强 `CoachReportPage.test.tsx`、`CardFeed.test.tsx`、`RedesignInteractions.test.tsx`、`e2e/coach.spec.ts`；1440×900 / 1280×800 / 390×844 无横向滚动 + 截图验收。

### PR-5：`feat(ui): streamline player match table and owner-scoped goal progress bar`
- 拆 `src/coach/PlayerPage.tsx`；去行级卡片壳改为紧凑细线表格 + `tabular-nums` + 2px 极简胜负边；保留全部筛选。
- **修复 `isGoalOwner` 目标归属隔离 Bug**，新增紧凑训练目标进度条（`0` 局核验时诚实提示，绝不显示 `0/0`），配撤掉即挂的回归测试 + `/p/:id` E2E 与双尺寸截图验收。

---

## 五、开工前待确认的 4 个决策点（均附推荐项）

1. **PR-2 引擎结论改造是否前置到首页改版（PR-3）之前？**
   - **推荐：是（PR-1 → PR-2 引擎结论 → PR-3 首页 → PR-4 工作台 → PR-5 玩家页）**。否则新首页首屏的 `9091400302` 实时复盘一上来就会展示「12 次死亡，代价大于收益」。
2. **PR-4 桌面端检查抽屉默认状态**：
   - **推荐**：桌面端（`≥1200px`）默认停靠展开（证据 / 追问 / 对比切换），移动端收起为底部弹层入口。
3. **PR-1 远程 MCP `coach_ask` 的 `Origin` 策略**：
   - **推荐**：按 `/mcp` 无状态接口标准校验 JSON + 长度 + IPv6 `/64` 限流 + `reviewLlmLimit` 成本护栏，不施加浏览器同源 `Origin` 拦截（与 `review_match` 一致）。
4. **PR-3 首页首屏布局**：
   - **推荐**：桌面端（`≥1024px`）左「河道主输入」+ 右「9091400302 实时迷你复盘」非对称双栏，紧接「四种用法 + 发给 Agent」与单行 7.42 版本条。
