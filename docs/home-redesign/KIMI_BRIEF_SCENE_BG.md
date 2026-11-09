# Task: replace abstract map geometry with real Dota 2 scene background (Kimi k3.1-pro) — t292u

Branch: `feat/home-k31pro-redesign-20261109` @ `09077e4`. Draft PR #125. Keep **Draft + `no-auto-merge`**. Do not merge/deploy. Do not touch #115. Do not change backend API / dsh.

## User feedback (must honor)
钱浩 t292u: 「背景有点丑，最好能和 dota2 有关系」.
The previous large white-line three-lane / river / racetrack rectangle SVG (`HomeGround` / map motif frames) was **rejected**. Do **not** tweak that geometry or just swap gradients. Remove those big white wireframes.

## Critical process — look before coding
1. Read `docs/home-redesign/scene-candidates/ATTRIBUTION.md` and `SOURCE_META.json`.
2. **Actually Read** (image) these files:
   - `docs/home-redesign/scene-candidates/candidate-radiant-fountain.jpg`
   - `docs/home-redesign/scene-candidates/candidate-radiant-shop.jpg`
   - `docs/home-redesign/scene-candidates/candidate-lane-forest.jpg`
   - `docs/home-redesign/scene-candidates/spring_forward_social.png` (promo — optional; prefer environment scenes)
   - Rejected previous look: `/workspace/dota2-home-k31pro-preview/shots/desktop-1440.png`
3. You choose which scene (or crop of it) becomes the decorative background. Prefer recognizable Dota environment (fountain / trees / stone / shop / lane forest). Avoid looking like another game. Do not invent AI images. Do not use fake Valve logos.

## Visual goals
- Truly light / warm-paper UI with a **real Dota scene** atmosphere behind.
- Crop, fade, warm-white overlay, edge vignette OK. Scene must remain **visible enough** in screenshots (not washed to blank), but must **not** overpower Match ID input.
- Remove big white geometric lane frames.
- Slim copy stays: title + Match ID + one trust line + sample. No new marketing blocks / invented metrics.
- Sample match still real `9035042364` roster. Scene is decoration only — not tactical map evidence.
- EN + ZH; mobile ≤390: use a scene crop + stronger white mask; keep download weight reasonable (prefer ≤~350KB web asset under `public/`).
- Main input remains clearest. You may recompose (not forced to keep centered giant roster card) as long as sample stays usable.
- Keyboard/focus/contrast OK; restrained hover; `prefers-reduced-motion`.

## Implementation hints
- Put the chosen optimized asset under `public/home-scene/` (e.g. `public/home-scene/bg.jpg`) and reference it from CSS/`EmptyState`.
- Update `docs/home-redesign/CHANGES.md` with 对比说明 + source URLs/bytes.
- Update `docs/home-redesign/scene-candidates/ATTRIBUTION.md` if you pick a specific original URL.
- Run `npm test` (or focused+full), `npx tsc --noEmit`, `npm run build`. Fix failures.
- Overwrite screenshots:
  - `/workspace/dota2-home-k31pro-preview/shots/desktop-1440.png`
  - `/workspace/dota2-home-k31pro-preview/shots/mobile-390.png`
  - `/workspace/dota2-home-k31pro-preview/shots/mobile-390-zh.png`
  and copy into `docs/home-redesign/shots/`.
- For preview: rebuild is enough for later restart by the parent; you may `npm run build`. **Do not** open public tunnels. **Do not** change firewall/port whitelist/proxy/Chrome cgroup. If you need a temporary preview for screenshots, use Playwright against a short-lived `PORT=4174` or similar — leave existing **4173 persistent session alone** if still running.
- Commit + push to `origin/feat/home-k31pro-redesign-20261109`. Keep Draft + no-auto-merge.

## Done when
- No abstract white lane wireframe.
- Background is a faded official Dota store-scene derivative that reads as Dota.
- Slim copy preserved; tests/types/build green; shots refreshed; branch pushed.
