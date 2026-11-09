# Home redesign changes

- Replaced the dark bunker palette with warm ivory/paper surfaces, dark warm ink, aged-gold accents, and a restrained Dire-rust primary action. The shared v2 tokens keep `/m/:id` visually consistent.
- Moved the Match ID input from the empty page's bottom bar into a prominent hero form with a visible label, supported-link hint, disabled empty state, and accessible invalid-input error. It reuses `Composer` and `parseMatchInput`; review loading and errors remain on `MatchPage`.
- Added an editorial heading and concise post-match review copy in English and Chinese. The home header is quieter and no longer shows proposed surface tabs or a redundant new-review button.
- Added one clearly labeled example using the real OpenDota sample match `9035042364`: its actual Radiant/Dire roster from the checked-in fixture, Steam CDN hero portraits, a subtle minimap motif, and the three-part review structure. No sample conclusions or invented metrics are shown. OpenDota and Valve/Steam CDN sources are linked.
- Added responsive desktop/mobile layouts, visible keyboard focus, and reduced-motion-compatible styling. Browser checks at 320, 390, 768, 1024, 1366, and 1440 px found no horizontal overflow; axe WCAG A/AA checks at 390 and 1440 px reported no violations.

## Verification

- `npm test` — 101 files, 1457 tests passed.
- `npx tsc --noEmit` — passed.
- `npm run build` — passed (existing chunk-size warning only).
- Desktop/mobile Chromium smoke checks — all ten hero portraits loaded; no page errors.
