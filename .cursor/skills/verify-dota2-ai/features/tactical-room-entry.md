# 战术室入口

战术室 is the default workspace. A user sees the motive landing (刚打完 / 准备开局 / 想练一下), honest copy that no ranks are fabricated, and can enter 复盘 / 阵容 / 英雄修炼 or return via the 入口 tab.

## Sub-features

- `room-landing` shows the Chinese title and three motive cards on first load.
- `room-honest-empty` states that win rates, ranks, and growth scores are not invented.
- `room-review-motive` opens the 复盘 workspace from 刚打完，复盘一局.
- `room-tabs` switches 入口 / 复盘 / 阵容 / 装备 without leaving the tactical room.
- `room-brand` returns to 战术室 from the `DOTA2.AI` brand control.

## How to get to it (user POV)

- Open the app root. The shell lands on 战术室 (`#tactical`).
- Choose `战术室` in `主导航` (desktop) or `移动端导航` (viewport &lt; 768px).
- Choose the brand button named `DOTA2.AI`.
- Follow `#tactical`.

## Driving it with verify-dota2-ai

Preconditions:

- Doctor reports `ok: true` at `http://127.0.0.1:5173`.
- Language is 中文 (header shows `中`, `aria-label="Switch language"`).
- Viewport is 1280×800 so `主导航` is visible.
- DeepSeek is not required.

- **Open landing.** Load `{uiOrigin}/`. Run `verify-dota2-ai drive tactical-room-entry`. The heading contains `把下一次判断` and `练得更好。` and `主导航` includes `战术室`.
- **Read motives.** The page contains buttons whose names include `刚打完，复盘一局`, `准备开局，推演阵容`, and `想变强，练一次判断`.
- **Honest empty.** The notice `这里没有虚构的胜率、段位或成长分。导入真实比赛后，才展示与你有关的局面。` is visible. No fabricated rank or recent-match list appears.
- **Enter review.** Choose the 刚打完 card. The helper clicks `role=button` containing `刚打完，复盘一局`. The 复盘 framing `先还原你当时掌握的信息。` and `复盘一局` appear. Tab `复盘` is selected.
- **Return.** Choose tab `入口`. Run is `role=tab` name `入口`. The landing title returns.
- **Proof.** Artifacts `landing.png`, `after-review.png`, `after-back.png`, `page.txt`, and `aria.txt` show `DOTA2.AI` plus the Chinese title and at least one motive card.

## Gotchas

- Motive cards have no `aria-label`. Match the visible title; the accessible name also includes the subtitle.
- Below `md`, `主导航` is not displayed. Widen the viewport or use `移动端导航` with the same four labels.
- Choosing 想变强，练一次判断 leaves the tactical room and opens 英雄修炼. That is a different feature file.
- `入口` / `复盘` / `阵容` / `装备` are tabs, not the four shell nav items.
- Do not treat a later SSE answer as proof of this feature.
