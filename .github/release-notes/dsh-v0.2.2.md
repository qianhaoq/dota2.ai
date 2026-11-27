**dota2.ai for DSH v0.2.2** — public npm package (`@qianhaoq/dsh-dota2ai`), DSH `0.2.1`–`0.2.x` compatibility range, panel routing for finished reviews, and DSH-native tool descriptions & setup guidance.

**dota2.ai DSH 插件 v0.2.2**——同步发布公开 npm 包 `@qianhaoq/dsh-dota2ai`，覆盖 DSH `0.2.1-rc.3` 至 `0.2.x` 宿主兼容范围，复盘完成后直接指向 DSH 面板，并优化插件内模型配置引导与工具说明。

### Changes / 更新项

- **Public npm publication (`@qianhaoq/dsh-dota2ai`)**: published to npm with provenance so `dsh plugin --profile web add @qianhaoq/dsh-dota2ai`, `dsh-market`, and DSH `0.2.1+` `Plugins -> Discover` (`dsh-plugin-catalog`) can install and track updates directly. / 同步发布至公开 npm（含 provenance 签名与国内镜像同步），支持一行命令直接安装、`dsh-market` 收录及 DSH 原生发现页检索更新。
- **DSH `0.2.x` host compatibility (`engines.dsh` & `peerDependencies`)**: widened `engines.dsh` (`>=0.2.1-rc.3 <0.3.0-0`) and explicit prerelease `peerDependencies` branches so DSH `0.2.1-rc.3+` and `0.2.2-rc.5` (`latest`) pass `evaluatePluginCompatibility` without manual exemptions; `installed-smoke.mjs` handles DSH 0.2.2's batched tool executor. / 扩展 `engines.dsh` 与预发布 `peerDependencies` 范围，兼容 DSH `0.2.1-rc.3+` 与最新 `0.2.2-rc.5`，冒烟脚本适配 0.2.2 批量工具执行器。
- **Where to read the review**: when `dota2ai_replay_review` finishes, it returns `panel_route` (the route in the DSH panel) and no longer returns a public `https://dota2.ai/r/…` URL that does not have your local review. / 复盘完成后返回 `panel_route`（DSH 面板路由），不再返回看不到本地复盘的公开链接。
- **DSH-native tool descriptions & no-model guidance**: `dota2ai_replay_review` and `dota2ai_coach_ask` drop hosted per-caller limits and note replay-backed follow-ups; inside DSH with no model configured, the page explains how to add a DeepSeek key and pick a model. / 工具说明改为 DSH 本地行为；未配置模型时页面给出填写 DeepSeek Key 与选模型的清晰指引。
- **Storefront metadata, cleanup & live check**: added `dsh.manifestVersion: 1`, `icon`, `homepage`, `keywords`, `packages/dsh/assets/icon-180.png`, and `scripts/live-review.mjs`; removed unused `src/replay.js`. / 补充商店元数据与 180×180 图标、新增真实模型 `dsh web` 端到端脚本、清理未使用的 `src/replay.js`。

**Install / 安装** (Node ≥ 24.9, DSH ≥ 0.2.1-rc.3):

```sh
# From npm (recommended) / 从 npm 直接安装（推荐）：
npm install -g pnpm @deepseek-ai/dsh@0.2.2-rc.5
dsh plugin --profile web add @qianhaoq/dsh-dota2ai
DEEPSEEK_API_KEY=sk-... dsh web

# Or from the GitHub Release archive / 或使用离线归档：
curl -LO https://github.com/qianhaoq/dota2.ai/releases/download/dsh-v0.2.2/qianhaoq-dsh-dota2ai-0.2.2.tgz
curl -LO https://github.com/qianhaoq/dota2.ai/releases/download/dsh-v0.2.2/SHA256SUMS
sha256sum -c SHA256SUMS
dsh plugin --profile web add ./qianhaoq-dsh-dota2ai-0.2.2.tgz
DEEPSEEK_API_KEY=sk-... dsh web
```
