# dota2.ai for DSH

[简体中文](#简体中文)

A native [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) (DeepSeek Harness) plugin that brings the full
[dota2.ai](https://dota2.ai) experience into DSH:

- **Standalone `dota2.ai` page in the DSH sidebar**: home, recent games, patch advisor, and the full replay review page (10-player scoreboard, clickable replay evidence cards, 10-hero minimap moment replay, coach chat rail, and next-game habit tracking).
- **Powered by your DSH host models (`ctx.llm`)**: deep replay investigations (`runDeepReview` + `verifyReview`), follow-up chat (`runChat` + `verifyText`) and the patch advisor all run locally using the models you configured in DSH — defaulting to your selected DSH model, with an in-page switcher to compare any model in your DSH profile on the same match.
- **Session tools, skill & clickable chat cards**: seven `dota2ai_*` tools and a `dota2ai` skill sharing the same local `$DSH_HOME/dota2ai` trace/review cache, with chat cards that open the match page in one click.

## Install

Needs Node 24.9 or newer, DSH **≥ 0.2.1-rc.3** (`0.2.x`) and pnpm,
which DSH uses to install plugins.

Download `qianhaoq-dsh-dota2ai-<version>.tgz` and `SHA256SUMS` from the latest `dsh-v*`
[release](https://github.com/qianhaoq/dota2.ai/releases), then:

```sh
sha256sum -c SHA256SUMS
dsh plugin --profile web add ./qianhaoq-dsh-dota2ai-0.2.2.tgz
dsh web
```

One archive serves Linux, macOS and Windows: there is no native code. Parsed replay traces (~250 KB gzipped) are fetched from `dota2.ai` (or built locally when `extractorBin` is set) and cached under `$DSH_HOME/dota2ai/traces/`.

If the sidebar entry or tools do not show up, check the profile's `package.json`: the package must be in
`dependencies` *and* in `dsh.profile.bundles`. `dsh --profile web --dump-config` should list a `dota2ai` entry.
In GUI profiles (`dsh web` and Desktop), DSH's `typert-loader` automatically loads `./typert` and `Dota2AiRemote` attaches to `ctx.typert`; in headless CLI profiles without `typert`, the seven `dota2ai_*` tools and the `dota2ai` skill still activate cleanly.

## Tools

| Tool | What it does |
|---|---|
| `dota2ai_replay_review` | Deep replay review investigated locally by your DSH model and checked against the replay (`verifyReview`). Never blocks: `parsing` / `reviewing` mean call again after `poll_after_sec`; `pick_hero` means ask the user; `ready` has the verdict, checked findings, rules for next game, and blind spots |
| `dota2ai_recent_matches` | A player's recent public games (`account`: Steam friend code or profile link) |
| `dota2ai_coach_report` | Without `hero`: the roster. With it: `section` `summary` · `why` · `lane` · `deaths` · `items` · `fights` · `plan` · `all` |
| `dota2ai_coach_cases` | Pro games on the same problem: one that avoided it, one that repeated it |
| `dota2ai_coach_ask` | A follow-up question, answered locally by your DSH model (with replay lookup tools when a trace is cached, else from the report) |
| `dota2ai_goal_check` | Judge a later game against a finding's `goal` (or the active goal saved in `$DSH_HOME/dota2ai/profile.json`) |
| `dota2ai_hero_matchup` | Hero vs hero from pro games; `by_rank` from STRATZ (credit STRATZ when quoting it) |

## Settings

In the profile's `cordis.patch.yml`, under the `dota2ai` entry:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Enable the UI panel and register the tools |
| `lang` | `en` | Default answer language when a tool call names none (`en` or `zh`) |
| `apiBase` | `https://dota2.ai` | dota2.ai origin for match data and parsed replay traces |
| `skillEnabled` | `true` | Register the `dota2ai` skill |
| `homeDir` | `""` | Custom local storage directory (defaults to `$DSH_HOME/dota2ai` or `~/.dsh/dota2ai`) |
| `extractorBin` | `""` | Optional local `dota-extract` binary path for offline replay parsing |

## Develop

```sh
npx vitest run packages/dsh                          # host LLM bridge, trace pipeline, local service, UI panel & bundle
node packages/dsh/scripts/pack.mjs                   # dist/qianhaoq-dsh-dota2ai-<version>.tgz + SHA256SUMS
node packages/dsh/scripts/installed-smoke.mjs packages/dsh/dist/*.tgz \
  --dsh <dir>/node_modules/@deepseek-ai/dsh/lib/bin.js [--browser]
```

---

## 简体中文

原生 [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh)（DeepSeek Harness）插件，在 DSH 内完整复刻 [dota2.ai](https://dota2.ai) 页面并直接使用 DSH 宿主模型：

- **左侧栏独立 `dota2.ai` 页面**：包含首页选局、玩家近期比赛、版本顾问与完整复盘页（10 人记分板、可展开录像原始证据卡、10 英雄逐秒走位与眼位小地图回放、右侧流式追问栏、下局训练目标追踪）。
- **由你的 DSH 宿主模型驱动（`ctx.llm`）**：录像深度调查复盘（`runDeepReview` + `verifyReview` 事实核查）、录像查证追问（`runChat` + `verifyText`）与版本顾问均在本机调用你在 DSH 配置的模型——默认跟随 DSH 当前模型，同时保留页面内模型切换器，支持同一局用不同模型对比复盘。
- **会话工具与卡片联动**：7 个 `dota2ai_*` 工具与独立页面共享本地 `$DSH_HOME/dota2ai` 缓存，聊天内的工具卡片可一键跳转到对应复盘页。

**安装**（需要 Node ≥ 24.9、DSH **≥ 0.2.1-rc.3** 和 pnpm）：

```sh
sha256sum -c SHA256SUMS
dsh plugin --profile web add ./qianhaoq-dsh-dota2ai-0.2.2.tgz
dsh web
```

同一个包适用于 Linux、macOS 和 Windows（无原生编译二进制）。配置项（`cordis.patch.yml` 下 `dota2ai`）：`enabled`、`lang`、`apiBase`、`skillEnabled`、`homeDir`、`extractorBin`。
