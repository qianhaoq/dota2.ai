# Follow-up: slim homepage copy density (钱浩 t287u)

Branch already has the light Dota home redesign. Visual QA failed: **「文字太多太密集了」**.

Work ONLY in this worktree on `feat/home-k31pro-redesign-20261109`. Use the existing light theme / hero portraits / Radiant·Dire / Match ID path. Do **not** revert to dark bunker. Do **not** open merge / remove draft.

## Goals
1. **Dramatically cut visible text density** on `/` (`EmptyState` + related i18n en/zh + CSS if spacing needs to breathe).
2. First screen should read at a glance:
   - **One short title**
   - **Match ID input** (primary)
   - **One sample entry** (e.g. sample match button/link)
3. Example card: keep hero portraits + Radiant/Dire marks (+ subtle map ok). **Strip explanatory prose** — remove 01/02/03 long sentences, long example titles/notes, redundant trust paragraphs if duplicated. Prefer labels like “Radiant / Dire” and “Sample · 9035042364” only.
4. Keep: light warm paper, Dota recognition, free/no pricing, evidence honesty (one short trust line max, or fold into tiny footer).
5. No marketing blocks. Slim **both** `en.ts` and `zh.ts`.
6. Update tests that assert old long copy (`App.test.tsx`, `EmptyState.test.tsx`, dict tests if any).
7. Rebuild, restart preview on `PORT=4173 HOST=0.0.0.0`, overwrite screenshots:
   - `/workspace/dota2-home-k31pro-preview/shots/desktop-1440.png`
   - `/workspace/dota2-home-k31pro-preview/shots/mobile-390.png`
   and copy into `docs/home-redesign/shots/`.
8. Update `docs/home-redesign/CHANGES.md` with a “slim copy” note; update `PREVIEW.txt`.
9. Commit (clear message). Do **not** push if the orchestrator will push — actually you MAY push to origin on this branch. Do not merge. Keep PR draft.

## Suggested delete/shorten targets
- Long `emptyP` → delete or 1 short clause max
- `homeEyebrow` can go or become a tiny mark
- `exampleTitle`, `exampleNote`, `turningDesc` / change / next long list → remove from UI
- `stSample` → short: “Sample 9035042364”
- `trust` → one short line or remove from hero if crowded
- Supported-links helper text → one short line or placeholder-only

## Done when
- `/` first fold is sparse: title + input + sample; example card mostly visual
- Tests/types/build pass
- New screenshots written to the paths above
