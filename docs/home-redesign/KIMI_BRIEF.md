# Task: Redesign dota2.ai `/` homepage (Kimi k3.1-pro)

You are implementing a **homepage layout + interaction redesign** for https://dota2.ai/.
Work only in this worktree. Branch: `feat/home-k31pro-redesign-20261109` @ `2793eb7`.

## Critical: change the real `/` route
- Production `/` (ui_v2) renders `App.tsx` → `HomePage` → `V2Shell` + `EmptyState` + sticky `Composer`.
- i18n empty copy: `src/v2/i18n/en.ts` / `zh.ts` (`emptyH`, `emptyP`, …).
- Tokens: `src/v2/tokens.css` (currently DARK bunker — must become light warm/ivory).
- Do **NOT** only edit unused components, `/legacy`, or MatchPage alone.
- After your work, visiting `/` must look **obviously different** from the attached screenshot `docs/home-redesign/current-live-home.png` (dark, huge empty middle, bottom-only input, gold shield only).

## Product constraints (hard)
- Accurate post-match review product — not a vague AI coach.
- Early phase: fully free; **no pricing, no account/billing UI**.
- Primary path: enter Match ID → see review. Provide a real sample entry (`9035042364` already exists as SAMPLE_MATCH_ID).
- Clear loading / error / empty states.
- **Do not invent** user counts, win rates, model capabilities, or sample-match conclusions.
- Do not change backend API contracts, dsh learning hot path, or evidence/review engine semantics.
- Do not touch PR #115 or unrelated features.

## Visual / UX goals (钱浩 t286u)
- Light style: warm paper / ivory background, refined type hierarchy, generous but intentional whitespace (not a barren black void).
- Clear Dota 2 identity: restrained Steam CDN hero portraits / minimap motif / Radiant·Dire marks / item icons with attributable sources. **Do not** ship a full-bleed crimson/dark esports skin or generic AI purple-blue gradients.
- Single prominent primary action (Match ID input) — not buried in a tiny bottom bar on an empty page.
- Optional carefully laid-out **example review preview** using real sample match framing, clearly labeled as example, sourced — no fictional metrics.
- No marketing modules, no long stacks of promo cards.
- Desktop + mobile responsive; no horizontal overflow; keyboard operable; good contrast; respect `prefers-reduced-motion`.
- Bilingual: keep en/zh via existing i18n.

## Implementation expectations
1. Read AGENTS.md and relevant v2 files first.
2. Redesign tokens (light), EmptyState, V2Shell home layout, TopBar/Composer as needed for home.
3. Keep MatchPage working; reuse Composer/parseMatchInput; do not break `/m/:id`.
4. Update/add tests for home copy/layout as needed (`src/App.test.tsx`, EmptyState tests).
5. Run: `npm test` (or focused), `npx tsc --noEmit`, `npm run build`. Fix failures.
6. Start preview: `npm run start:dev` (or build+`npm start`) bound to `0.0.0.0` on a free port; write URL/port to `docs/home-redesign/PREVIEW.txt`.
7. Write a short `docs/home-redesign/CHANGES.md` listing what visually changed vs the live dark home.
8. Commit on this branch with a clear message (do not push unless asked; do not open/merge PR yourself unless asked).

## Done when
- `/` is visually a new light Dota-flavored home with Match ID primary path.
- Tests/types/build pass.
- PREVIEW.txt exists with reachable host:port.
