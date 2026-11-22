# 去 OpenDota / STRATZ 依赖方案：Steam GC + 自建 `odota/parser` 执行计划

> 写于 2026-11-22，基准 `main @ d80c061`。本文件是交接给 Claude Code 的实施计划，**不是**已完成的代码。
> 触发背景：`api.opendota.com` 全站 `HTTP 520`（正值 `odota/core` #3015 Cassandra → ClickHouse 切流），且 `STRATZ_API_TOKEN` 不可用；线上 `dota2.ai/api/health/upstream` 显示 `matchStore.configured=false`、`stratz.configured=false`，导致站点在 OpenDota 宕机期间无法拉取新比赛与最近对局。

---

## 0. 动手前必读（硬性规则）

- 读 `AGENTS.md`、`.cursor/rules/dota2-coach-invariants.mdc`、`docs/MATCH_CACHE.md`。
- **一个目标一个 PR**，每个 PR 从最新 `origin/main` 切分支；不要碰 `#209` 或工作区未跟踪的 `CLAUDE.md`、`scripts/identity/`、`tests/`。
- **CI 门禁（每个 PR 必跑且全绿，Node 26 需加 `NODE_OPTIONS`）**：
  ```bash
  NODE_OPTIONS=--no-experimental-webstorage npx tsc --noEmit && node --check server.js && npm run build && NODE_OPTIONS=--no-experimental-webstorage npm test
  ```
- **绝不提交或打印任何凭证**：Steam 账号密码、`refreshToken`、`STEAM_WEB_API_KEY`、`STEAM_RETRIEVER_SECRET` 只能走环境变量 / GCP Secret Manager；日志必须过 `redactSecrets` 且绝不打印账号名或密码。
- **防 SSRF（硬红线）**：发往 `odota/parser` 的 `replay_url` 必须严格校验格式 `^http://replay\d{1,5}\.valve\.net/570/[1-9]\d{0,14}_\d{1,12}\.dem\.bz2$`（只允许官方 Valve replay 域名与路径，拒绝任意 URL 注入）。
- **数据诚实**：Steam GC + `odota/parser` 没有 OpenDota 全网百分位 `benchmarks` 时必须保持 `undefined/null`（不得伪造百分位）；缺失字段如实写入 `data_gaps`。

---

## 1. 架构总览（零数据库、100% 兼容现有 `lib/coach/analyze.js`）

从 `odota/core` 和 `odota/parser` 源码核实，**无需搭建 OpenDota 的 Postgres / Redis / ClickHouse**，仅需两个轻量化自建服务 + 现有 GCS `matchStore` 即可形成完整闭环：

```text
用户请求 /r/:matchId 或 /p/:accountId
  │
  ▼
dota2.ai (Cloud Run · server.js)
  ├── 1. 先查 GCS matchStore（lib/matchStore.js，已解析对局永久命中，0 配额消耗）
  ├── 2. OpenDota（未熔断且为主源时）
  └── 3. 回退或直走自建 Steam 链路：
        │
        ├─▶ [服务 A] services/steam-retriever（常驻小 VM，~150MB 内存，Node 24）
        │     基于 odota/core/svc/retriever.ts + steam-user-odota + Valve .proto
        │     • GET /match/:id      → GC k_EMsgGCMatchDetailsRequest (7095)
        │                             返回 CMsgDOTAMatch（完整 10 人计分板 + cluster + replay_salt）
        │     • GET /history/:acct  → GC k_EMsgDOTAGetPlayerMatchHistory (7408)
        │                             返回玩家最近公开比赛列表（含 hero_id/winner/duration/start_time）
        │     • GET /healthz        → 在线账号数、当日配额统计（不泄密）
        │
        └─▶ [服务 B] odota/parser（无状态 Java/Clarity 容器，Cloud Run 4Gi 或同 VM :5600）
              原版 github.com/odota/parser Docker 镜像
              • GET /blob?replay_url=http://replay<cluster>.valve.net/570/<id>_<salt>.dem.bz2
                自动下载 → 自动识别 bzip2 / zstd 解压 → Clarity 解析 → CreateParsedDataBlob.java
                直接返回与 OpenDota 100% 同结构的 parsed JSON（radiant_gold_adv/teamfights/kills_log/gold_t/lane_pos/...）
              • POST /?blob（接收原始 .dem 二进制，供后续本地上传/CLI 解析）
  │
  ▼
mergeGcAndParsed(gcMatch, parsedBlob) → 写入 GCS matchStore（永久缓存）→ buildCoachReport()
```

