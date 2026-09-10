---
name: verify-dota2-ai
description: Drive the Dota2.ai Tactical Coach V3 web UI (React + Vite on :5173, Express on :8080) the way a user does. Use when proving 战术室 / 英雄修炼 / 英雄图鉴 / 战术笔记 navigation, review intake, journal save, or language toggle in a real browser — not vitest.
---

# Verify Dota2.ai Tactical Coach V3

Agent-facing control skill for the **web UI** (primary surface). HTTP APIs (`/health`, `/api/health`, `/api/analyze`, `/api/review/:matchId`, `/api/playbook`) exist behind the same Express process; drive them only as supporting checks, never as a substitute for the user path.

The UI defaults to **中文**. Visible strings and `aria-label` values below are copied from `src/`. Do not invent selectors. Desktop nav is `hidden md:flex` — drive at **1280×800** so `主导航` is visible (`移动端导航` is `md:hidden`).

No Playwright/Cypress harness lives in this repo. The shipped helper talks **Chrome DevTools Protocol** (Chrome is on the Cursor cloud image). If Chrome is missing, use the Cursor `computerUse` browser with the same roles/names — never coordinates.

## Interview (what this skill is built on)

| Question | Finding |
|---|---|
| Surface | Web UI first. Secondary: unauthenticated JSON/SSE under `/api/*`. |
| Run | `npm ci` then `npm run start:dev` (Vite `http://127.0.0.1:5173` + Express `8080`). `server.js` reads `process.env` only — it does **not** load `.env` itself. The helper sources repo `.env` into the child env. |
| Drive | CDP helper below. Stable handles: `aria-label`, `role=tab` / `role=button`, visible 中文, hash `#tactical` `#training` `#knowledge` `#journal`. |
| Observe | PNG screenshots, `Accessibility.getFullAXTree` dump, `document.body.innerText`, `/health` JSON. |
| Isolate | Dev mode **cannot** share `:5173` / `:8080`. If those ports are already taken, **refuse** — do not attach to a user's session. Side-by-side: `VERIFY_MODE=prod VERIFY_API_PORT=<free>` after `npm run build` (single Express serving `dist`). Vite's `/api` proxy is hardcoded to `localhost:8080`, so isolated prod mode is the only safe second instance. |

`DEEPSEEK_API_KEY` is required for live SSE (`/api/analyze`, `/api/review/:id` POST, `/api/chat`, `/api/playbook`). Without it Express still boots, logs a warning, `/api/health.apiKeyConfigured` is `false`, and those routes return `Server API Key not configured`. **Shell, nav, review intake UI, hero codex search, training drill, journal, and language toggle do not need the key.** Do not pretend a stream succeeded when the key is missing.

## Launch

From the repo root, after `npm ci`:

```bash
.cursor/skills/verify-dota2-ai/bin/verify-dota2-ai launch
```

What it starts (same processes as `npm run start:dev`, split so teardown owns PIDs):

- `HOST=127.0.0.1 PORT=8080 node server.js`
- `node_modules/.bin/vite --host 127.0.0.1 --port 5173 --strictPort`

Ready when:

1. `GET http://127.0.0.1:8080/health` → `{ "status": "healthy" }` (Express also prints `Server is running on http://127.0.0.1:8080`).
2. `GET http://127.0.0.1:5173/` → HTML with `<title>Dota2.ai - Tactical Assistant</title>` and `#root`.

State file: `.cursor/skills/verify-dota2-ai/.run/state.json` (gitignored). Logs: `.run/express.log`, `.run/vite.log`.

Isolated second instance (does not use Vite):

```bash
VERIFY_MODE=prod VERIFY_API_PORT=18080 .cursor/skills/verify-dota2-ai/bin/verify-dota2-ai launch
```

UI and API then share `http://127.0.0.1:18080`.

Teardown is **Cleanup**, not `pkill node`.

## Doctor

Read-only. Run this first whenever anything looks off:

```bash
.cursor/skills/verify-dota2-ai/bin/verify-dota2-ai doctor
```

Pass only if every check holds:

- `.run/state.json` exists and every recorded PID (`express`, and `vite` in dev) is alive.
- `GET {apiOrigin}/health` is `200` and `status=healthy`.
- `GET {apiOrigin}/api/health` is `200`. Record `apiKeyConfigured` (do not fail the doctor when it is `false`).
- `GET {uiOrigin}/` is `200` and the title is `Dota2.ai - Tactical Assistant`.
- Chrome path is reported (`CHROME_PATH` or `/usr/bin/google-chrome`) so a later drive can use CDP.

If doctor fails, stop. Do not click a UI you did not launch.

## Drive

