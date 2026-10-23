# 三级回滚 / Three-tier Rollback

> 目标：出问题时按 **① → ② → ③** 顺序逐级升级，影响面从小到大。
> 原则：先用开关（秒级、可逆），再重建前端（分钟级），最后切流量（最后手段）。
>
> Escalate **① → ② → ③** when something goes wrong: switches first
> (seconds, reversible), then a frontend rebuild (minutes), traffic cutover
> only as the last resort.

| 级别 Tier | 手段 Lever | 生效方式 | 影响范围 | 恢复 |
| --- | --- | --- | --- | --- |
| ① | `LLM_PHRASING=false` | 服务端 env，新修订热读 `process.env` | 仅 LLM 措辞 → 纯模板 | 删 env 或设 `true` |
| ② | 构建期 `VITE_FF_UI_V2=0` | **重新构建镜像**（Dockerfile `ARG`）并部署新修订 | `/` 回到 legacy UI | 再以默认构建部署 |
| ③ | Cloud Run 流量切回上一修订 | `gcloud run services update-traffic`（脚本见 `QA.md`） | 整站回到旧版本 | 再切回新修订 |

服务与区域 / Service & region: `dota2-ai` @ `asia-east1`, project `aegis-assistant-488913`。

---

## ① LLM 措辞回退（秒级）/ LLM phrasing off

**症状**：LLM 措辞产出异常（乱码、超时率高、内容质量问题），模板与数据本身没问题。

设置服务端 env `LLM_PHRASING=false`：所有跟进问答（`POST /api/v1/review/:id/ask`）的措辞改走
**纯模板**（`phrasing: "template"`），不再调用 DeepSeek/Gemini；洞察卡与数据不受影响。
代码在每个请求处热读 `process.env.LLM_PHRASING`（`routes/v1/index.js`），因此新修订一接流量即生效。

```bash
gcloud run services update dota2-ai --region asia-east1 --project aegis-assistant-488913 \
  --update-env-vars LLM_PHRASING=false
```

> 必须用 `--update-env-vars`（只改列出的键，保留其余 env）。**不要**用 `--set-env-vars`：
> 官方语义会先清空再写入，事故时会把已有的 `UI_V2` / 密钥以外的调参一并抹掉。

验证 / verify:

```bash
curl -s https://dota2.ai/api/v1/config | jq '.flags.llm_phrasing'   # → false
```

恢复 / roll forward：`--update-env-vars LLM_PHRASING=true`，或 `--remove-env-vars LLM_PHRASING`。

## ② 前端 UI 回退（构建期 flag）/ Frontend UI back to legacy

**症状**：v2 UI（`/` 上的对话式首页）出现阻断性缺陷，需要把 `/` 交回 legacy 应用。

v2 UI 由**构建期** env `VITE_FF_UI_V2` 决定（`src/v2/flags.ts`，`DEFAULT_FLAGS.ui_v2`）。
镜像构建在 Dockerfile 的 builder 阶段执行 `npm run build`，且 `.dockerignore` 排除本地 `dist`，
因此**只在宿主机设 `VITE_FF_UI_V2=0` 再 `npm run build` 无效**——必须把 flag 作为 Docker
**`ARG VITE_FF_UI_V2`** 传入（Dockerfile 再 `ENV` 给 Vite）。未传 ARG 时 env 为空，解析回落到
`DEFAULT_FLAGS.ui_v2 === true`。

以 `VITE_FF_UI_V2=0` 打新镜像并部署后，`/` 回到 legacy；v2 仍可通过 `/new` 与 `/m/:id`
预览面访问（路由强制 ui_v2，见 `resolveFlags`）。

### 本地 / 显式 docker build

```bash
# 回滚镜像（legacy on /）
docker build --build-arg VITE_FF_UI_V2=0 \
  -t REGION-docker.pkg.dev/PROJECT/REPO/dota2-ai:ui-v2-off .

# 默认构建（省略 ARG → v2 on /）
docker build -t REGION-docker.pkg.dev/PROJECT/REPO/dota2-ai:latest .
```