### 已核实的底层约束（来自 `odota/core` 源码）
1. Valve Steam Web API `IDOTA2Match_570/GetMatchDetails` 已失效（`odota/core/svc/fetcher/ApiFetcher.ts:25` 已注释），且不返回 `replay_salt`。
2. Valve Steam Web API `IDOTA2Match_570/GetMatchHistory/V001` 仍可用（需 `STEAM_WEB_API_KEY`，不占 GC 配额，但只返回基础列表，不含胜负/KDA/时长）。
3. Valve GC `CMsgGCMatchDetailsRequest` 限额约 **100 场/Steam 账号/天、500 场/IP/天**（`odota/core/svc/retriever.ts:3`）；配合 GCS 永久缓存，1–5 个免费 Steam 小号可支撑每天 100–500 场**全新未缓存对局**。
4. Valve CDN 非职业录像约保留 **7–14 天**；2025 年 3 月起 Valve 隐藏 8500+ 冠绝局公开查询（仅本地 `.dem` 上传可解）。

---

## 2. 分 PR 实施计划（按顺序，每个 PR 独立可测、可回滚）

### PR-A：OpenDota 5xx/520 连续失败熔断 + 上游策略抽象（0.5 天）

**目标**：OpenDota 520/522/5xx 宕机时不再每个请求白撞一次超时，快速触发共享熔断切到备用源；同时补齐运维配置清单。

**改动文件**：
- `lib/upstream/opendota.js`：
  - 新增 `outageThreshold`（默认 3 次连续 `5xx` 或 Cloudflare `520`/`522`/`524` 或网络超时）和 `outageCooldownMs`（默认 `60_000` ms）；
  - 触发后写入同一 `cooldown`（内存或 GCS `sharedCooldown`），并在 `snapshot()` 暴露 `outageTrips`、`lastOutageAt`；
  - 任意 2xx 响应重置连续失败计数；保持 404 不计入宕机。
- `lib/upstream/sourceOrder.js`（新建纯模块）：
  - 解析 `UPSTREAM_PRIMARY`（`opendota` 默认 | `steam_gc`），决定单场与最近比赛的源顺序，便于 OpenDota 宕机期间一键切 `UPSTREAM_PRIMARY=steam_gc` 零延迟。
- `docs/MATCH_CACHE.md`（补充一节）：线上开启 `MATCH_CACHE_BUCKET` 的 `gcloud` 验证命令（确认 `/api/health/upstream` 返回 `matchStore.configured: true`）。

**测试**：
- `src/utils/opendotaClient.test.ts`：
  - 连续 3 次 520 打开 cooldown，第 4 次在 cooldown 内 0ms 快速失败（不发 `fetch`）；
  - 2 次 520 + 1 次 200 重置计数，不误熔断；
  - 404 不触发熔断；
  - 撤掉熔断逻辑测试必挂。

---

### PR-B：Steam GC Retriever 服务 + `lib/upstream/steamGc.js` 映射与回退接入（1–2 天）

**目标**：完全不依赖 OpenDota/STRATZ，直接通过 Steam GC 获取单场完整计分板（含 `cluster` + `replay_salt`）与玩家最近比赛，接入 `server.js`。

