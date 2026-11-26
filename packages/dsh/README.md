# dota2.ai for DSH

[简体中文](#简体中文)

A native [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) (DeepSeek Harness) plugin that puts the
[dota2.ai](https://dota2.ai) coach in every DSH session: the replay review with its evidence checked
against the replay, the rule-based reports, pro games on the same problem, follow-ups, next-game
goals and hero matchups, plus a skill that tells the model how to use them.

No keys. The tools call the public dota2.ai API as you; nothing runs a model on your machine.

## Install

Needs Node 24.9 or newer, DSH **0.2.1-rc.3** (the release this plugin is verified on) and pnpm,
which DSH uses to install plugins.

Download `qianhaoq-dsh-dota2ai-<version>.tgz` and `SHA256SUMS` from the latest `dsh-v*`
[release](https://github.com/qianhaoq/dota2.ai/releases), then:

```sh
sha256sum -c SHA256SUMS
dsh plugin --profile web add ./qianhaoq-dsh-dota2ai-0.1.0.tgz
dsh web
```

One archive serves Linux, macOS and Windows: there is no native code. The DSH packages it uses
(`@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`) come from your DSH installation.

If the tools do not show up, check the profile's `package.json`: the package must be in
`dependencies` *and* in `dsh.profile.bundles`. `dsh --profile web --dump-config` should list a
`dota2ai` entry.

## Tools

| Tool | What it does |
|---|---|
| `dota2ai_replay_review` | dota2.ai's main review, written from the replay and checked against it. It never blocks: `parsing` / `reviewing` mean call again after `poll_after_sec` (two to four minutes the first time); `pick_hero` means ask the user; `ready` has the verdict, findings with evidence, what to do next game, what the replay cannot show, and the page `url` |
| `dota2ai_recent_matches` | A player's recent public games (`account`: Steam friend code or profile link) |
| `dota2ai_coach_report` | Without `hero`: the roster. With it: `section` `summary` · `why` · `lane` · `deaths` · `items` · `fights` · `plan` · `all` |
| `dota2ai_coach_cases` | Pro games on the same problem: one that avoided it, one that repeated it |
| `dota2ai_coach_ask` | A follow-up question, answered only from the report |
| `dota2ai_goal_check` | Judge a later game against a finding's `goal`: met, missed, no opportunity, unknown |
| `dota2ai_hero_matchup` | Hero vs hero from pro games; `by_rank` from STRATZ (credit STRATZ when quoting it) |

The descriptions are the same text the dota2.ai MCP server gives (`dota2ai/tools`), so the two
surfaces cannot drift. `dota2ai_replay_review` goes through the hosted MCP endpoint
(`<apiBase>/mcp`), because the replay review runs on the server; its limits are those of any
caller (about five reviews started per ten minutes).

The plugin can sit next to the [DSH Dota coach](https://github.com/qianhaoq/qh-dsh-dota-coach)
plugin: its tools are `dota_*`, these are `dota2ai_*`.

## Settings

In the profile's `cordis.patch.yml`, under the `dota2ai` entry:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Register the tools |
| `lang` | `en` | Answer language when a call names none (`en` or `zh`) |
| `apiBase` | `https://dota2.ai` | dota2.ai origin (a local server for development) |
| `skillEnabled` | `true` | Register the `dota2ai` skill |

## Develop

The source is plain ESM in this monorepo and reuses the CLI's code (`dota2ai/handlers`,
`dota2ai/tools`); `scripts/build.mjs` bundles it with esbuild and leaves only `@deepseek-ai/*` to the
host.

```sh
npx vitest run packages/dsh                          # tool definitions, MCP parity, replay polling, skill, bundle
node packages/dsh/scripts/pack.mjs                   # dist/qianhaoq-dsh-dota2ai-<version>.tgz + SHA256SUMS
node packages/dsh/scripts/installed-smoke.mjs packages/dsh/dist/*.tgz \
  --dsh <dir>/node_modules/@deepseek-ai/dsh/lib/bin.js [--live]
```

The smoke installs the archive into a clean profile with DSH's own CLI (Node 24, pnpm on `PATH`),
checks that DSH composes the profile and loads the plugin's `Config`, then loads the plugin and
checks its tools, skill, argument checks and reload. `--live` also calls dota2.ai.

A release: raise `version`, add `.github/release-notes/dsh-v<version>.md`, merge, then push the tag
`dsh-v<version>`. `.github/workflows/dsh-release.yml` tests, packs, runs the smoke and publishes the
archive with `SHA256SUMS`. A DSH upgrade changes `engines.dsh`, the peer pins written by
`pack.mjs`, and `DSH_VERSION` in the workflow together.

---

## 简体中文

原生 [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh)（DeepSeek Harness）插件，把
[dota2.ai](https://dota2.ai) 教练放进每个 DSH 会话：对照录像核对过的复盘、规则引擎报告、同一问题上的职业比赛、
追问、下一局目标和英雄对位，外加一份告诉模型怎么用这些工具的 skill。

不需要 Key。工具以你的身份调用 dota2.ai 的公开 API，本机不运行模型。

**安装**：需要 Node ≥ 24.9、DSH **0.2.1-rc.3** 和 pnpm（DSH 用它安装插件）。从最新的 `dsh-v*`
[Release](https://github.com/qianhaoq/dota2.ai/releases) 下载 tgz 和 `SHA256SUMS`：

```sh
sha256sum -c SHA256SUMS
dsh plugin --profile web add ./qianhaoq-dsh-dota2ai-0.1.0.tgz
```

同一个包适用于所有平台。工具没出现时，检查 profile 的 `package.json`：包必须同时在 `dependencies` 和
`dsh.profile.bundles` 里；`dsh --profile web --dump-config` 应列出 `dota2ai` 条目。

**工具**：`dota2ai_replay_review`（录像复盘，`parsing` / `reviewing` 时隔 `poll_after_sec` 再调；`pick_hero` 时问用户）、
`dota2ai_recent_matches`、`dota2ai_coach_report`、`dota2ai_coach_cases`、`dota2ai_coach_ask`、
`dota2ai_goal_check`、`dota2ai_hero_matchup`。描述与 dota2.ai 的 MCP 服务逐字相同。可以和工具名为 `dota_*` 的
[DSH Dota 教练](https://github.com/qianhaoq/qh-dsh-dota-coach)插件同时安装。

**配置**（profile 的 `cordis.patch.yml` 里 `dota2ai` 条目）：`enabled`、`lang`（`en` / `zh`，调用未指定语言时使用）、
`apiBase`、`skillEnabled`。
