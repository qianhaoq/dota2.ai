# dota2.ai 改版计划（参考 oil-ui，执行方：Antigravity）

> 写于 2026-11-22，main @ `d80c061`。本文件是执行计划，**不是**已完成的工作。
> 参考：https://ui.oiloil.org/ ，主要是其中三份指南：
> [反 AI 套路](https://ui.oiloil.org/en/guide/fix-ai-ui-slop/)、
> [落地页](https://ui.oiloil.org/en/guide/landing-page-design/)、
> [工作台](https://ui.oiloil.org/en/guide/dashboard-workspace-design/)。
> oil-ui 是一套 UI 设计方法（Skill，MIT），**不是组件库**：不要安装它，也不要复制它的页面，只借鉴原则。

---

## 0. 动手前必读（硬性规则）

- 先读 `CLAUDE.md`、`AGENTS.md`、`.cursor/rules/dota2-coach-invariants.mdc`。其中 A–B 节已标注退役，C 节「AI 输出语言」仍然有效。
- **一个问题一个 PR**，PR 必须填 `.github/pull_request_template.md`，并贴上实际跑过的命令和关键输出。
- **CI 门禁（每个 PR 都必须全绿）：**
  ```bash
  NODE_OPTIONS=--no-experimental-webstorage npx tsc --noEmit && node --check server.js && npm run build && npm test
  npm run test:e2e        # Playwright，使用 mock 服务器 scripts/mock-review-server.mjs
  ```
  本机 Node 26 需要 `NODE_OPTIONS=--no-experimental-webstorage`，否则约 147 个测试会误报失败；CI 用的是 Node 20。
- **不能为了变绿而弱化测试**：不删断言、不 skip、不改 fixture。布局变化导致旧断言失效时，要改写成验证新行为的断言，严格程度不能降低，并在 PR 里写明原因。
- **自动合并**需要绿色 CI、`codex / Codex Review Gate` 通过，且没有未解决的 P0/P1。P0/P1 必须改代码修复，并配一个「撤掉修复就会失败」的回归测试，然后回复评论并标记已解决。如果要先推修复、再处理别的，先给 PR 加 `no-auto-merge` 标签，以免它在中途被自动合并。
- **数据诚实**：不编造英雄、技能、版本事实，也不编造任何指标。数据缺失就显示「未知 / 样本不足」，绝不把缺失当成 false 或 0。
- **双语**：所有界面文案都要有 `{ en, zh }`，默认英文，可切换中文。
- **zsh 环境的坑**：
  - 不要用 `path`、`status` 当变量名，它们是 zsh 的特殊变量，会覆盖 `PATH` 等；
  - `pkill -f` 和 `ps | grep … | kill` 会匹配到自己所在的 shell，直接把它杀掉（exit 144）。结束进程请用 `cmd & PID=$!; kill $PID`，或者先列出 PID，再在另一次调用里 kill；
  - zsh 不会对未加引号的 `$var` 做分词。
- 改完 UI 必须截图验收：**1440×900 和 390×844 两种尺寸**，页面不能出现横向滚动；再缩小到 50% 看一遍，检查有没有模板感。

---

## 1. 已核实的事实（不要再假设）

| 项 | 现状 |
|---|---|
| 路由 | 只有 `/`、`/r/:id`、`/p/:id`；其他路径都跳回首页。`/new`、`/m`、`/legacy` 由服务端 301 到首页 |
| 卡片协议 | `lib/coach/cards.js`（`dota-coach-ui/2`），`GET /api/coach/:id/cards?seat=0-9`。前端用同一个模块（`buildSurface`）在本地构建 |
| 远程 MCP | `https://dota2.ai/mcp`，无状态 Streamable HTTP。**目前只有 `review_match`、`get_evidence` 两个工具**，已实测 `initialize` 和 `tools/list` 正常 |
| 本地 MCP | `packages/mcp/bin/dota2ai-mcp.js`（stdio），共 8 个工具：上面 2 个，加上 `recent_matches`、`coach_report`、`coach_cases`、`coach_ask`、`goal_check`、`hero_matchup` |
| 远程没有教练工具的原因 | `packages/mcp/src/index.js` 的 `attachMcp` 传了 `coachTools: false`。注释写的是：教练工具通过 HTTP 回调本站，所有 Agent 的请求会从同一个 IP 进来，挤进同一个限流桶 |
| CLI | `packages/cli`（`dota2ai`），**没有发布到 npm**，只能 clone 仓库后用 `node packages/cli/bin/dota2ai.js …` 运行。命令有 `review`、`recent`、`coach`、`cases`、`ask`、`goal`、`matchup`（`--rank`） |
| HTTP | `GET /api/v1/review/:id?hero=` 可直接用 curl 调用；文档在 `/openapi.json` 和 `/llms.txt` |
| 主要前端文件 | `src/coach/CoachApp.tsx`：`Shell`（约 L207）、`PlayerPage`（约 L314）、`SAMPLE_CARDS` 和 `HOME`（约 L546）、`CoachHome`（约 L565）、`CoachReportPage`（约 L682）、`CardFeed`（约 L1421）。另有 `Chapters.tsx`、`GoldTimeline.tsx`、`AskPanel.tsx`、`coach.css`、`cards.css` |
| 样式令牌 | 在 `src/coach/cards.css` 顶部的 `.cx { --ink … }`：深色石板底，天辉绿 `--radiant` 和夜魇红 `--dire` 是仅有的两种阵营色，金色 `--accent` 用于强调 |

---

## 2. 对照 oil-ui 反套路清单的现状诊断

1. **eyebrow 小标签泛滥**：`cx-eyebrow`、卡片顶部的「教练判断 / 统计」等。只保留真正表示状态的标签。
2. **卡片套卡片**：复盘页卡片外框里还套着证据方块、关键数据方块、对位方块。应该去掉外框，用网格对齐、留白和单条细线来分组。
3. **三张等宽卡**：首页的 3 张示例复盘卡、「01/02/03」三条原则。改成非对称布局，或者直接在页面上放一个能用的交互控件。
4. **字号过多、灰字过小**：现在 11/12/12.5/13/13.5/14/15px 混用。收敛为 **4 档**：展示标题、区块标题、正文、说明文字。正文对比度要足，每行 55–75 个字符。
5. **饱和色只给需要处理的异常**：绿和红只用在胜负和「要改的点」上，其余一律用中性色。
6. ✅ 没有编造指标，这一点保持。

---

## 3. PR 拆分与验收标准（按顺序做）

### PR-1 远程 MCP 补齐教练工具（先做：首页要靠它兑现承诺）

**目标**：`https://dota2.ai/mcp` 的 `tools/list` 返回全部 8 个工具，并且不出现「所有 Agent 共用一个限流桶」的问题。

**做法**：
- 不能简单删掉 `coachTools: false`。在 `routes/v1/index.js` 调用 `attachMcp` 的地方，给每个请求注入一个**进程内的 coach 适配器**（选项 `coach`，形状和 `createCoachApi` 返回的 `{ report, cases, ask, recent, matchup }` 一致）。
  - 直接调用 `lib/coach` 里的函数，不走 HTTP 回环：`buildCoachReport`、cases、ask、`matchupBrief`。
  - **限流按 MCP 调用方的 IP 计算**（`resolveClientIp(req)`），复用教练路由同一个 limiter 实例，或者新建一个同等配置的。
  - `ask` 和 LLM 相关的成本守卫要沿用教练路由现有的限额，不能绕过。
- `attachMcp` 新增参数，例如 `coachForRequest(req, res)`；有这个参数时开启 coach 工具。stdio 的行为不变。
- 更新 `README.md`、`packages/mcp/README.md`、`routes/v1/openapi.js`、`llms.txt` 里关于「远程只有 2 个工具」的说法。

**测试**：
- `packages/mcp/test` 或 `packages/review-engine/test/apiV1.test.js`：远程 `tools/list` 返回 8 个工具；`coach_report`、`hero_matchup` 能通过进程内调用返回正确数据。
- 限流：同一个 IP 超额后返回 429 或对应的 MCP 错误，**不同 IP 互不影响**。这条测试要证明限流按调用方计算，而不是共用一个桶。
- 撤掉修复后，以上测试必须失败。

**验收**：在本地启动 `server.js`，按下面的方式请求 `/mcp` 的 `initialize`、`tools/list`，再调用一次 `hero_matchup`：
```bash
curl -s -X POST http://127.0.0.1:8080/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json,text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

### PR-2 首页改版：首屏回答三个问题，并明确支持 CLI 和 Agent

依据 oil-ui 落地页指南：首屏要回答「这是什么 / 为什么不同 / 现在能试什么」，首屏放一个真实可用的对象，不放装饰图。

**结构**（`CoachHome`，可以拆到 `src/coach/Home.tsx`）：
1. **定位**：一句标题加一句副标题，明确两点：①每条结论都有数据依据；②会说明哪些看不到。去掉多余的 eyebrow。
2. **主输入**：保留现有的「比赛 / 好友码」切换和小地图河道动效。这是唯一的记忆点，其余保持安静。
3. **首屏的真实对象**：输入框下方嵌一份**示例比赛 9091400302 的迷你复盘**。
   - 数据实时来自 `GET /api/coach/9091400302/cards?seat=0`，内容是阵容条、要点卡和第一条发现。
   - 可以在 0 / 2 / 4 号座位间切换，点击进入完整复盘。
   - 请求失败时显示「示例暂时不可用」，**不要写死假数据**。
   - 用它替换现在的 3 张等宽示例卡（`SAMPLE_CARDS`）。
4. **「四种用法」区块（必须在首屏，或紧接首屏）**：一个分段切换，每个标签都配一行等宽字体的命令和一个「复制」按钮，复制后显示已复制的反馈。
   - **网页**：就是上面的输入框（锚点跳转）。
   - **Agent (MCP)**：`claude mcp add --transport http dota2ai https://dota2.ai/mcp`。补一行说明「Cursor / Claude Desktop 等支持远程 MCP 的客户端，填这个 URL 即可」，并列出工具名。**写 8 个工具的前提是 PR-1 已上线**，否则只能写现有的 2 个。
   - **CLI**：
     ```bash
     git clone https://github.com/qianhaoq/dota2.ai && cd dota2.ai && npm ci
     node packages/cli/bin/dota2ai.js review 9091400302 --hero tidehunter
     ```
     要如实注明「未发布到 npm」，再附一行 `matchup tidehunter ursa --rank legend` 示例。
   - **HTTP**：`curl 'https://dota2.ai/api/v1/review/9091400302?hero=tidehunter'`，并链接到 `/openapi.json` 和 `/llms.txt`。
   - 区块底部再放一个「**发给你的 Agent**」的可复制提示词，借鉴 oil-ui「Send it to your Agent」的做法，例如：
     > 帮我复盘 Dota 2 比赛 <比赛ID>（我玩的是 <英雄>）。接口说明见 https://dota2.ai/llms.txt ；能用 MCP 就连 https://dota2.ai/mcp 。
   - 现有的 `AgentSnippets`（折叠的「给 Agent 和脚本」区块）**由这一块取代**，不要两处重复。
5. **版本动态**：压缩成一行，例如「7.42 已上线 · 新装备 6 件 · 更新日志 ↗」，展开后显示详情。
6. **删除**「01/02/03」三列原则。理念可以融进第 1 点的副标题，或者第 3 点的示例里。

**测试**：
- 首页断言里出现四种用法、对应命令的文字，以及「复制」按钮（mock `navigator.clipboard`，断言写入的内容正确）。
- 示例复盘在接口失败时显示降级文案。
- 原有测试照常通过：`App.test.tsx` 的 h1、占位符、单一输入框，`CoachPlayerPage.test.tsx` 的好友码模式，`PatchNews.test.tsx` 的顺序断言。如果确实需要改写，要说明理由，并且不能降低严格程度。
- 截图验收 1440×900 和 390×844；命令行在手机上不能撑出横向滚动，命令区可以横向滚动或自动换行。

### PR-3 复盘页改成工作台

依据 oil-ui 工作台指南：以领域主对象为锚，布局是「左侧导航 + 中间工作区 + 右侧检查抽屉」。

- **主对象是比赛时间线**：经济曲线加死亡、团战标记（`GoldTimeline`）固定在顶部，作为整页的导航主轴。点时间点就打开检查抽屉。
- **三栏（≥1200px）**：
  - **左**：10 人阵容竖排，用来选人，替代现在的横排 `Lineup`；
  - **中**：要点和各条发现，以及各章节，章节可以折叠；
  - **右**：**检查抽屉**，替代常驻的 `AskPanel`。点一条发现、一个时间点或一个对位，抽屉里显示证据、「问教练」（AskPanel 移到抽屉里）和「对比」（`CompareCard`）。
  - 手机端改成单列，抽屉变成底部弹层。
- **卡片动作照旧来自引擎**：`CardFeed` 的 `run()` 分发逻辑保留，只把 `inspect`、`ask`、`compare` 的目标从「滚动到某处」改成「打开抽屉」。白名单和校验（`validateSurface`）不变。
- **去掉卡中卡**：`.cxv-card` 外框只保留给真正独立的单元，证据方块改成行内的键值对；数字一律等宽并右对齐（`font-variant-numeric: tabular-nums`）。
- **颜色**：饱和色只用于胜负、「要改的点」以及「更难打 / 你吃亏」这类判定，其余都用中性色。
- **字号**：全局收敛到 4 档，在 `cards.css` 里定义成令牌，例如 `--fs-display`、`--fs-h`、`--fs-body`、`--fs-meta`。
- **测试**：
  - 改写 `RedesignInteractions.test.tsx`、`CardFeed.test.tsx` 等受影响的断言，覆盖面不能缩小；
  - 新增：点发现会打开抽屉，并显示该发现的证据；抽屉里的问答带上这张卡片作为上下文；时间点能打开对应的死亡或团战行；
  - 原有行为必须保留：解析过程中切换玩家不中断轮询、职业对局能跳到对应主题、对比按钮可用。这些都是之前 Codex 指出过 P1 的地方。
  - 截图验收两种尺寸。

### PR-4 玩家页

- 以比赛列表为主对象：表格行加一条紧凑的状态条（训练目标进度：做到了几场 / 共几场）。
- 胜负只用一条细色边表示，不要满屏绿红。
- 筛选条保留。
- 测试：`CoachPlayerPage.test.tsx` 照常通过；新增状态条的断言。

---

## 4. 完成定义

- 每个 PR：CI 门禁全绿、e2e 通过、Codex 审查没有未解决的 P0/P1、两种尺寸的截图已检查，合并后线上验证一次。
- PR-2 上线后，`https://dota2.ai/` 首屏或紧接首屏，能**直接看到并复制** Agent（MCP）、CLI、HTTP 三种接入命令，而且页面上声称的工具数和线上 `tools/list` 一致。
- 不留双份入口：首页的旧 `AgentSnippets` 被新区块取代。
- 不要动 #209（身份迁移，Draft）。