#### Part 1：独立轻量 Retriever 服务（`services/steam-retriever/`）
- 新建目录 `services/steam-retriever/`（独立 `package.json` + `Dockerfile`，不污染根应用依赖）：
  - `server.mjs`（参考 `odota/core/svc/retriever.ts`）：
    - 使用 `steam-user`（或 `steam-user-odota`）+ `protobufjs` + 精简必需的 Valve `.proto`（`gcsystemmsgs.proto`、`enums_clientserver.proto`、`dota_gcmessages_msgid.proto`、`dota_gcmessages_common.proto`、`dota_gcmessages_client.proto`、`dota_shared_enums.proto` 等，附更新脚本 `scripts/update-protos.mjs` 从 `SteamDatabase/Protobufs` 拉取）。
    - **鉴权**：除 `/healthz` 外，所有路由强制校验 `Authorization: Bearer <STEAM_RETRIEVER_SECRET>`（常量时间比较 `timingSafeEqual`）；未设置密钥时拒绝启动（fail closed）。
    - **账号池与配额守卫**：
      - 支持多账号配置（`STEAM_ACCOUNTS_JSON` 或 `STEAM_USER`/`STEAM_PASS` 逗号分隔，或持久化 `refreshToken` 目录 `STEAM_DATA_DIR` 避免重启重复触发邮箱 Steam Guard）；
      - 轮询可用账号，硬上限 `MAX_MATCHES_PER_ACCOUNT_DAY=95`、`MAX_MATCHES_PER_IP_DAY=480`（UTC 0 点清零），超额直接返回 `429` + `Retry-After`；
      - 进程内按 `matchId` 合并并发 in-flight GC 请求，防止重复打爆配额。
    - **端点**：
      - `GET /healthz` → `{ ok, readyAccounts, dailyUsed, dailyCap }`（零敏感信息）
      - `GET /match/:matchId` → 发送 `k_EMsgGCMatchDetailsRequest (7095)`，超时 6s：
        - `result === 2` → `404 { code: 'not_found' }`
        - `result === 15` → `451 { code: 'valve_blocked' }`（不可重试）
        - 成功 → `200` 返回解码后的 `CMsgDOTAMatch` JSON
      - `GET /history/:accountId?limit=20` → 发送 `k_EMsgDOTAGetPlayerMatchHistory (7408)`，返回 `matches[]`（含 `match_id`, `start_time`, `hero_id`, `winner`, `game_mode`, `lobby_type`, `duration`, `abandon`）。
  - `Dockerfile`（`node:22-alpine`）+ `README.md`（GCE `e2-micro` / Docker Compose 部署与 `refreshToken` 首次登录指南）。

#### Part 2：主站适配器（`lib/upstream/steamGc.js` + `server.js`）
- 新增 `lib/upstream/steamGc.js`：
  - `mapGcMatch(raw, fetchedAt)`（纯函数，全单测覆盖）：
    - 校验 `match_id` 与 10 名玩家，按 `player_slot`（天辉 0–4，夜魇 128–132）规范化；
    - 映射 `radiant_win`（兼容 `match_outcome === 2` / `k_EMatchOutcome_RadVictory` 与 `match_outcome === 3` / `k_EMatchOutcome_DireVictory`，未知时 fail closed 抛错而不猜）、`radiant_score`、`dire_score`（由两队击杀聚合或字段读取）、`duration`、`start_time`、`game_mode`、`lobby_type`、`cluster`、`replay_salt`、`patch`（按 `start_time` 映射已知版本，未知留 `null`）；
    - 映射 10 名玩家：`account_id`、`player_slot`、`isRadiant`、`team_number`、`hero_id`、`kills`、`deaths`、`assists`、`last_hits`、`denies`、`gold_per_min`、`xp_per_min`、`net_worth`、`level`、`hero_damage`、`tower_damage`、`hero_healing`、`item_0..5`、`backpack_0..2`（GC `item_6..8`）、`item_neutral`（GC `item_9`，注意 GC 空槽位默认 `-1` 须归一化为 `0`！）；
    - 标记 `od_data: { has_parsed: false }`、`data_source: 'steam_gc'`、`gc_fetched_at: fetchedAt`；
    - **重要细节**：验证 `CMsgDOTAMatch.Player` 里未设置装备槽位默认值是 `-1`（`proto` 写明 `[default = -1]`），必须把 `< 0` 转为 `0`，否则会被误当成无效物品 ID！
  - `buildValveReplayUrl({ match_id, cluster, replay_salt })`：校验三项为正整数后返回 `http://replay${cluster}.valve.net/570/${match_id}_${replay_salt}.dem.bz2`，否则返回 `null`。
  - `mapGcHistory(accountId, resp)`：映射为 `lib/coach/recent.js` 同结构 `{ account_id, matches, empty_hint }`（注意 `CMsgDOTAGetPlayerMatchHistoryResponse.Match` 若无 `kda`/`player_slot`，`kda` 诚实置空/处理，不编造 `0/0/0`——需同步确认 `CoachPlayerPage` 对未知 `kda`/`slot` 的安全渲染！）。
  - `createSteamGcClient({ baseUrl, secret, fetchImpl, timeoutMs, log })`：提供 `fetchMatch(matchId, opts)`、`fetchRecent(accountId, opts)`、`snapshot()`。
- `server.js` 接线：
  - 读取 `STEAM_RETRIEVER_URL` + `STEAM_RETRIEVER_SECRET`；未配置时为 `null`（零影响）；
  - `matchDetailCache` 的 `fetchMatch`：按 `sourceOrder`（默认 OpenDota → Steam GC → STRATZ；`UPSTREAM_PRIMARY=steam_gc` 时 Steam GC → OpenDota）；404/客户端中止不回退；
  - `createRecentService` 的 `fetchRecent`：OpenDota 失败时回退到 `steamGc.fetchRecent`（可选再回退 Steam Web API `GetMatchHistory` 当配了 `STEAM_WEB_API_KEY`）；
  - `/api/health/upstream` 增加 `steamGc: steamGc ? steamGc.snapshot() : { configured: false }`。

