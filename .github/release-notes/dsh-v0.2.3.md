**dota2.ai for DSH v0.2.3**: the first release that installs on the current DSH (`0.2.2-rc.5`, npm `latest`). It includes everything planned for v0.2.2, which was never published because its release check failed on DSH 0.2.2. A finished review now points to the DSH panel, which has it, instead of to a public page.

**dota2.ai DSH 插件 v0.2.3**：第一个能装在当前 DSH（`0.2.2-rc.5`，即 npm 的 `latest`）上的版本。它包含原计划在 v0.2.2 里的全部内容（v0.2.2 的发布校验在 DSH 0.2.2 上失败，没有发出去）。复盘完成后指向 DSH 面板，不再给出看不到这份复盘的公开链接。

### From v0.2.2 (never published) / 来自 v0.2.2（未发布）

- **Public npm publication (`@qianhaoq/dsh-dota2ai`)**: published to npm with provenance so `dsh plugin --profile web add @qianhaoq/dsh-dota2ai`, `dsh-market`, and DSH `0.2.1+` `Plugins -> Discover` (`dsh-plugin-catalog`) can install and track updates directly. / 同步发布至公开 npm（含 provenance 签名与国内镜像同步），支持一行命令直接安装、`dsh-market` 收录及 DSH 原生发现页检索更新。
- **DSH `0.2.x` host compatibility (`engines.dsh` & `peerDependencies`)**: widened `engines.dsh` (`>=0.2.1-rc.3 <0.3.0-0`) and explicit prerelease `peerDependencies` branches so DSH `0.2.1-rc.3+` and `0.2.2-rc.5` (`latest`) pass `evaluatePluginCompatibility` without manual version exemptions. / 扩展 `engines.dsh` 与预发布 `peerDependencies` 范围，同时兼容 DSH `0.2.1-rc.3+` 与最新 `0.2.2-rc.5`。
- **Storefront metadata & icon**: added `dsh.manifestVersion: 1`, `icon`, `homepage`, `keywords`, and `packages/dsh/assets/icon-180.png` for DSH's Installed Plugins view and `dsh-market` cards. / 补充 `manifestVersion`、`icon`、`keywords` 及 180×180 位图图标。

### New in v0.2.3 / 本版新增

- **Release check fixed on DSH 0.2.2**: `installed-smoke` now loads DSH 0.2.2's tool executor (`@deepseek-ai/dsh-tool-executor-native`) and uses its batched `tools.execute`. The v0.2.2 release stopped here with `ToolExecutorUnavailableError`. / 修复发布校验在 DSH 0.2.2 上的 `ToolExecutorUnavailableError`。
- **Where to read the review**: when `dota2ai_replay_review` finishes, it returns `panel_route`, the review's route in the dota2.ai panel, and no longer returns the public `https://dota2.ai/r/…` URL. The review was written by your model and is kept on your machine, so the public page does not have it. / 复盘完成后返回 DSH 面板路由，不再给公开链接。
- **Tool descriptions**: `dota2ai_replay_review` and `dota2ai_coach_ask` now describe what the plugin does in DSH. They no longer mention the hosted per-caller limits, and they say that follow-ups are answered from the replay. / 工具说明不再提网站的限额，并写明追问会依据录像回答。
- **No model set up**: inside DSH, the review page now says how to add a DeepSeek key and pick a model. It used to say "the coach is not available". / 没配模型时说明怎么填 Key、选模型。
- **Removed** the unused hosted-MCP replay client (`src/replay.js`). / 删除不再使用的远程 MCP 复盘客户端。
- **Live check**: `scripts/live-review.mjs` runs a real review with a real model through a real `dsh web`. It passed on DSH 0.2.2-rc.5 with DeepSeek (match 9100904020: 21 tool calls, 3 findings, nothing removed by the fact check, rendered in the panel). / 真实模型 + 真实 `dsh web` 端到端验证通过。

**Install / 安装** (Node ≥ 24.9, DSH 0.2.x ≥ 0.2.1-rc.3):

```sh
npm install -g pnpm @deepseek-ai/dsh@0.2.2-rc.5
curl -LO https://github.com/qianhaoq/dota2.ai/releases/download/dsh-v0.2.3/qianhaoq-dsh-dota2ai-0.2.3.tgz
curl -LO https://github.com/qianhaoq/dota2.ai/releases/download/dsh-v0.2.3/SHA256SUMS
sha256sum -c SHA256SUMS
dsh plugin --profile web add ./qianhaoq-dsh-dota2ai-0.2.3.tgz
DEEPSEEK_API_KEY=sk-... dsh web      # or enter the key in DSH's API-key dialog
```
