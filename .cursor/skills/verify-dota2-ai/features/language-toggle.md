# 语言切换

The shell defaults to 中文 and toggles English from the header globe control. Navigation labels, landing copy, and the control's own `aria-label` swap together. Language is in-memory only for the tab.

## Sub-features

- `lang-default-zh` loads 战术室 / 英雄修炼 / 英雄图鉴 / 战术笔记 and the Chinese landing title.
- `lang-to-en` switches those four labels to Tactical Room / Hero Training / Hero Codex / Tactical Journal.
- `lang-to-zh` switches back from the same control.
- `lang-aria` uses `Switch language` while in 中文 and `切换语言` while in English.

## How to get to it (user POV)

- On any workspace, choose the header button that shows `中` (zh) or `EN` (en).
- There is no URL or localStorage flag. A reload returns to 中文.

## Driving it with verify-dota2-ai

Preconditions:

- Doctor reports `ok: true`.
- Start at `{uiOrigin}/` with a fresh load (zh).
- DeepSeek is not required.

- **Default.** Run `verify-dota2-ai drive language-toggle`. `主导航` contains `战术室` and `英雄图鉴`. Landing contains `把下一次判断`. The toggle `aria-label` is `Switch language` and the visible glyph is `中`.
- **To English.** Click `role=button` name `Switch language`. Nav contains `Tactical Room` and `Hero Codex`. Landing contains `Make the next call`. The toggle `aria-label` becomes `切换语言` and the glyph is `EN`. Demo badge reads `Demo badge = not live data`.
- **Back to 中文.** Click `role=button` name `切换语言`. `战术室` and `把下一次判断` return.
- **Proof.** `zh.png`, `en.png`, and `zh-back.png` show `DOTA2.AI` plus the matching nav language. `page.txt` after the last step is 中文.

## Gotchas

- The `aria-label` is the **other** language's instruction, not the current language name. Do not click a button named `中文`.
- Visible `中` / `EN` sit next to a decorative globe icon. Prefer the `aria-label`.
- Reloading the page drops English. Do not use a second tab as proof of persistence.
- Mentor rail copy also swaps (`你的战术教练 · 表达层` ↔ `Your tactical coach · expression layer`) but the rail is `hidden` below `lg`. At 1280×800 it is visible.
- Hash routes (`#journal`) survive a toggle; the workspace does not remount away from the current nav id.
