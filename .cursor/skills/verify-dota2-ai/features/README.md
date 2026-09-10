# Dota2.ai Tactical Coach V3 verification map

This directory is the maintained source for verifying user-facing behavior of the Dota2.ai web UI. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch with `.cursor/skills/verify-dota2-ai/bin/verify-dota2-ai launch` so Vite answers `http://127.0.0.1:5173` and Express answers `http://127.0.0.1:8080/health`.
- Run `verify-dota2-ai doctor` and require `ok: true`, our PIDs, and title `Dota2.ai - Tactical Assistant`.
- Drive at 1280×800 (desktop `主导航`). Default language is 中文 (`中` in the header).
- Never drive an instance that was not started by this verification run. Ports `5173`/`8080` are shared defaults.
- `DEEPSEEK_API_KEY` may be unset. Features in this map that stop before SSE are still valid. Record `apiKeyConfigured` from `/api/health` on every proof.

## Driving conventions

- Start every recipe from `{uiOrigin}/` unless the feature lists a hash (`#knowledge`, `#journal`).
- Prefer `aria-label`, `role`, and visible 中文 over CSS or coordinates.
- Treat every command as literal. Keep quoted names unchanged.
- Run browser actions through `verify-dota2-ai drive <feature-id>` (Chrome CDP) or the Cursor computerUse browser with the same handles.
- Restore journal scratch after a mutation when the recipe says so. Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting workspace copy, not only the final screen.
- UI proof includes `aria.txt` and a PNG that shows `DOTA2.AI · V3`.
- Mutation proof (journal) includes a second view of 战术笔记 after save.
- Record the feature ID and entry point in `meta.json`.
- Report an unreachable path with the attempted handle and the unmet precondition.
- Do not report a skipped DeepSeek stream as verified. If the key is missing, say so.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-dota2-ai` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [战术室入口](./tactical-room-entry.md) covers the landing motives, workspace tabs, and return to 入口. No DeepSeek key.
- [赛后复盘入口](./match-review-entry.md) covers opening review intake without starting analysis. No DeepSeek key.
- [英雄图鉴搜索](./hero-codex-search.md) covers `#knowledge` search by 中文/alias. Needs OpenDota or `/api/meta/heroes`, not DeepSeek.
- [战术笔记](./tactical-journal.md) covers empty state plus save / 完成 / 移除 / 撤销 from a 英雄修炼 drill. No DeepSeek key.
- [语言切换](./language-toggle.md) covers 中文 default and the header toggle. No DeepSeek key.
