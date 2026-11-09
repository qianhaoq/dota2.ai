# Scene background source notes (t292u)

Fetched: 2026-11-09T13:26:40.391524+08:00

## Primary source
- Game: Dota 2 (Steam app 570)
- Official store page: https://store.steampowered.com/app/570/Dota_2/
- Screenshot list API: https://store.steampowered.com/api/appdetails?appids=570&filters=screenshots
- Publisher/rights holder: Valve Corporation
- Images are Valve/Steam CDN store screenshots published on the official store page.

## Candidates prepared for Kimi (HUD-cropped derivatives of store screenshots)
| File | From store screenshot | Crop intent | Bytes |
|---|---|---|---|
| candidate-radiant-shop.jpg | ss02 | Radiant secret shop / trees / stone steps (day) | ~297KB |
| candidate-radiant-fountain.jpg | ss03 | Radiant fountain / cobble / pink trees | ~288KB |
| candidate-lane-forest.jpg | ss06 | Lane forest / river-adjacent trees | ~247KB |

Full original URLs are in SOURCE_META.json.

## Selected homepage derivative (t292u)
- Candidate: `candidate-radiant-shop.jpg` (official store screenshot `ss02`).
- Original: https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/570/ss_c9118375a2400278590f29a3537769c986ef6e39.1920x1080.jpg?t=1791407503 (1,500,992 bytes).
- Shipped asset: `public/home-scene/radiant-shop.jpg` — 1030×810, 188,307 bytes; cropped from the prepared candidate to remove the right-side combatants and bottom HUD, then optimized as progressive JPEG.
- Used only as an `aria-hidden`, warm-white-masked decorative background. Not current-patch tactical map evidence; no generated imagery, fake Valve logo, or endorsement claim.

## Usage / conditions (recorded, no license assumed)
- Steam Subscriber Agreement § Fan Art: Valve allows incorporating Valve game content into Fan Art on a **non-commercial** basis; site is free match review with no billing UI. We do **not** claim a grant for redistributing raw game assets.
- Steam Video Policy: encourages using game content in videos; discourages distributing game assets separately. Decorative homepage background on a free fan tool is **not** clearly blessed; treat as attributable fan display of publicly posted store screenshots; do not imply Valve endorsement; do not use fake official logos.
- Archived Valve trademark guidelines (Dota Marks) mainly govern map/mod naming — not directly a screenshot-decor ban.
- If a clearer prohibition for this decorative use appears later, remove the asset.

## Explicit non-goals
- Not a current-patch tactical map evidence plate.
- Not generated AI art.
- Not private/credentialed assets.
