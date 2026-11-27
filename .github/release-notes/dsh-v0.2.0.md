**dota2.ai for DSH v0.2.0** — full standalone `dota2.ai` page inside DSH, powered by your DSH host models.

**dota2.ai DSH 插件 v0.2.0**——完整复刻独立复盘页面，全面接入 DSH 宿主模型。

### Highlights / 核心升级

- **Standalone `dota2.ai` sidebar page / 左侧栏独立完整页面**: replicates the home page, recent games, patch advisor, and the full match review page (10-player scoreboard, checked replay evidence cards, 10-hero minimap moment replay, coach chat rail, and next-game goal tracking) inside `dsh web` and Desktop.
- **Powered by DSH host models (`ctx.llm`) / 使用 DSH 宿主模型**: deep replay investigations (`verifyReview`), replay-backed follow-up chat (`verifyText`), and the patch advisor run locally on your configured DSH models — defaulting to your current DSH selection, with an in-page model switcher to compare models on the same match.
- **250 KB cloud trace cache + optional local extractor / 轻量录像轨迹缓存**：fetches ~250 KB `.trace.json.gz` into `$DSH_HOME/dota2ai` (zero server LLM usage, with Steam GC discovery for just-finished games) and supports optional local `extractorBin`.
- **Chat ↔ Page bridge / 会话与页面双向打通**：clickable tool cards in DSH sessions jump straight to the match review page, and reviews can be sent back into a DSH chat session in one click.

**Install / 安装** (Node ≥ 24.9, DSH 0.2.1-rc.3):

```sh
sha256sum -c SHA256SUMS
dsh plugin --profile web add ./qianhaoq-dsh-dota2ai-0.2.0.tgz
dsh web
```
