# QA 验收单 / QA Sign-off Checklist

> 用法 / Usage: 复制本模板到 PR 描述或 issue，逐项勾选后，在**最新 head commit** 上完成验证，
> 再给 PR 打 `qa-passed` 标签。新的 push 会自动移除该标签，必须重新走一遍本单。
> Copy this template into the PR description or an issue, check every item
> against the **latest head commit**, then apply the `qa-passed` label.
> Any new push removes the label automatically — redo this checklist.

PR: #___
被验收的 head commit / Verified head commit: `<COMMIT_SHA>`
验收人 / Reviewer: @___
日期 / Date: ___

## 测试点 / Test Points

- [ ] 核心用户路径可用 / Main user path works end to end
- [ ] 本 PR 变更的行为按预期生效 / Behavior changed in this PR matches expectations
- [ ] 回归：相邻功能未被破坏 / Regression: adjacent features unbroken
- [ ] 错误与边界情况（空输入、无效输入、网络失败）/ Errors and edge cases (empty input, invalid input, network failure)
- [ ] 权限与可见性正确 / Permissions and visibility are correct
- [ ] 移动端 / 小屏表现正常（如适用）/ Mobile or narrow viewport looks right (if applicable)
- [ ] 控制台无新增错误、警告 / No new console errors or warnings

## 黄金样例 / Golden Samples

> 用真实输入/输出对固定行为，防止悄悄漂移。
> Use real input/output pairs to pin behavior against silent drift.

| # | 场景 Scenario | 输入 Input | 期望输出 Expected output | 实际 Actual | 通过 Pass |
| --- | --- | --- | --- | --- | --- |
| 1 |  |  |  |  | ☐ |
| 2 |  |  |  |  | ☐ |
| 3 |  |  |  |  | ☐ |

## 回滚命令 / Rollback Command

> 上线出问题时第一时间执行的命令（部署回退、功能开关、数据修复）。
> The first command to run when the release goes wrong (deploy revert,
> feature flag, data repair).

```bash
# 自动选出“当前 100% 流量修订之前的最近一个 Ready 修订”并切回；任何一步失败即停止。
# Auto-pick the previous Ready revision before the one serving 100%; stop on any failure.
set -euo pipefail
SVC=dota2-ai; REGION=asia-east1; PROJECT=aegis-assistant-488913
G="--region $REGION --project $PROJECT"
CUR=$(gcloud run services describe $SVC $G \
  --format=json | python3 -c 'import json,sys; t=[x for x in json.load(sys.stdin)["status"]["traffic"] if x.get("percent")==100 and x.get("revisionName")]; print(t[0]["revisionName"] if len(t)==1 else "")')
[ -n "$CUR" ] || { echo "traffic is split/tagged; no single 100% revision — roll back manually"; exit 1; }
PREV=$(gcloud run revisions list --service $SVC $G \
  --filter='status.conditions[0].status=True' --sort-by='~metadata.creationTimestamp' \
  --format='value(metadata.name)' | grep -A1 -x "$CUR" | tail -n1)
[ -n "$PREV" ] && [ "$PREV" != "$CUR" ] || { echo "no previous ready revision"; exit 1; }
# 上一修订必须带三个 Secret Manager 绑定 / PREV must bind all three secrets
SECRETS=$(gcloud run revisions describe "$PREV" $G --format=json | python3 -c 'import json,sys; c=json.load(sys.stdin)["spec"]["containers"][0]; print(" ".join(sorted(e["name"] for e in c.get("env",[]) if "valueFrom" in e)))')
[ "$SECRETS" = "DEEPSEEK_API_KEY GEMINI_API_KEY STEAM_WEB_API_KEY" ] || { echo "$PREV lacks secret bindings; use dota2-ai-00072-sls or newer"; exit 1; }
echo "rollback $CUR -> $PREV"
gcloud run services update-traffic $SVC $G --to-revisions="$PREV=100"
# /api/health 总是 200，需检查 body 中 apiKeyConfigured / health always 200: check the body
curl -fsS -m 30 https://dota2.ai/api/health | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("status")=="healthy" and d.get("apiKeyConfigured") is True, d.get("status"); print("health ok")'
# 恢复到原修订（不要用 --to-latest，以免覆盖有意固定的修订）/ Restore the original pin, not --to-latest:
# gcloud run services update-traffic $SVC $G --to-revisions="$CUR=100"
```

> 脚本会校验上一修订带 `deepseek-api-key` / `gemini-api-key` / `steam-web-api-key` 绑定（00072 及之后），否则中止。
> The script aborts unless the previous revision binds all three secrets (00072+).

演练记录 / Drill log: 2026-10-16 dota2-ai-00075-d66 → 00074-vh2 → 00075-d66，/api/health 与 / 均 200。

## 签署 / Sign-off

- [ ] 我在上述 head commit 上完成了全部测试点与黄金样例 / I verified all test points and golden samples on the head commit above
- [x] 回滚命令已演练或在预发验证过 / The rollback command was rehearsed or verified in staging
- [ ] 现在给 PR 打 `qa-passed` 标签 / Apply the `qa-passed` label to the PR now

> 注意 / Note: 打标签时间必须晚于最后一次 push —— 否则 QA Gate 会以
> "label predates the latest push" 拒绝。push 新提交后标签被自动移除，
> 需重新验收并再次打标。
> The label must be applied AFTER the last push — otherwise the QA Gate
> rejects with "label predates the latest push". A new push removes the
> label; re-verify and re-apply it.
