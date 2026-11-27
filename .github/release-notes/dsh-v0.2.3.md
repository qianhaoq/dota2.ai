**dota2.ai for DSH v0.2.3**: a finished review now points to the DSH panel, where it is kept, instead of to a public page that does not have it. Tool descriptions match what the plugin does in DSH, a missing model is explained, and there is a quick start with troubleshooting. Verified with a real review on a real model in DSH 0.2.2-rc.5.

**dota2.ai DSH 插件 v0.2.3**：复盘完成后指向 DSH 面板（复盘就保存在那里），不再给出看不到这份复盘的公开链接。工具说明改成了插件在 DSH 里的实际行为，没配模型时会给出说明，并新增快速上手和常见问题。已在 DSH 0.2.2-rc.5 上用真实模型完成复盘验证。

### Changes / 变更

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
