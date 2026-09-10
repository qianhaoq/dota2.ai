# 英雄图鉴搜索

英雄图鉴 is the knowledge workspace. A user searches by 中文 name, English name, or alias and opens a hero. Missing fields stay empty; the page must not invent patch numbers.

## Sub-features

- `codex-open` opens 英雄图鉴 from nav or `#knowledge`.
- `codex-search-alias` filters the grid for alias `剑圣` (主宰 / Juggernaut).
- `codex-empty` shows `未找到匹配的英雄` and `清除筛选` for a nonsense query.
- `codex-attr` filters with `全部` / `力量` / `敏捷` / `智力` / `全能`.
- `codex-detail` opens a hero tile and returns with `返回列表`.

## How to get to it (user POV)

- Choose `英雄图鉴` in `主导航` or `移动端导航`.
- Follow `#knowledge`.
- After English toggle the nav label is `Hero Codex` and the search placeholder is `Search hero name or alias...`.

## Driving it with verify-dota2-ai

Preconditions:

- Doctor reports `ok: true`.
- Language is 中文.
- DeepSeek is not required. `/api/meta/heroes` or the OpenDota `heroStats` fallback must be reachable.
- Chrome profile is disposable; no prior query.

- **Open.** Run `verify-dota2-ai drive hero-codex-search`. The helper navigates `{uiOrigin}/#knowledge`. Copy `资料应该回答“怎么用”，不只回答“是多少”。` and `HERO CODEX / 英雄图鉴` appear.
- **Wait for the field.** Placeholder `搜索英雄名称或别名...` is present. If `Loading heroes...` stays more than 45s, fail and report the meta API / OpenDota miss.
- **Alias search.** Fill that placeholder with `剑圣`. The grid includes `主宰` or `Juggernaut` (alias list in `src/data/heroNamesCn.ts` id 8). It does not show the full unfiltered catalog.
- **Empty (optional extra).** Replace the query with `zzzz-no-hero`. `未找到匹配的英雄` appears. Choose `清除筛选` to restore the list.
- **Proof.** `after.png` and `page.txt` show the codex heading and a 剑圣 match. Record whether names came through as 中文 (`主宰`) or OpenDota English fallback.

## Gotchas

- The search `<input>` has **no** `aria-label`. Drive it by placeholder, not by role name.
- Hero tiles often have no accessible name beyond the rendered name. Click the visible `主宰` / `Juggernaut` text, not a CSS grid index.
- `/api/meta/heroes` needs Express. If you opened a Vite URL while Express is down, the client falls back to `https://api.opendota.com/api/heroStats` (English `localized_name`).
- Attribute chips `力量` / `敏捷` / `智力` / `全能` hide their labels below `sm`. At 1280px they are visible.
- Do not invent lore or skill numbers when a detail field says it has no data.
