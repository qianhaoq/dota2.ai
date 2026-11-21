# dota2.ai redesign: cards from the engine (`dota-coach-ui/2`)

Direction (2026-11-21): every page, the **engine outputs cards**, dark battlefield minimal.

## Protocol

`lib/coach/cards.js` turns one player's coach report into an ordered list of
whitelisted cards. It is pure and deterministic, and is shared by server and browser.

- `GET /api/coach/:matchId/cards?seat=0-9[&slot=&pos=]` returns `{ catalog: 'dota-coach-ui/2', engine, match_id, slot, cards }`.
- A card has these fields:
  - `id`: stable within the report.
  - `component`: one of `COMPONENTS`.
  - `title`: `{en, zh}`.
  - `authority`: `fact` (match data), `inference` (engine rules) or `statistic` (population numbers, which show association, not cause).
  - `tone`: `good`, `fix` or `neutral`.
  - `data`, `actions`, `evidence`.
- Actions are whitelisted, and each one's arguments are checked:
  - `inspect {target}`
  - `ask {question}`
  - `save_goal {goal}`
  - `parse`
  - `compare {hero, vs}`
  - `open_cases {theme}`
- `validateSurface` treats every source (engine, cache, network, LLM) as untrusted:
  - a wrong catalog is rejected;
  - unknown components and authorities, bad titles and non-object data are dropped;
  - unknown or malformed actions are dropped, but the card is kept.
- It extends the internal `dota-coach-ui/1` catalog (`src/coach-ui`, used by `/new`). It is still not the official A2UI wire protocol.

## Plan (one PR each)

1. **Protocol.** Engine cards, validator, `/cards` route and tests. No UI change. (This PR.)
2. **Look and renderer.** Dark battlefield design tokens:
   - near-black slate background;
   - Radiant green and Dire red as the only two team colours;
   - gold for emphasis;
   - thin edged cards and large hero portraits.

   Card primitives and a registry renderer (`component` → React). `/r/:id` is rebuilt from the surface, and actions are wired: `inspect` opens the card's detail, `ask` fills the chat, `save_goal` uses goalStore, `parse` uses requestParse, `compare` opens the matchup brief.
3. **Home `/` and player `/p/:id`** as cards: recent matches, player summary and active goal.
4. **Ask coach returns cards.** The LLM may reference only existing card ids or emit validated cards, never free markup.
5. **`/new` on the same tokens and cards; `/legacy`** reskinned with the tokens.

Hero and item art stays on the official Steam CDN. Nothing copies Valve's site designs or logos.
