## 变更说明 | What Changed

<!-- 简要描述改动内容 / Brief description of changes -->

## 为什么 | Why

<!-- 为什么需要这个改动 / Reason for the change -->

## 风险评估 | Risk Assessment

- [ ] UI/流式展示 | UI/Streaming display
- [ ] API 调用 | API calls  
- [ ] 部署相关 | Deployment
- [ ] 无高风险 | Low risk

## 测试情况 | How Tested

<!-- 必填：跑了什么测试 + 关键输出；口头 done 不算。勾选不够，须贴命令与摘要。 -->

```text
# command
# key output
```

- [ ] 改了复盘提示词版本或工具输出时：已贴 `node scripts/eval-review.mjs <dir> --baseline data/eval-baseline.v1.json` 的对比 | Changed the review prompt version or a tool's output: eval-review comparison pasted
- [ ] 改了 `packages/review-engine/src/trace/build.js`、`lib/agent/traceBuild.js`、`lib/agent/tracePipeline.js` 或 `scripts/trace-worker.mjs` 时：合并后须手动重建并部署 `trace-worker`（合并到 `main` 不会自动部署它，见 `docs/AGENT_PIPELINE.md`） | Touched trace builder / worker files: rebuild & deploy `trace-worker` after merge
- [ ] CI 通过 | CI passes
- [ ] 本地测试 | Local testing
- [ ] dota2.ai 线上验证 | Verified on dota2.ai

## AI 辅助 | Agent Note

- [ ] Cursor / Copilot / 其他 AI 参与开发或审查
- [ ] 已人工 review AI 生成的代码

---

### 给 Reviewer 的提示 | Reviewer Hints

<!-- 特别需要关注的地方 / Areas needing extra attention -->