**测试**：
- `src/utils/steamGc.test.ts`：
  - `mapGcMatch` 完整映射测试（含 `item_* === -1` → `0`、`match_outcome` 天辉/夜魇胜负、直接把映射结果喂给 `buildCoachReport()` 断言不崩溃且产出有效报告与 `data_gaps`）；
  - `buildValveReplayUrl` 合法与非法输入测试；
  - `createSteamGcClient` 鉴权头、404、451、429、超时、AbortSignal 传播；
  - `fetchRecent` 回退与不编造缺失 KDA 测试。

---

### PR-C：接入自建 `odota/parser` + 完整已解析复盘闭环（1–1.5 天）

**目标**：拿到 `cluster` + `replay_salt` 后，调用自建 `odota/parser` 容器把 Valve `.dem.bz2` 解析成 100% OpenDota 兼容的 parsed JSON，合并后永久写入 GCS `matchStore`，让「解析这场比赛」在 OpenDota 挂掉时也完全可用。

**改动文件**：
- `lib/upstream/odotaParser.js`（新建）：
  - `isAllowedValveReplayUrl(url)`：严格正则校验 `^http://replay\d{1,5}\.valve\.net/570/[1-9]\d{0,14}_\d{1,12}\.dem\.bz2$`；
  - `createOdotaParserClient({ baseUrl, authToken, fetchImpl, timeoutMs = 120_000, maxConcurrent = 2, log })`：
    - 请求 `GET ${baseUrl}/blob?replay_url=${encodeURIComponent(url)}`（支持 GCP IAM ID Token 或内部共享密钥头）；
    - 按 `matchId` 合并并发解析任务，全局并发上限 `maxConcurrent`（防止打爆 parser 内存）；
    - 区分 `404/410`（录像已过期，不重试）、`5xx/timeout`（可重试）、空响应/非法 JSON（失败不落盘）。
  - `mergeGcAndParsed(gcMatch, parsedBlob)`（纯函数）：
    - 以 `gcMatch` 的计分板和元信息为基础，叠加 `odota/parser` 输出的：
      - 顶层：`radiant_gold_adv`、`radiant_xp_adv`、`teamfights`、`objectives`、`pauses`、`draft_timings`、`chat`、`version`；
      - 玩家级（按 `player_slot` 精准对齐，**严禁仅靠数组下标盲拼**）：`gold_t`、`lh_t`、`dn_t`、`xp_t`、`times`、`kills_log`、`purchase_log`、`obs_log`、`sen_log`、`lane_pos`、`damage`、`damage_taken`、`damage_inflictor`、`damage_inflictor_received`、`killed`、`killed_by`、`ability_uses`、`item_uses`、`buyback_log`、`runes_log`、`life_state`、`stuns`、`max_hero_hit`；
    - 仅当核心解析字段存在（如 `Array.isArray(radiant_gold_adv)` 且玩家有 `gold_t`/`purchase_log`）时才设置 `od_data: { has_parsed: true }`，并通过 `isMatchParsed(merged)` 校验；
    - 标记 `data_source: 'steam_gc+odota_parser'`。
- `lib/matchReview/parseRequestSubmit.js` / `server.js`：
  - 新增 `ODOTA_PARSER_URL`（可选）+ `AUTO_PARSE_STEAM_GC`（默认 `0`，先显式按按钮触发，避免意外消耗解析算力；也可设为 `1` 自动后台解析）；
  - 当用户点击「解析这场比赛」（`POST /api/review/:matchId/parse-request`）时：
    - 若 OpenDota 处于熔断/不可用，或 `UPSTREAM_PRIMARY=steam_gc` 且配置了 `ODOTA_PARSER_URL`：
      - 复用现有 `parseRequestBudget`（每 IP / 全局配额）与 `parseRequestTracker`（每 match 去重冷却）；
      - 异步后台触发 `steamGc.fetchMatch` → `buildValveReplayUrl` → `odotaParser.parseByUrl` → `mergeGcAndParsed` → 写入 `matchDetailCache` 与 GCS `matchStore`；
      - 接口立即返回 `{ status: 'pending', provider: 'self_hosted' }`，前端现有 20 秒轮询机制**零改动**自动拿到完整已解析复盘！
