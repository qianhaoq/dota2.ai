**dota2.ai for DSH v0.2.1** — startup fix for DSH `0.2.1-rc.3` Typert loader validation and manifest registration, plus real `dsh web` + RPC release gates.

**dota2.ai DSH 插件 v0.2.1**——修复 DSH `0.2.1-rc.3` 启动时的 Typert 清单校验与重复注册缺陷，并将真实 `dsh web` 启动及认证 RPC 校验纳入默认发布门禁。

### Fixes / 修复项

- **Typert service manifest schema (`DSH-01`)**: added `types: []` to the `dota2ai` service entry in `packages/dsh/src/typert.js` so `@deepseek-ai/dsh-typert-loader`'s `validateTypertManifest()` accepts `./typert` on startup. / 在 `packages/dsh/src/typert.js` 的 `dota2ai` 服务元数据中补齐 `types: []`，通过宿主 `validateTypertManifest()` 校验。
- **Single Typert manifest owner (`DSH-02`)**: removed manual `scope.typert.register(TYPERT)` from `packages/dsh/src/index.js` so DSH's `typert-loader` solely manages `./typert` registration in GUI profiles (`dsh web` / Desktop) without `package face "@qianhaoq/dsh-dota2ai#host" is already registered` collisions, while headless CLI profiles keep all 7 `dota2ai_*` tools and the `dota2ai` skill active. / 移除插件手工调用 `typert.register(TYPERT)`，统一由宿主 `typert-loader` 加载 `./typert`，消除启动重复注册异常。
- **Default real-profile & RPC release gate (`TEST-01`)**: `packages/dsh/scripts/installed-smoke.mjs` now validates `./typert` with DSH's real `validateTypertManifest()`, boots `dsh web --no-open --host 127.0.0.1 --port 0` in a clean `DSH_HOME` by default, asserts zero loader/activation errors, verifies authenticated `dota2ai/getProfile` and `dota2ai/request` (`/api/patch`) RPCs, and tests plugin unmount/remount recovery. / 默认发布验收新增真实 `validateTypertManifest()`、`dsh web --port 0` 完整启动日志检查、认证后真实 RPC 验收以及卸载重装恢复测试。

**Install / 安装** (Node ≥ 24.9, DSH 0.2.1-rc.3):

```sh
sha256sum -c SHA256SUMS
dsh plugin --profile web add ./qianhaoq-dsh-dota2ai-0.2.1.tgz
dsh web
```