推镜像后按常规 `gcloud run deploy` / `gcloud run services update --image` 上新修订
（`main` 触发器若只换 image，会保留已有 secret/env）。

### 与现有 Cloud Build 流程对齐

仓库日常路径是 `gcloud builds submit --tag …`（见 README）：该快捷方式**不能**传
`--build-arg`。需要回滚镜像时，用一次性 config + substitution（与 Dockerfile `ARG` 对齐）：

```bash
# 按需改 IMAGE；_VITE_FF_UI_V2=0 打回滚镜像
IMAGE=asia-east1-docker.pkg.dev/aegis-assistant-488913/REPO/dota2-ai:ui-v2-off
cat > /tmp/cb-ui-v2.yaml <<'YAML'
steps:
- name: gcr.io/cloud-builders/docker
  args:
  - build
  - --build-arg
  - VITE_FF_UI_V2=${_VITE_FF_UI_V2}
  - -t
  - ${_IMAGE}
  - .
images:
- ${_IMAGE}
substitutions:
  _VITE_FF_UI_V2: "0"
  _IMAGE: "asia-east1-docker.pkg.dev/aegis-assistant-488913/REPO/dota2-ai:ui-v2-off"
YAML
gcloud builds submit --config=/tmp/cb-ui-v2.yaml \
  --substitutions=_VITE_FF_UI_V2=0,_IMAGE=${IMAGE} \
  --project aegis-assistant-488913
```

然后 `gcloud run services update dota2-ai --region asia-east1 --image "$IMAGE"`。

### `GET /api/v1/config` 的 `flags.ui_v2` 与前端 flag 的关系

API 的 `flags.ui_v2` 读**服务端** env `UI_V2` 或 `FF_UI_V2`（`routes/v1/index.js`：
任一为 `1`/`true` → true；`0`/`false` → false；**默认 false**）。

**⚠️ API 只反映服务端配置；前端构建期 `VITE_FF_UI_V2` 仍可能不同。**
两者没有任何联动机制——运维切其中一边时必须**手工对齐**另一边，不能假设它们实时同步。
`/api/v1/config` 不是前端 UI 的开关来源（前端以构建期 flag 为准），它只是把服务端
rollout 状态暴露给监控/巡检对账用。

```bash
# 服务端侧对齐（两个别名都清掉，避免只改 UI_V2 时 FF_UI_V2=true 仍把 config 报成 true）：
gcloud run services update dota2-ai --region asia-east1 --project aegis-assistant-488913 \
  --update-env-vars UI_V2=false,FF_UI_V2=false
```

恢复 / roll forward：以默认构建（不传 `VITE_FF_UI_V2=0`）重新构建部署即可。

## ③ 流量回滚（上一修订）/ Traffic to the previous revision

**症状**：新修订整体不可用（启动失败、健康检查不过、数据库级回归），开关与重建都来不及。

直接使用根目录 **`QA.md`「回滚命令 / Rollback Command」小节的现成脚本**
（自动选出上一 Ready 修订 → 打 0% 标签探测健康 → `gcloud run services update-traffic
--to-revisions=PREV=100` → 探测线上），不在本文件复制粘贴，避免两份脚本漂移。

演练记录 / Drill log: **2026-10-16 dota2-ai-00075-d66 → 00074-vh2 → 00075-d66**
（`/api/health` 与 `/` 均 200，脚本探测与恢复命令全程通过）。

---

## 附：`/match/:id` → `/m/:id` 301 与 hash 路由

- 历史 path 链接 `GET /match/:id` 由服务端 **301** 到 `/m/:id` 并**原样保留 query**
  （`lib/matchPathRedirect.js`，挂在 static/SPA 之前）；非数字 id 不重定向，落回 SPA。
- 历史 **hash** 路由 `#/match/:id`、`#/m/:id`：hash 片段不会发送到服务器，因此本服务
  **不做** hash 301——由客户端 `LegacyHashRedirect`（`src/App.tsx`）在 `/` 上解析并
  `replace` 导航到 `/m/:id`（保留当前 `location.search`）。workspace 旧链 `/#training`
  仍进 `/legacy#training`。
