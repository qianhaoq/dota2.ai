# dota2.ai for DSH

[简体中文](#简体中文)

A native [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) (DeepSeek Harness) plugin that brings the full
[dota2.ai](https://dota2.ai) experience into DSH:

- **Standalone `dota2.ai` page in the DSH sidebar**: home, recent games, patch advisor, and the full replay review page (10-player scoreboard, clickable replay evidence cards, 10-hero minimap moment replay, coach chat rail, and next-game habit tracking).
- **Powered by your DSH host models (`ctx.llm`)**: deep replay investigations (`runDeepReview` + `verifyReview`), follow-up chat (`runChat` + `verifyText`) and the patch advisor all run locally using the models you configured in DSH — defaulting to your selected DSH model, with an in-page switcher to compare any model in your DSH profile on the same match.
- **Session tools, skill & clickable chat cards**: seven `dota2ai_*` tools and a `dota2ai` skill sharing the same local `$DSH_HOME/dota2ai` trace/review cache, with chat cards that open the match page in one click.

## Install

Needs Node 24.9 or newer and DSH **0.2.x (≥ 0.2.1-rc.3)**: verified on 0.2.1-rc.3 and 0.2.2-rc.5, which is
npm's `latest`. DSH installs plugins with pnpm, so pnpm must be on your PATH.

```sh
npm install -g pnpm @deepseek-ai/dsh@0.2.2-rc.5
curl -LO https://github.com/qianhaoq/dota2.ai/releases/download/dsh-v0.2.3/qianhaoq-dsh-dota2ai-0.2.3.tgz
dsh plugin --profile web add ./qianhaoq-dsh-dota2ai-0.2.3.tgz
DEEPSEEK_API_KEY=sk-... dsh web      # or start plain `dsh web` and enter the key in DSH's own API-key dialog
```

Then open **dota2.ai** in the DSH sidebar, paste a match ID and pick your hero. The review runs on your own
DeepSeek key, so it has no queue and no daily limit. A deep review is a few hundred thousand input tokens.
To check the download, fetch `SHA256SUMS` from the same
[release](https://github.com/qianhaoq/dota2.ai/releases) and run `sha256sum -c SHA256SUMS`.

One archive serves Linux, macOS and Windows: there is no native code. Parsed replay traces (~250 KB gzipped) are fetched from `dota2.ai` (or built locally when `extractorBin` is set) and cached under `$DSH_HOME/dota2ai/traces/`. Reviews, chats and your goal stay on your machine under `$DSH_HOME/dota2ai`. The public `dota2.ai/r/<match>` page does not show them.

### Web site, DSH or an agent?

| | dota2.ai web | DSH plugin | Agent over MCP |
|---|---|---|---|
| Model that writes the review | dota2.ai's | **yours** (any model in your DSH) | dota2.ai's (`replay_review`) |
| Limits | per caller, and a daily limit for the whole site | none of ours | same as web |
| Where the review is kept | dota2.ai | your machine | dota2.ai |

### Troubleshooting

- **`installation rejected … incompatible with dsh`**: your DSH is outside the range above. Install a
  DSH from the range (`npm install -g @deepseek-ai/dsh@0.2.2-rc.5`) or a newer plugin release.
- **`pnpm` not found / plugin command failed**: `npm install -g pnpm`, then run `dsh plugin … add` again.
- **The panel says no model / the tool answers `model_not_configured`**: DSH has no model with a key yet. Start
  `dsh web` with `DEEPSEEK_API_KEY` set, or enter the key in DSH's API-key dialog, and pick a model.
- **No dota2.ai entry in the sidebar, or no tools**: the profile's `package.json` must list the package in
  `dependencies` *and* in `dsh.profile.bundles`, and `dsh --profile web --dump-config` should list a `dota2ai`
  entry. In GUI profiles (`dsh web` and Desktop), DSH's `typert-loader` loads `./typert` and `Dota2AiRemote`
  attaches to `ctx.typert`. In headless CLI profiles without `typert`, the seven `dota2ai_*` tools and the `dota2ai`
  skill still activate.

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
# a real review on a real model through a real `dsh web` (spends the key's account; see the script's header)
DEEPSEEK_API_KEY=… node packages/dsh/scripts/live-review.mjs packages/dsh/dist/*.tgz \
  --dsh <dir>/node_modules/@deepseek-ai/dsh/lib/bin.js [--lang zh] [--browser <screenshot dir>]
```

---

## 简体中文

原生 [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh)（DeepSeek Harness）插件，在 DSH 内完整复刻 [dota2.ai](https://dota2.ai) 页面并直接使用 DSH 宿主模型：

- **左侧栏独立 `dota2.ai` 页面**：包含首页选局、玩家近期比赛、版本顾问与完整复盘页（10 人记分板、可展开录像原始证据卡、10 英雄逐秒走位与眼位小地图回放、右侧流式追问栏、下局训练目标追踪）。
- **由你的 DSH 宿主模型驱动（`ctx.llm`）**：录像深度调查复盘（`runDeepReview` + `verifyReview` 事实核查）、录像查证追问（`runChat` + `verifyText`）与版本顾问均在本机调用你在 DSH 配置的模型——默认跟随 DSH 当前模型，同时保留页面内模型切换器，支持同一局用不同模型对比复盘。
- **会话工具与卡片联动**：7 个 `dota2ai_*` 工具与独立页面共享本地 `$DSH_HOME/dota2ai` 缓存，聊天内的工具卡片可一键跳转到对应复盘页。

**安装**（需要 Node ≥ 24.9，DSH **0.2.x (≥ 0.2.1-rc.3)**，npm 上的 `latest` 是 0.2.2-rc.5；DSH 用 pnpm 装插件）：

```sh
npm install -g pnpm @deepseek-ai/dsh@0.2.2-rc.5
curl -LO https://github.com/qianhaoq/dota2.ai/releases/download/dsh-v0.2.3/qianhaoq-dsh-dota2ai-0.2.3.tgz
dsh plugin --profile web add ./qianhaoq-dsh-dota2ai-0.2.3.tgz
DEEPSEEK_API_KEY=sk-... dsh web      # 或者直接 dsh web，在 DSH 弹出的 API Key 窗口里填
```

然后在 DSH 左侧栏打开 **dota2.ai**，贴比赛 ID、选英雄即可。复盘用的是你自己的 DeepSeek Key：不排队、不限次（一次深度复盘大约几十万输入 token）。复盘、追问和训练目标都保存在你自己电脑的 `$DSH_HOME/dota2ai` 下，公开的 `dota2.ai/r/<比赛>` 页面看不到它们。

**常见问题**

- **`installation rejected … incompatible with dsh`**：你的 DSH 版本不在上面的范围内。装范围内的版本（`npm install -g @deepseek-ai/dsh@0.2.2-rc.5`），或者换更新的插件版本。
- **找不到 `pnpm` / plugin command failed**：先 `npm install -g pnpm`，再重新执行 `dsh plugin … add`。
- **页面提示没有模型 / 工具返回 `model_not_configured`**：DSH 里还没有可用的模型。启动 `dsh web` 时带上 `DEEPSEEK_API_KEY`，或者在 DSH 的 API Key 窗口里填写，然后选一个模型。
- **左侧栏没有 dota2.ai、会话里没有工具**：profile 的 `package.json` 需要同时在 `dependencies` 和 `dsh.profile.bundles` 里列出本插件，`dsh --profile web --dump-config` 里应能看到 `dota2ai`。

同一个包适用于 Linux、macOS 和 Windows（无原生编译二进制）。配置项（`cordis.patch.yml` 下 `dota2ai`）：`enabled`、`lang`、`apiBase`、`skillEnabled`、`homeDir`、`extractorBin`。
