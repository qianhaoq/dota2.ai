---
applyTo: "src/**/*.{ts,tsx,css}"
---

# Frontend (`src/`)

- React 18 function components + TypeScript; follow the existing styles (`src/agent/agent.css`, `src/coach/*.css`, Tailwind utilities in `src/index.css`).
- The match page is `src/agent` (review document, evidence cards, scoreboard, chat); home and player pages are `src/coach`. Prefer updating these over new top-level pages unless the task asks for one.
- UI copy is bilingual (English default, Chinese via toggle), kept in per-file `T` tables; model output follows the UI language.
- The page shows what the server verified. Do not add text about the game that is not in the review or an evidence record.
- A page test that waits on a parse or a review must be run with a timeout: a mock that never finishes makes the page poll forever.
- Do not introduce a new CSS framework or state library without an explicit request.
