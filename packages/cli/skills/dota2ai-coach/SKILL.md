---
name: dota2ai-coach
description: Coach a player on their own public Dota 2 games with dota2.ai — find their recent games, explain why a game went the way it did (lane, deaths, items, fights, each cause with replay evidence and what to do), compare with pro games on the same problem, answer follow-up questions, and set and check a next-game training goal. Use when someone asks to review a Dota 2 match, why they lost, what to practise, or how their last game went.
---

# dota2ai coach

The dota2.ai coach reads a public match (OpenDota data, replay-parsed when
available) and explains it with numbers from that match only. You relay and
organise what it says; you do not add Dota knowledge of your own.

Needs shell + Node >= 20.10 and this repository checkout (`npm ci` once), or
the packed `dota2ai` tarball. No keys. All commands accept `--lang en|zh`
(follow the user's language) and `--json` (stable output — prefer it when
you will reason over the result).

```sh
node packages/cli/bin/dota2ai.js help
```

## Commands

| Need | Command |
|---|---|
| The player's recent games | `dota2ai recent <friend code or profile link> --json` |
| One game, summary | `dota2ai coach <matchId> --hero <hero> --json` |
| Why it went this way | `dota2ai coach <matchId> --hero <hero> --section why --json` |
| One chapter | `--section lane` / `deaths` / `items` / `fights` / `plan` |
| Pro games on the same problem | `dota2ai cases <matchId> --hero <hero> --json` |
| A follow-up question | `dota2ai ask <matchId> --hero <hero> "question" --json` |
| Next-game goal | `dota2ai goal set <matchId> --hero <hero>` · `goal show` · `goal check [matchId]` |
| Hero vs hero (pro games, no match needed) | `dota2ai matchup <hero> <vs> --json` |
| Same, at the player's rank (public games, STRATZ) | `dota2ai matchup <hero> <vs> --rank <hg\|ca\|la\|di\|medal> --json` |

`<hero>`: slug (`tidehunter`), English or Chinese name, or hero id. Without
`--hero`, `coach` returns the roster: ask the user which hero was theirs —
never guess. A friend code is the number in Dota 2's friends tab; Steam
`/id/name` links cannot be resolved (ask for the friend code instead).

Exit codes: `0` ok · `2` invalid input (wrong hero, bad id) · `3` not found or
no data yet (private profile, match not parsed) · `4` upstream failure (retry
later; say so).

With the MCP server instead of a shell (`packages/mcp`, stdio), the same
calls are tools: `recent_matches`, `coach_report` (`section`), `coach_cases`,
`coach_ask`, `goal_check` (pass the finding's `goal` object; keep it yourself
between sessions), `hero_matchup` (`hero`, `vs`, optional `rank`).

## Reading the review

- `--section why` returns causes, the player's own first (`mine: true`), each
  with `title`, `evidence[]` and `fix` (what to do). Quote evidence as given;
  the numbers are the claim. A cause without `fix` is context, not advice.
- Evidence states its own scope — keep it: "whole game" vs "before 10:00",
  "pregame to 10:00" (position samples), "Valve data, 7.42" (cooldowns may be
  from a newer patch than the match), "OpenDota pro matches, <date>".
- `match.parsed: false` or non-empty `data_gaps`: the replay is not parsed;
  only a basic review exists. List the gaps and point to
  `https://dota2.ai/r/<matchId>` to request a parse. Missing evidence is not
  evidence of a mistake.
- `cases`: one game that avoided the problem and one that repeated it, chosen
  by the stated criteria. They show what went with winning, not proof of cause.
- `ask` answers only from the report; `fallback: true` means no AI was
  available and the answer is the matching part of the report.

## Workflows

**"Review my last game"**: `recent <account> --json` → take the newest
`match_id` and its `slot`/hero → `coach <id> --hero <hero> --section summary --json`
→ tell the user the three causes (theirs first) with one piece of evidence
each, and the one thing to practise → offer `goal set`.

**"Why did I lose?"**: `coach … --section why --json` → group by phase
(early/mid) → for each cause on them: what happened (evidence) → what to do
(fix). Then offer `cases` to see a pro game on the same problem.

**"How do I play against X?" / "Is this a bad matchup?"**: `matchup <their hero>
<X> --json` (add `--rank` with their medal when you know it: `by_rank` is public
games at that bracket, say "data: STRATZ" and the game count) → lead with the lane verdict and the win-rate verdict *with their
game counts* (`null` = too few pro games: say so, do not guess), then the
items pros on their hero build more often against X (`your_items_vs_them`:
"pros do this more often", never "this wins"), then the Valve facts about X's
abilities that change the plan (damage type, goes through spell immunity).

**"Did I do what I practised?"**: `goal check` (uses the account saved with
the goal; else `goal check <matchId> --hero <hero>`) → report `met`, `missed`,
`no_opportunity` or `unknown` with its evidence.

## Never

- Invent numbers, timings, items, hero or ability facts not in the output.
- Present a cause as certain when the output frames it as a comparison or an
  association; keep "most pros" as "most pros", not "always".
- Review a private match or guess whose account a game belongs to.

Share links: `https://dota2.ai/r/<matchId>?p=<slot>` (add `&lang=zh`).