- `docs/SELF_HOSTED_PARSER.md`（新建）：记录 `odota/parser` 部署到 Cloud Run（4Gi RAM、2 vCPU、concurrency=2、ingress=internal、timeout=180s）与 GCE `e2-micro` 跑 `services/steam-retriever` 的具体命令。

**测试**：
- `src/utils/odotaParser.test.ts`：
  - SSRF 防护测试（拒绝 `http://169.254.169.254/...`、`file://...`、`https://evil.com/...`、带 query/userinfo 的 URL，仅放行标准 `replay<N>.valve.net/570/<id>_<salt>.dem.bz2`）；
  - `mergeGcAndParsed`：用真实结构 fixture 合并后跑 `isMatchParsed()` 断言 `true`，再喂给 `buildCoachReport()` 和 `buildReview()` 断言全部章节（`story.why`、`laning`、`deaths`、`items`、`fights`、`plan`）与 `buildSurface()` 全量生成且无 NaN / 崩溃；
  - 按 `player_slot` 对齐测试（乱序 `parsedBlob.players` 仍能准确对齐到对应玩家）；
  - `parse-request` 自建链路测试：预算超限返回 throttled、录像 404 返回 expired/failed 且不污染缓存、解析成功后下次 `GET /api/coach/:id` 直接返回 `parsed: true`。

---

### PR-D（可选后续，零 GC 配额补充）：支持本地 `.dem` 走 `odota/parser` `POST /?blob`

- 面向 8500+ 隐藏冠绝局、自定义房间或 CDN 已过期的老比赛：
  - CLI 增加 `dota2ai parse-local <path/to/match.dem>`（或网页端拖拽上传 `.dem`，加大小与速率限制）；
  - 直接流式提交给 `odota/parser` 的 `POST /?blob`，产出完整复盘，**完全不占 Steam GC 每日配额**。

---

## 3. 最小部署拓扑与成本估算

| 组件 | 推荐运行位置 | 配置 | 预估成本 |
|---|---|---|---|
| `dota2.ai` 主站 | 现有 Cloud Run (`asia-east1`) | 现有配置 + 配 `MATCH_CACHE_BUCKET`、`STEAM_RETRIEVER_URL`、`ODOTA_PARSER_URL` | 不变 |
| `MATCH_CACHE_BUCKET` | GCP Cloud Storage（同区 `asia-east1`） | 标准存储，单场 JSON ~100–300KB | <$1 / 月 |
| `services/steam-retriever` | 常驻小 VM（GCE `e2-micro` 或现有服务器） | 1GB 内存足够，1–5 个免费 Steam 小号，仅允许内网/鉴权访问 | $0（免费层）～$7 / 月 |
| `odota/parser` | 第二个 Cloud Run 服务（内网 ingress） | 4GiB 内存 / 2 vCPU / concurrency=2 / min-instances=0 | 按解析秒数计费（闲时 $0，千场约 $1–2） |

---

## 4. 验收清单（每个 PR 完成后逐项核对）

1. **PR-A**：本地单测全绿；模拟 OpenDota 连续 3 次 520 触发熔断，`/api/health/upstream` 显示 `outageTrips >= 1`。
2. **PR-B**：
   - 本地用 1 个测试 Steam 账号跑起 `services/steam-retriever`，实测 `curl -H "Authorization: Bearer ..." http://127.0.0.1:5700/match/9091400302` 返回完整 `CMsgDOTAMatch` 与 `replay_salt`；
   - 断开 OpenDota（或设 `UPSTREAM_PRIMARY=steam_gc`），本地 `server.js` 打开 `/r/9091400302` 和 `/p/<friendCode>` 正常出图出数据；
   - 确认 `item_* = -1` 不会渲染出异常装备图标。
3. **PR-C**：
   - 本地起 `docker run -p 5600:5600 odota/parser`（或构建 `github.com/odota/parser`），实测 `/blob?replay_url=...` 产出 JSON 与 `CMsgDOTAMatch` 合并后喂给 `buildCoachReport()`，对比 `match9091400302.parsed.json` 的核心章节（经济曲线、对线、死亡、团战、出装时间线）一致；
   - OpenDota 熔断状态下点击「解析这场比赛」，验证后台解析完成、写入 `matchStore`、前端轮询自动切到已解析视图。
4. **全程门禁**：每个 PR 均通过 `tsc --noEmit` + `node --check server.js` + `npm run build` + `npm test` + `npm run test:e2e`，不弱化任何断言。
