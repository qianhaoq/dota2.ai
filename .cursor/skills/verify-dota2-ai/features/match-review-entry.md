# 赛后复盘入口

赛后复盘 lets a user open the review workspace, read the framing copy, and reach the match-id intake. Starting analysis (`开始复盘`) is a later step that hits OpenDota and, for the stream, DeepSeek.

## Sub-features

- `review-tab` opens 复盘 from the tactical-room tablist.
- `review-motive` opens the same workspace from 刚打完，复盘一局.
- `review-framing` shows `先还原你当时掌握的信息。` and the intake titled `复盘一局`.
- `review-intake` reveals the match field and `拉取比赛` without calling analysis.
- `review-no-sse` stops before `开始复盘` unless `/api/health.apiKeyConfigured` is true and a real match id is in scope.

## How to get to it (user POV)

- On 战术室 landing, choose `刚打完，复盘一局`.
- On 战术室, choose tab `复盘` (`role=tablist` `战术室工作区`).
- After a language toggle, the English tab reads `Review` and the title reads `Reconstruct what you knew at the time.`

## Driving it with verify-dota2-ai

Preconditions:

- Doctor reports `ok: true`.
- Language is 中文.
- DeepSeek is **not** required for this file. Do not POST `/api/review/:id` here.

- **Tab entry.** From the landing, choose `复盘`. Run `verify-dota2-ai drive match-review-entry` (the helper clicks `role=tab` name `复盘`). The kicker `TACTICAL REVIEW / 赛后复盘` and heading `先还原你当时掌握的信息。` appear.
- **Intake.** `复盘一局` is visible. If the form is collapsed, choose that button. The field placeholder is `8985182860 或 opendota.com/matches/...` and the submit label is `拉取比赛`.
- **Invalid id (optional).** Type `abc`. The page shows `请输入有效的比赛 ID 或链接`. Clear the field before leaving.
- **Stop.** Do not choose `拉取比赛` or `开始复盘` in the default recipe. Those call OpenDota and then DeepSeek.
- **Proof.** `after.png` + `page.txt` show the review heading and `复盘一局`. `meta.json` records that analysis was not started.

## Gotchas

- Opening 复盘 sets the shared coach lesson to `review` but does **not** start a stream. A spinner or token stream here is a failure.
- `拉取比赛` needs a public OpenDota match, not DeepSeek. Still skip it in the default proof so a flaky third-party API cannot fail this entry feature.
- Fixture `src/fixtures/match8985182860.json` is unit-test data. Typing `8985182860` still hits the live `/api/review/:id` GET.
- After a successful fetch the CTA becomes `开始复盘` and a hero roster appears. That is outside this feature unless you are explicitly proving intake-with-facts.
- Without `DEEPSEEK_API_KEY`, `开始复盘` surfaces `DeepSeek API Key 未配置`. That is an honest server branch, not a passing review.
