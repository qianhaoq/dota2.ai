<div align="center">

# ◆ dota2.ai

**A post-match Dota 2 coach that shows its evidence.**
**一位拿证据说话的 Dota 2 赛后教练。**

[dota2.ai](https://dota2.ai) · [Try a match](https://dota2.ai/r/9091400302) · [Use it from your agent](#use-it-from-your-agent) · [中文](#中文)

[![CI](https://github.com/qianhaoq/dota2.ai/actions/workflows/ci.yml/badge.svg)](https://github.com/qianhaoq/dota2.ai/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Patch 7.42](https://img.shields.io/badge/Dota%202-7.42-c23c2a.svg)](https://www.dota2.com/patches/7.42) [![good first issues](https://img.shields.io/github/issues/qianhaoq/dota2.ai/good%20first%20issue.svg?label=good%20first%20issues)](https://github.com/qianhaoq/dota2.ai/labels/good%20first%20issue)

</div>

---

Paste a match ID — or your Steam friend code to pick from your recent games. Pick the hero you played. You get **why the game went the way it did**: the gap split into causes (your lane, the fights, your build), each with the replay numbers behind it and **one thing to do next game** — then pro games that faced the same problem, a follow-up chat, and a goal that is checked on your next game.

```text
$ dota2ai coach 9091400302 --hero tidehunter --section why

#9091400302 · Dire victory 34–75 · 45:22 · 7.41 · parsed
Tidehunter · Pos 3 · offlane · 6/12/15 · loss

1. 9 lost fights started 19.3k behind on average  [you]
   - 9 of them were even or more on numbers: you lost on items and levels, not on heroes present.
   - Where: 7 in your half, 1 at the river, 1 in their half (from fight death positions)
   What to do: When you are 5k+ behind, do not take open 5v5 fights: defend under towers …
2. Your Blink Dagger came at 29:20; pros on Tidehunter have it by 25:00 in 61% of games  [you]
   - In 1390 pro games on Tidehunter, bought between 10:00 and 25:00: Blink Dagger 61%, …
   - Before it you finished: Mage Slayer 16:06, Consecrated Wraps 21:25
   - 5 fights lost after 10:00 before it; you were in 5, cast your ultimate in 3
   What to do: Next game, get Blink Dagger before Mage Slayer.
3. Top lane: Ursa, Hoodwink beat Tidehunter, Shadow Shaman, 724 gold by 10:00  [you]
   - Time in the enemy half, pregame to 10:00 (replay positions): Tidehunter 3% … vs Ursa 35% …
   - Their basic spell that hurt you most this game: Hoodwink's Acorn Shot 2.5k (cooldowns: Valve data, 7.42)
   What to do: step up to trade or last-hit right after Hoodwink's Acorn Shot (cooldown 19/16/13/10s)
               is used, and back off before it comes back …
```

## What it believes

1. **Teach judgment, don't play for you.** Post-match only. Nothing runs while you are in a game.
2. **Every claim has a receipt.** Each cause lists the numbers it rests on and says their scope — whole game or laning, which patch's data, how many pro games. No invented patch numbers, no win-rate promises.
3. **Say what you can't see.** Most matches are not parsed when you look at them. The coach still works on what the data supports, lists what is missing, and gives you a button to parse the rest.
4. **End in an action.** Every cause on you ends in one thing to do next game; a goal you set is judged on your next game.
5. **Agents are users too.** The page, the JSON API, the CLI, the agent skill and the MCP tools all read the same report.

## What the coach looks at

| | Unparsed match | Parsed match (replay data) |
|---|---|---|
| Why it went this way | — | the gap split into causes: each lane at 10:00, lost fights (numbers, gold deficit, who carried them, where, vision), your late core item |
| Lane | — | last hits, XP, deaths and rotations at 10:00; **where everyone stood** (position samples, heat map); the lane killer's spell to wait out, with **Valve's cooldowns** |
| Items | final build vs. the enemy's threat profile | + purchase timings; your hero's **pro-consensus mid-game item** (OpenDota pro matches, current patch) and what you built before it |
| Deaths | count vs. same-hero games | + caught alone vs. in a fight; converted into a tower or Roshan |
| Fights | — | every fight: result, presence, your ultimate (cast / on cooldown / held) |
| Pro cases | — | one pro game that avoided your problem, one that repeated it |
| Next game | the findings' actions | + a goal (deaths, lane, an item answer, wards…) checked on your next game |

Hero traits and item answers are a small, sourced table in [`lib/coach/knowledge.js`](lib/coach/knowledge.js); ability facts come from Valve's datafeed and pro item data from OpenDota, refreshed per patch into [`lib/coach/data/`](lib/coach/data).

**Limits, stated plainly.** OpenDota has positions only for the first 10 minutes (pregame included) and for team-fight deaths — so the coach never claims to know where you were caught outside a fight. Damage-by-spell totals are whole-game. Benchmarks are per hero, not per bracket. Pro cases show what went with winning, not proof of cause. A good report is a good set of questions — not a verdict.

## Use it from your agent

Everything the page shows is available to a script or a personal agent (Claude Code, Codex, any MCP client). No keys.

```bash
# from a checkout (Node ≥ 20.10, npm ci once)
node packages/cli/bin/dota2ai.js help
node packages/cli/bin/dota2ai.js recent <friend code | profile link>           # your recent games
node packages/cli/bin/dota2ai.js coach 9091400302 --hero tidehunter             # summary: the causes on you, what to practise
node packages/cli/bin/dota2ai.js coach 9091400302 --hero tidehunter --section why --json
node packages/cli/bin/dota2ai.js cases 9091400302 --hero tidehunter             # pro games on the same problem
node packages/cli/bin/dota2ai.js ask 9091400302 --hero tidehunter "Which death was the most avoidable?"
node packages/cli/bin/dota2ai.js goal set 9091400302 --hero tidehunter && node packages/cli/bin/dota2ai.js goal check
```

`--section`: `summary` · `why` · `lane` · `deaths` · `items` · `fights` · `plan` · `all`. Every command takes `--lang en|zh` and `--json`. Exit codes: `0` ok · `2` invalid input · `3` not found / no data yet · `4` upstream.

- **Skill** — [`packages/cli/skills/dota2ai-coach/SKILL.md`](packages/cli/skills/dota2ai-coach/SKILL.md) tells an agent when to call what, how to read the causes, and what never to invent. Claude Code: `cp -r packages/cli/skills/dota2ai-coach ~/.claude/skills/`, then ask *"review my last Dota game"*.
- **MCP (stdio)** — `claude mcp add dota2ai -- node /path/to/packages/mcp/bin/dota2ai-mcp.js`: tools `recent_matches`, `coach_report`, `coach_cases`, `coach_ask`, `goal_check`. See [packages/mcp](packages/mcp/README.md).
- **HTTP** — `GET /api/coach/:id` (schema `dota2.ai/coach-report@1`), `/api/coach/:id/cases?slot=`, `POST /api/coach/:id/ask` (SSE), `/api/coach/players/:friendCode/recent`. Summary for LLMs: [`/llms.txt`](https://dota2.ai/llms.txt).

The older Review v1 surface (`/api/v1/review/:id`, `dota2ai review`, `/mcp`) is still available.

## Run it

```bash
npm ci
cp .env.example .env        # the coach itself needs no keys
npm run start:dev           # Vite :5173 + Express :8080
```

Open <http://localhost:5173/r/9091400302>. `server.js` reads `process.env` only — export your variables or use a loader.

| Variable | Needed for |
|---|---|
| — | the coach (`/`, `/r/:id`, `/api/coach/*`) |
| `OPENDOTA_API_KEY` | optional, recommended in production: sent on every OpenDota request (paid limits). Keep it in Secret Manager, never in the image or plain env vars |
| `OPENDOTA_RPM` | optional; OpenDota requests per minute per instance (default 1200 with a key, 50 without) |
| `MATCH_CACHE_BUCKET` | optional; GCS bucket: parsed matches kept once for every instance + the shared OpenDota cooldown ([docs/MATCH_CACHE.md](docs/MATCH_CACHE.md)) |
| `STRATZ_API_TOKEN` | optional; STRATZ as a fallback when OpenDota fails (a basic, unparsed copy, labelled on the page) |
| `DEEPSEEK_API_KEY` | the "ask" follow-ups and the legacy LLM surfaces (`/legacy`, `/m/:id`); without it, answers come from the report |
| `GEMINI_API_KEY` | optional second model for follow-ups and legacy review cards |

Full list, rate-limit knobs and proxy settings: [`.env.example`](.env.example).

**OpenDota usage** goes through one client ([`lib/upstream/opendota.js`](lib/upstream/opendota.js)): key on every call, a token bucket that serves waiting pages first, merged duplicate requests, `Retry-After`, and a 429 cooldown shared by all instances. Hero, item and ability constants ship with the build (`node scripts/refresh-data.mjs --all` after a patch). Live counters: [`/api/health/upstream`](https://dota2.ai/api/health/upstream).

## Check it

```bash
npx tsc --noEmit && node --check server.js && npm run build && npm test   # what CI runs
npx vitest run src/utils/coachWhy.test.ts                                 # the "why" engine
npm run test:e2e                                                          # Playwright on a zero-outbound mock, incl. /r
node scripts/smoke-coach.mjs                                              # after a deploy: live API vs. live page
```

## How it is built

```
lib/coach/        analyze.js   pure report engine — no IO, no clock, no LLM
                  why.js       "why it went this way": causes, evidence, fixes
                  chapters.js  story, lane, deaths, items, fights, plan
                  goals.js     next-game goals and their checks (shared with the CLI)
                  cases.js     pro games on the same problem
                  knowledge.js curated threat tags and item answers
                  data/        names, Valve ability data, pro item shares — refreshed per patch
                  router.js    /api/coach/*, /r/:id link previews
lib/upstream/     the OpenDota client, the shared cooldown, the STRATZ fallback
lib/matchStore.js parsed matches in GCS
src/coach/        the web coach (home, report, player page)
packages/cli      dota2ai CLI + the agent skill
packages/mcp      MCP server (stdio + /mcp)
server.js         Express: static app, routes, wiring
```

The engine is deterministic: the same match data always produces the same report, so behaviour is pinned with real (anonymized) match fixtures in [`src/fixtures/coach/`](src/fixtures/coach).

## Deploy

Docker → Google Cloud Run. Keys come from Secret Manager (`--update-secrets`), never the image or `--set-env-vars`. The Express routes have no app-level auth — only per-IP limits — so put Cloud Run IAM, IAP or an API gateway in front of anything that spends money. Details and rollback: [`SECURITY.md`](SECURITY.md), [`docs/ROLLBACK.md`](docs/ROLLBACK.md).

## Contributing

**Know Dota? You can help without writing much code.** The coach's judgment lives in a small, sourced table — which heroes are magic burst, which items answer evasion — and every patch moves it. No API key needed: `npm ci && npx vitest run src/utils/coach`. Start with a [good first issue](https://github.com/qianhaoq/dota2.ai/labels/good%20first%20issue), or [tell us where a review got it wrong](https://github.com/qianhaoq/dota2.ai/issues/new?template=bad-review.yml).

One focused PR per change, evidence in the description (commands and output), and never weaken a test to get green. Gates and review severity: [`CONTRIBUTING.md`](CONTRIBUTING.md), [`docs/MERGE_GATES.md`](docs/MERGE_GATES.md). Only the owner's own PRs merge automatically; every other PR waits for the owner's review.

---

## 中文

**贴一场比赛，或者填你的 Steam 好友码从最近的比赛里选；再选你玩的英雄。** 你会看到**这局为什么会这样**：经济差拆成几条原因（你的对线、团战、出装），每条都附上录像里的数字和**下一局要做的一件事**；然后是遇到同样问题的职业对局、可以追问的教练、以及下一局自动检查的训练目标。

**它的原则**

1. **教判断，不替你打。** 只做赛后，游戏进行中什么都不运行。
2. **每条结论都有出处。** 每条原因都列出依据的数字，并写明口径：整局还是对线期、哪个版本的数据、多少场职业比赛。不编造版本数值，不承诺胜率。
3. **说清楚看不到什么。** 大多数比赛在你查看时还没被解析。教练照样给出数据撑得住的结论，列出缺失项，并提供一键解析。
4. **落到一个动作。** 和你有关的每条原因都以"下一局怎么做"结尾；设下的目标会在你下一局自动检查。
5. **Agent 也是用户。** 网页、JSON API、命令行、Agent skill 和 MCP 工具读的是同一份报告。

**它看什么**（已解析的比赛）：
- 对线：10 分钟补刀、经验、阵亡和游走；每个人**站在哪**（录像位置采样、热力图）；对线击杀者该等哪个技能放完再上（**Valve 官方冷却**）。
- 团战：输掉的团战开打时落后多少、谁打出来的、在哪打的、视野；每一波团你的大招是放了、在冷却，还是没放。
- 出装：购买时间；你这个英雄的**职业共识中期大件**（OpenDota 当前版本职业比赛统计）以及你在它之前做了什么。
- 职业对照：一场避开了你这个问题的职业比赛，一场重复了它的。
- 未解析的比赛也能看核心/辅助定位、终局装备与对方威胁的匹配、死亡与经济的同英雄分位。

**诚实的边界**：OpenDota 只提供开局前到 10 分钟的位置和团战里的死亡位置，所以教练从不声称知道你在团战外是在哪被抓的。按技能统计的伤害是整局数字。分位基准按英雄统计，不区分段位。职业案例说明的是"什么做法和胜负一起出现"，不证明因果。好的报告是一组好问题，而不是判决。

**给你的 Agent 用**（不需要任何 key）：

```bash
node packages/cli/bin/dota2ai.js recent <好友码或主页链接>
node packages/cli/bin/dota2ai.js coach 9091400302 --hero 潮汐猎人 --section why --lang zh
node packages/cli/bin/dota2ai.js goal set 9091400302 --hero 潮汐猎人 && node packages/cli/bin/dota2ai.js goal check
```

- Claude Code：`cp -r packages/cli/skills/dota2ai-coach ~/.claude/skills/`，然后说"复盘我上一局 Dota"。
- MCP：`claude mcp add dota2ai -- node /路径/packages/mcp/bin/dota2ai-mcp.js`。

本地运行：`npm ci && npm run start:dev`，打开 <http://localhost:5173/r/9091400302>。教练功能本身不需要任何 key；生产环境的 OpenDota key 放在 Secret Manager，以 secret 引用挂到 Cloud Run，不要写进镜像或普通环境变量。

---

MIT © 2026 dota2.ai contributors. A fan project, not affiliated with Valve. Dota 2 and its assets belong to Valve Corporation; match data comes from the public OpenDota API (STRATZ as a fallback). 粉丝项目，与 Valve 无关。
