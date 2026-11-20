<div align="center">

# ◆ dota2.ai

**A post-match Dota 2 coach that shows its evidence.**
**一位拿证据说话的 Dota 2 赛后教练。**

[dota2.ai](https://dota2.ai) · [Try a match](https://dota2.ai/r/9091400302) · [API](#for-agents-and-scripts) · [中文](#中文)

</div>

---

Paste a match ID. Pick the hero you played. You get the two or three things most worth fixing — each one ending in a concrete next-game action, backed by the numbers it rests on, and honest about what the data cannot show.

```text
$ node packages/cli/bin/dota2ai.js coach 9091400302 --hero spectre

#9091400302 · Dire victory 34–75 · 45:22 · 7.41 · not parsed
Spectre · Core · 12/15/9 · loss

Biggest lever: no item answer to their magic burst.

1. ! No item answer to their magic burst
   What to do: Next game against Skywrath Mage, Hoodwink: make Black King Bar your next big
               item after your core item, and have it before the first big fight.
   Skywrath Mage, Hoodwink brought magic burst. You finished with nothing that answers it —
   the usual tools for a core are Black King Bar, Pipe of Insight, Eternal Shroud, Mage Slayer.
   You also died more than most Spectre players (15 deaths).
   - Your final items: Orchid Malevolence, Manta Style, Phase Boots, Oblivion Staff, Urn of Shadows, …
   (Final inventory only: we cannot see what you sold or when you bought it until the match is parsed.)
```

## What it believes

1. **Teach judgment, don't play for you.** Post-match and pre-match only. Nothing runs while you are in a game.
2. **Every claim has a receipt.** Findings link to the stats behind them. No invented patch numbers, no win-rate promises.
3. **Say what you can't see.** Most matches are not parsed when you look at them. The coach still works — on what the data supports — lists what is missing, and gives you a button to parse the rest.
4. **Tell, with receipts.** Each finding ends in one thing to do next game, with pro games on similar heroes that did it — and didn't.
5. **Agents are users too.** The web page, the JSON API and the CLI render the same report.

## What the coach looks at

| | Unparsed match | Parsed match |
|---|---|---|
| Seat | core / support from farm | position 1–5 from lanes |
| Items | final build vs. the enemy's threat profile (magic burst, chain disables, silences, physical carries, evasion, illusions, healing, invisibility) | + purchase timings |
| Deaths | count vs. same-hero games | + caught alone vs. in a fight, and whether the enemy converted it into a tower or Roshan |
| Farm & impact | GPM, last hits, hero and tower damage vs. same-hero benchmarks | + lane result at 10:00 vs. your lane opponent |
| Team | did anyone answer their snowballing hero? | + the 3-minute window where the game turned |
| Vision | — | wards, sentries, dust vs. invisible heroes |

Thresholds are conservative on purpose: an item gap is only raised when it plausibly cost you (you also died more than the median player of your hero). Hero traits and item answers are a small, curated table in [`lib/coach/knowledge.js`](lib/coach/knowledge.js), validated against Valve's localized item and hero names.

**Limits, stated plainly.** Public match data has no per-moment positions or vision, so the coach never claims to know where you stood or what you saw. Benchmarks are per hero, not per bracket or role. A good report is a good set of questions — not a verdict.

## For agents and scripts

```bash
# JSON — the same report the page renders (schema: dota2.ai/coach-report@1)
curl https://dota2.ai/api/coach/9091400302
curl 'https://dota2.ai/api/coach/9091400302?slot=4&pos=1'    # override one seat's position

# Terminal (from a checkout, Node ≥ 20.10)
node packages/cli/bin/dota2ai.js coach 9091400302                       # list heroes
node packages/cli/bin/dota2ai.js coach 9091400302 --hero spectre --lang zh
node packages/cli/bin/dota2ai.js coach 9091400302 --hero 67 --json
```

Exit codes: `0` ok · `2` invalid input · `3` match or data missing · `4` upstream failure. `DOTA2AI_API_BASE` points the CLI at another origin.

The older Review v1 surface is still available: `/api/v1/review/:id`, `dota2ai review`, and an MCP server (`/mcp`, or `node packages/mcp/bin/dota2ai-mcp.js` over stdio). See [packages/cli](packages/cli/README.md) and [packages/mcp](packages/mcp/README.md).

## Run it

```bash
npm ci
cp .env.example .env        # the coach itself needs no keys
npm run start:dev           # Vite :5173 + Express :8080
```

Open <http://localhost:5173/r/9091400302>. `server.js` reads `process.env` only — export your variables or use a loader.

| Variable | Needed for |
|---|---|
| — | the coach (`/`, `/r/:id`, `/api/coach/:id`) |
| `OPENDOTA_API_KEY` | optional; parse requests |
| `DEEPSEEK_API_KEY` | legacy LLM surfaces (`/legacy`, `/m/:id`, chat, playbook) |
| `GEMINI_API_KEY` | optional fallback for legacy review cards |
| `STEAM_WEB_API_KEY` | optional localized hero names in legacy tools |

Full list, rate-limit knobs and proxy settings: [`.env.example`](.env.example).

## Check it

```bash
npx tsc --noEmit && node --check server.js && npm run build && npm test   # what CI runs
npx vitest run src/utils/coachReport.test.ts                              # just the coach
npm run test:e2e                                                          # Playwright, zero-outbound mock
```

## How it is built

```
lib/coach/            analyze.js   pure report engine — no IO, no clock, no LLM
                      knowledge.js curated threat tags and item answers
                      router.js    GET /api/coach/:matchId
                      data/        names snapshot (Valve datafeed + OpenDota constants); refresh after a patch with `node scripts/coach-names.mjs <patch>`
src/coach/            the web coach (home + report)
packages/cli          dota2ai coach | review
server.js             Express: static app, coach route, legacy /api/* routes
lib/matchReview/      shared infra: OpenDota match cache, parse-request budget
packages/review-engine, packages/mcp, src/v2, src/components   Review v1, MCP, legacy UIs
```

The engine is deterministic: the same OpenDota payload always produces the same report, so behaviour is pinned with real (anonymized) match fixtures in [`src/fixtures/coach/`](src/fixtures/coach).

## Deploy

Docker → Google Cloud Run. Keys come from Secret Manager (`--update-secrets`), never the image. The Express routes have no app-level auth — only per-IP limits — so put Cloud Run IAM, IAP or an API gateway in front of anything that spends money. Details and rollback: [`SECURITY.md`](SECURITY.md), [`docs/ROLLBACK.md`](docs/ROLLBACK.md).

## Contributing

One focused PR per change, evidence in the description (commands and output), and never weaken a test to get green. Gates and review severity: [`CONTRIBUTING.md`](CONTRIBUTING.md), [`docs/MERGE_GATES.md`](docs/MERGE_GATES.md).

---

## 中文

**贴一场比赛，选你玩的英雄，得到最值得改的两三件事。** 每一条都落到下一局要做的一件事，附上它依据的数据，并且老实说明数据看不到什么。

**它的原则**

1. **教判断，不替你打。** 只做赛前赛后，游戏进行中什么都不运行。
2. **每条结论都有出处。** 不编造版本数值，不承诺胜率。
3. **说清楚看不到什么。** 大多数比赛在你查看时还没被解析。教练照样给出数据撑得住的结论，列出缺失项，并提供一键解析。
4. **直接说怎么做，并给出处。** 每条发现都落到下一局要做的一件事，附相似英雄职业对局的正例和反例。
5. **Agent 也是用户。** 网页、JSON API 和命令行输出的是同一份报告。

**它看什么**：未解析时看位置（核心/辅助）、终局装备与对方威胁的匹配、死亡与经济相对同英雄对局的分位、全队有没有人针对对方滚起来的英雄；解析后再加 1–5 号位、10 分钟对线、死亡分类（被抓 / 团战 / 被转化成目标）、比赛转折的三分钟、视野与反隐、关键装备时间。

**诚实的边界**：公开比赛数据没有逐时刻坐标和视野，所以教练从不声称知道你站在哪、看到了什么。分位基准按英雄统计，不区分段位和位置。好的报告是一组好问题，而不是判决。

```bash
curl https://dota2.ai/api/coach/9091400302
node packages/cli/bin/dota2ai.js coach 9091400302 --hero 幽鬼 --lang zh
```

本地运行：`npm ci && npm run start:dev`，打开 <http://localhost:5173/r/9091400302>。教练功能不需要任何 API key。

---

MIT © 2026 dota2.ai contributors. A fan project, not affiliated with Valve. Dota 2 and its assets belong to Valve Corporation; match data comes from the public OpenDota API. 粉丝项目，与 Valve 无关。
