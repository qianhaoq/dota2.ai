# 语言切换

The shell defaults to **English** and toggles 中文 from the header globe control. Navigation labels, landing copy, and the control's own `aria-label` swap together. Language is in-memory only for the tab.

## Sub-features

- `lang-default-en` loads Tactical Room / Hero Training / Hero Codex / Tactical Journal and the English landing title.
- `lang-to-zh` switches those four labels to 战术室 / 英雄修炼 / 英雄图鉴 / 战术笔记.
- `lang-to-en` switches back from the same control.
- `lang-aria` uses `切换语言` while in English and `Switch language` while in 中文 (inverted: the label is the *other* language's instruction).

## How to get to it (user POV)

- On any workspace, choose the header button that shows `EN` (en) or `中` (zh).
- There is no URL or localStorage flag. A reload returns to English.

## Driving it with verify-dota2-ai

Preconditions:

- Doctor reports `ok: true`.
- Start at `{uiOrigin}/` with a fresh load (en).
- DeepSeek is not required.

- **Default.** Run `verify-dota2-ai drive language-toggle`. `Main navigation` contains `Tactical Room` and `Hero Codex`. Landing contains `Make the next call`. The toggle `aria-label` is `切换语言` and the visible glyph is `EN`.
- **To 中文.** Click `role=button` name `切换语言`. Nav contains `战术室` and `英雄图鉴`. Landing contains `把下一次判断`. The toggle `aria-label` becomes `Switch language` and the glyph is `中`. Demo badge reads `教学演示徽章 = 非真实数据`.
- **Back to English.** Click `role=button` name `Switch language`. `Tactical Room` and `Make the next call` return.
- **Proof.** `en.png`, `zh.png`, and `en-back.png` show `DOTA2.AI` plus the matching nav language. `page.txt` after the last step is English.

## Gotchas

- The `aria-label` is the **other** language's instruction, not the current language name. In English mode the button says `切换语言`; in 中文 mode it says `Switch language`. Do not click a button named `中文` or `English`.
- Visible `EN` / `中` sit next to a decorative globe icon. Prefer the `aria-label`.
- Reloading the page drops 中文. Do not use a second tab as proof of persistence.
- Mentor rail copy also swaps (`Your tactical coach · expression layer` ↔ `你的战术教练 · 表达层`) but the rail is `hidden` below `lg`. At 1280×800 it is visible.
- Hash routes (`#journal`) survive a toggle; the workspace does not remount away from the current nav id.