```bash
.cursor/skills/verify-dota2-ai/bin/verify-dota2-ai drive --list
.cursor/skills/verify-dota2-ai/bin/verify-dota2-ai drive tactical-room-entry
```

Recipes live in `features/`. The helper launches headless Chrome at 1280×800, navigates `{uiOrigin}/`, and resolves controls by **role + accessible name**, **placeholder**, or **visible 中文 substring** — never x/y.

Handles taken from source (zh default):

| Control | Handle |
|---|---|
| Brand | `role=button` `aria-label="DOTA2.AI"` |
| Desktop nav | `role=navigation` `aria-label="主导航"` |
| 战术室 / 英雄修炼 / 英雄图鉴 / 战术笔记 | `role=button` name equals that label (`aria-current="page"` when active) |
| Language | `role=button` `aria-label="Switch language"` (visible `中`). After toggle: `aria-label="切换语言"` (visible `EN`) |
| Tactical workspaces | `role=tablist` `aria-label="战术室工作区"` ; tabs `入口` `复盘` `阵容` `装备` |
| Motive cards | buttons whose accessible name **contains** `刚打完，复盘一局` / `准备开局，推演阵容` / `想变强，练一次判断` (no `aria-label`; name includes the subtitle) |
| Review intake | heading `先还原你当时掌握的信息。` ; button `复盘一局` ; placeholder `8985182860 或 opendota.com/matches/...` ; submit `拉取比赛` |
| Codex search | hash `#knowledge` ; placeholder `搜索英雄名称或别名...` |
| Journal | hash `#journal` ; empty copy `还没有保存的动作。` |
| Deep links | `#tactical` `#training` `#knowledge` `#journal` |

Cursor `computerUse` fallback (same handles, still 1280px wide): open `{uiOrigin}`, click the named buttons, assert the same 中文, screenshot into `evidence/<feature>/<runId>/`.

Do not start DeepSeek SSE unless `/api/health.apiKeyConfigured` is true and the mapped feature says so.

## Evidence

Proofs go to `.cursor/skills/verify-dota2-ai/evidence/<feature-id>/<runId>/` (gitignored):

- `landing.png` / `after.png` — action **and** resulting state, not only the last frame
- `page.txt` — `document.body.innerText`
- `aria.txt` — full AX tree
- `meta.json` — feature id, origins, `apiKeyConfigured`, observed steps

`evidence/LAST_RUN.txt` points at the latest directory.

Proof standards:

- Exercise the real user path (nav click or documented hash). Do not poke `journalStore` or call test-only endpoints to fake a saved note.
- Capture the click and the new workspace copy.
- Side effects: a journal save must later appear under 战术笔记 (localStorage key `dota-v3-tactical-notes` in **this** Chrome profile). Cleanup may wipe the ephemeral Chrome profile; the evidence files stay.
- Mocks only at production boundaries that already exist: missing `DEEPSEEK_API_KEY` is a real server branch (`apiKeyConfigured: false`), not a test double. OpenDota/Steam remain live network calls for hero lists and match facts.
- Never treat “dry-run” as safe without observing files/network. This app has no dry-run flag.

## Cleanup

```bash
.cursor/skills/verify-dota2-ai/bin/verify-dota2-ai cleanup
```

Kills **only** PIDs recorded in `.run/state.json` (`express`, `vite`, `chrome`), deletes `.run/` and the ephemeral Chrome user-data dir, and **does not** delete `evidence/`. After cleanup, `evidence/LAST_RUN.txt` and the PNG/txt/json under that path must still exist. Never `pkill -f vite` / `pkill node`.

## Helpers

All invocations are from the repo root. `bin/verify-dota2-ai` is executable and execs `lib/cli.mjs`.

```bash
# 1. start an instance we own
.cursor/skills/verify-dota2-ai/bin/verify-dota2-ai launch

# 2. read-only health
.cursor/skills/verify-dota2-ai/bin/verify-dota2-ai doctor

# 3. drive one mapped feature (tactical-room-entry needs no DeepSeek key)
.cursor/skills/verify-dota2-ai/bin/verify-dota2-ai drive tactical-room-entry

# 4. tear down processes we started; keep proofs
.cursor/skills/verify-dota2-ai/bin/verify-dota2-ai cleanup

# 5. confirm evidence survived
test -f .cursor/skills/verify-dota2-ai/evidence/LAST_RUN.txt
ls "$(cat .cursor/skills/verify-dota2-ai/evidence/LAST_RUN.txt)"
```

Optional: `VERIFY_MODE=prod VERIFY_API_PORT=18080`, `VERIFY_CDP_PORT=9333`, `CHROME_PATH=/usr/bin/google-chrome`.

Feature map: [`features/README.md`](features/README.md). Keep it honest with `/maintain-verification-skill` when the UI changes.
