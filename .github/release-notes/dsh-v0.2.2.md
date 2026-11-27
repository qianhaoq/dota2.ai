**dota2.ai for DSH v0.2.2** — public npm package (`@qianhaoq/dsh-dota2ai`), DSH `0.2.1`–`0.2.x` compatibility range, and `dsh-market` / DSH `Discover` metadata.

**dota2.ai DSH 插件 v0.2.2**——同步发布公开 npm 包 `@qianhaoq/dsh-dota2ai`，支持 `dsh-market` 与 DSH 原生「发现（Discover）」索引及一键更新检测，并覆盖 DSH `0.2.1-rc.3` 至 `0.2.2+` 宿主兼容范围。

### Changes / 更新项

- **Public npm publication (`@qianhaoq/dsh-dota2ai`)**: published to npm with provenance so `dsh plugin --profile web add @qianhaoq/dsh-dota2ai`, `dsh-market`, and DSH `0.2.1+` `Plugins -> Discover` (`dsh-plugin-catalog`) can install and track updates directly. / 同步发布至公开 npm（含 provenance 签名与国内镜像同步），支持一行命令直接安装、`dsh-market` 收录及 DSH 原生发现页检索更新。
- **DSH `0.2.x` host compatibility (`engines.dsh` & `peerDependencies`)**: widened `engines.dsh` (`>=0.2.1-rc.3 <0.3.0-0`) and explicit prerelease `peerDependencies` branches so DSH `0.2.1-rc.3+` and `0.2.2-rc.5` (`latest`) pass `evaluatePluginCompatibility` without manual version exemptions. / 扩展 `engines.dsh` 与预发布 `peerDependencies` 范围，同时兼容 DSH `0.2.1-rc.3+` 与最新 `0.2.2-rc.5`。
- **Storefront metadata & icon**: added `dsh.manifestVersion: 1`, `icon`, `homepage`, `keywords`, and `packages/dsh/assets/icon-180.png` for DSH's Installed Plugins view and `dsh-market` cards. / 补充 `manifestVersion`、`icon`、`keywords` 及 180×180 位图图标。

**Install / 安装** (Node ≥ 24.9, DSH ≥ 0.2.1-rc.3):

```sh
# From npm (recommended) / 从 npm 直接安装（推荐）：
dsh plugin --profile web add @qianhaoq/dsh-dota2ai

# Or from the GitHub Release archive / 或使用离线归档：
sha256sum -c SHA256SUMS
dsh plugin --profile web add ./qianhaoq-dsh-dota2ai-0.2.2.tgz
```
