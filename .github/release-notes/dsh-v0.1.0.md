The first release of **dota2.ai for DSH** (DeepSeek Harness): the evidence-first Dota 2 coach as agent tools and a skill in your DSH sessions.

首个 DSH 插件版本：在 DSH 会话里直接使用 dota2.ai 的复盘与教练工具。

**Install / 安装** (Node ≥ 24.9, DSH 0.2.1-rc.3):

```sh
sha256sum -c SHA256SUMS
dsh plugin --profile web add ./qianhaoq-dsh-dota2ai-0.1.0.tgz
```

**Tools / 工具**

- `dota2ai_replay_review`: the replay review, with every time and number checked against the replay; polls while the replay is parsed (2–4 min)
- `dota2ai_recent_matches`, `dota2ai_coach_report` (`summary` · `why` · `lane` · `deaths` · `items` · `fights` · `plan` · `all`), `dota2ai_coach_cases`, `dota2ai_coach_ask`, `dota2ai_goal_check`, `dota2ai_hero_matchup`
- the `dota2ai` skill: how to read the results, when to ask which hero the user played, what never to claim

No keys: the tools call the public dota2.ai API as you. One archive for every platform (no native code). Works next to the DSH Dota coach plugin (`dota_*` tools).

无需密钥；同一个包适用于所有平台；可与 DSH Dota 教练插件（`dota_*`）同时安装。
