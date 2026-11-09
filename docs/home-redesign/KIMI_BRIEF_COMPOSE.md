# Task: recompose dota2.ai `/` visual design (Kimi k3.1-pro) — t289u

Branch: `feat/home-k31pro-redesign-20261109` @ current HEAD (~`3e6c475`). Draft PR #125. Keep Draft + `no-auto-merge`. Do not merge/deploy. Do not touch #115.

## Critical process
1. **First** open `docs/home-redesign/RESEARCH_NOTES.md` and **actually Read** the image files listed there (`docs/home-redesign/refs/orior-recent.png`, `stratz-home.png`, `pirsch-landbook.webp`, and skim others). Your design choices must show you studied them.
2. You are the designer. Make a mature composition decision. Do **not** just sprinkle two soft gradients on the current flat ivory void.
3. Keep the **slim copy** from the last approved direction (title + Match ID + one short trust line + sample). **Do not** restore dense paragraphs, 01/02/03 lists, marketing cards, or feature trios.

## Product / UX constraints
- Real `/` home only (`EmptyState` + `V2Shell`/`tokens`/CSS as needed). MatchPage still works.
- Free / no pricing / no account-billing UI.
- No invented win rates, battle reports, user counts, or sample conclusions.
- No backend/API/evidence-engine/dsh hot-path changes.
- EN + ZH both fine; slim dictionaries stay slim (or shorter).
- Mobile ≤390: clean, no horizontal overflow; recompose for mobile — do not mechanically squash desktop.
- Keyboard focus, contrast OK; only restrained hover; honor `prefers-reduced-motion`.
- Sample `9035042364` + Match ID input remain real/working. Steam CDN hero portraits + Radiant/Dire marks OK.

## Visual goals (solve BOTH prior failures)
1. **Not text-dense** (already slim — keep it).
2. **Not a blank flat color field**: the sample/hero composition must become a **strong visual center** with hierarchy/scale (Orior-like anchor mechanism). Background uses intentional Dota-abstract geometry (Radiant soft green / Dire soft red zones, river, three lanes) tying input ↔ sample — STRATZ-like controlled partitions but lighter and our palette.
3. Truly light warm paper overall; colors visible in screenshots but not heavy enough to hurt reading.
4. CSS/SVG geometry only — no generated bitmap wallpapers required.

## Deliverables
1. Implement the redesign in code; update tests if needed.
2. `npm test` (or focused + full), `npx tsc --noEmit`, `npm run build` — fix failures.
3. Write/update `docs/home-redesign/CHANGES.md` with a clear **对比说明**: how this version fixes (a) text density and (b) empty flat background, referencing the studied refs.
4. Restart preview: `PORT=4173 HOST=0.0.0.0 npm start` (kill old 4173 first). Confirm HTTP 200. Write `docs/home-redesign/PREVIEW.txt` with pid + URL. **Do not** spend time on public tunnels.
5. Overwrite screenshots:
   - `/workspace/dota2-home-k31pro-preview/shots/desktop-1440.png`
   - `/workspace/dota2-home-k31pro-preview/shots/mobile-390.png`
   - `/workspace/dota2-home-k31pro-preview/shots/mobile-390-zh.png` (set lang=zh)
   and copy into `docs/home-redesign/shots/`.
6. Commit with a clear message and **push** to `origin/feat/home-k31pro-redesign-20261109`. Do not mark ready / merge / remove `no-auto-merge`.

## Done when
- `/` looks composed (strong visual center + meaningful Dota-abstract ground), still text-sparse.
- Tests/types/build green; preview alive on 4173; screenshots refreshed; branch pushed.
