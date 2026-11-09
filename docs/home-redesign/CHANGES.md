# Home redesign changes

## Real Dota scene follow-up (2026-11-09)

### 对比说明

- **移除抽象地图**：根据 t292u 反馈，删除上一版整页三条白色边路 / 河道 / 基地线框（`HomeGround`）以及示例卡内的同款几何（`MapMotif`），不是在线框上继续换色或调渐变。
- **真实 Dota 环境**：选用官方 Steam 商店截图 `ss02` 的天辉商店、树林与石阶场景，裁掉右侧战斗角色和底部 HUD。桌面以暖白径向遮罩让标题与 Match ID 输入保持清晰，四周仍能辨认商店棚子、火把、树木与石阶；手机使用更紧的商店局部构图和稍强的暖白遮罩。
- **内容保持不变**：仍只有短标题、Match ID 表单、一条信任说明和真实示例 `9035042364` 阵容；EN/ZH 文案、输入解析和示例跳转均未改变。场景只是装饰，不作为当前版本战术地图证据。

### Source and implementation

- Official page: https://store.steampowered.com/app/570/Dota_2/
- Original `ss02` (1,500,992 bytes): https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/570/ss_c9118375a2400278590f29a3537769c986ef6e39.1920x1080.jpg?t=1791407503
- Prepared HUD-cropped candidate `candidate-radiant-shop.jpg`: 297,114 bytes. Selected derivative: `public/home-scene/radiant-shop.jpg`, 1030×810 JPEG, **188,307 bytes**. No AI-generated imagery or Valve endorsement is implied.
- `EmptyState.tsx` now has one `aria-hidden` scene layer; all large map SVG geometry and its responsive rules are removed. The existing focus rings, restrained hover states, and global reduced-motion behavior remain unchanged.
- Refreshed desktop, mobile EN, and mobile ZH screenshots in `docs/home-redesign/shots/`.

## Composition follow-up (2026-11-09)

### 对比说明

- **视觉中心**：上一版桌面是左侧文案、右侧小卡片，四周留白缺少层次。本版改为居中的短标题与输入框，下方用最大宽度 1040px 的真实比赛阵容作为唯一大型视觉锚点。这个机制来自 `refs/orior-recent.png` 的单一主体构图和 `refs/pirsch-landbook.webp` 的产品预览承载视觉重量，而不是增加营销文案。
- **背景与分区**：上一版主要是平坦象牙色，示例卡内只有很淡的小地图符号。本版新增整段 SVG `HomeGround`：柔和的天辉绿 / 夜魇红斜向分区、三条边路、中路、河道与基地菱形；示例卡沿用同一套几何语言。分区方式参考 `refs/stratz-home.png`，但降低饱和度并保留暖纸底色，没有复制其青色大屏或登录中心。
- **文本密度**：保留上一版已经精简的全部文案——标题、Match ID 表单、一条信任说明和示例入口；EN/ZH 字典均未增加内容。没有恢复介绍段落、01/02/03 列表、功能三栏或营销卡，也没有添加胜率、结论等虚构数据。
- **响应式重构**：桌面示例按天辉 / 夜魇左右分区，每侧五个真实英雄采用 3+2 阵列，强化尺度与对阵关系；≤820px 改为上下两队、每队五个肖像，并将示例背景改成上下色区，避免把桌面双栏机械压缩到手机。
- **参考边界**：也查看了 `refs/` 内其余图片。STRATZ/OpenDota/Bladeform 仅用于品牌与 Dota 线索；Katana/Stykka 等仅作纹理对照，未采用其高饱和纹理或暗色主题。`dota2-coach-og.png` 只作为静态 OG 图查看，没有据此声称观察过其完整页面。

### Implementation

- `EmptyState.tsx` adds CSS/SVG-only ground and sample-map geometry; all decorative SVGs are `aria-hidden`. The actual `9035042364` roster, Steam CDN portraits, shared match parser, and sample navigation are unchanged.
- `EmptyState.css` centers the hero, enlarges the sample tableau, adds restrained warm shadows, and recomposes both the roster and geometry at tablet/mobile breakpoints. No motion was added; the existing reduced-motion rule and keyboard focus rings remain in force.
- Refreshed desktop, mobile EN, and mobile ZH screenshots in `docs/home-redesign/shots/`.

## Previous: warm-paper redesign

- Replaced the dark bunker palette with warm ivory/paper surfaces, dark warm ink, aged-gold accents, and a restrained Dire-rust primary action. The shared v2 tokens keep `/m/:id` visually consistent.
- Moved the Match ID input from the empty page's bottom bar into a prominent hero form with a visible label, disabled empty state, and accessible invalid-input error. It reuses `Composer` and `parseMatchInput`; review loading and errors remain on `MatchPage`.
- Added one clearly labeled example using the real OpenDota sample match `9035042364`: its actual Radiant/Dire roster from the checked-in fixture and Steam CDN hero portraits. No sample conclusions or invented metrics are shown.

## Slim copy follow-up (2026-11-09)

- Reduced the first fold to one short title, the Match ID form, and one small `Free · OpenDota data · No guessing` line. Removed the eyebrow, introductory paragraph, and supported-links helper.
- Reduced the sample card to its real Radiant/Dire portraits, side marks, subtle map motif, and `Sample · 9035042364` action. Removed the example heading, explanatory note, three-part review list, and duplicated source links.
- Applied the same concise copy to English and Chinese, removed obsolete dictionary entries, and refreshed desktop/mobile screenshots.

## Verification

- `npm test` — 101 files, 1457 tests passed.
- `npx tsc --noEmit` — passed.
- `npm run build` — passed (existing chunk-size warning only).
- Desktop/mobile Chromium smoke checks — all ten hero portraits loaded; invalid input, Match ID navigation, sample navigation, and Chinese home passed; no page errors or horizontal overflow at 320, 390, 768, 1024, or 1440px.
- axe WCAG A/AA checks at 390 and 1440px — no violations.
