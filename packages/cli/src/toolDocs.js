/**
 * What an agent is told about each dota2.ai coach tool: one text for every
 * surface that offers them (the MCP server in @dota2ai/mcp, the DSH plugin in
 * packages/dsh), so the descriptions cannot drift apart. Schemas stay with
 * each surface (zod for MCP, the dsh-tools DSL for DSH); the words live here.
 */
export const TOOL_DOCS = {
  replay_review: {
    description: "dota2.ai's main review: the coach watches this game's replay (every death, ultimate, fight and item) and writes what one player could have changed, each point backed by replay evidence (times, numbers) that was checked, plus what they did well, what to do next game, and what the replay cannot show. Needs the hero the user played (pick_hero lists the game's heroes). A first review takes 2–4 minutes: while status is parsing or reviewing, call again with the same arguments after poll_after_sec. Starts are limited per caller (about five reviews per ten minutes). Replays exist for about two weeks after a game. lang: en | zh.",
    params: {
      hero: 'The hero the user played: key (queen_of_pain), English or Chinese name, or hero id',
      retry: 'Start again after status failed (a new start, counted on the limit)',
    },
  },
  recent_matches: {
    description: "A player's recent public Dota 2 games (match_id, hero, seat, K/D/A, won). account: Steam friend code or a Steam/OpenDota/Dotabuff/STRATZ profile link.",
    params: {},
  },
  coach_report: {
    description: 'The dota2.ai coach review of one player in a match. Without hero: the roster (ask the user which hero). section: summary (default: the causes that decided the game, the player\'s first; what to practise; findings) | why (every cause with evidence and fix) | lane | deaths | items | fights | plan | all.',
    params: {},
  },
  coach_cases: {
    description: 'Professional games on the same problem as this player: one that avoided it, one that repeated it, with the numbers compared. Parsed matches only.',
    params: {},
  },
  coach_ask: {
    description: 'A follow-up question about this player\'s review, answered only from the report. fallback=true means no AI was available and the answer is the matching part of the report.',
    params: {},
  },
  goal_check: {
    description: "Judge a later game against a training goal: met | missed | no_opportunity | unknown, with evidence. goal: a finding's `goal` object from coach_report (section all). Only check the goal owner's own games.",
    params: {},
  },
  hero_matchup: {
    description: 'Hero vs hero from professional games, no match needed: pro win rate and lane gold at 10:00 (verdict only when the gap is real, always with the sample size), the finished items pros on each side build clearly more often against the other, and Valve data on the other hero\'s abilities (damage type, goes through spell immunity). `by_rank`: the same pair in public games per rank bracket (hg Herald–Guardian, ca Crusader–Archon, la Legend–Ancient, di Divine–Immortal) from STRATZ: win rate and same-lane won/even/lost; credit STRATZ (`rank_source.attribution`) when you quote it. `lines` has the same in plain English and Chinese (rank lines only for the `rank` asked). hero / vs: id, slug, English or Chinese name.',
    params: {
      rank: 'Rank bracket: hg | ca | la | di, a medal name (e.g. legend) or an OpenDota rank_tier (e.g. 54)',
    },
  },
};

/** The coach tools in the order they are offered. */
export const COACH_TOOLS = ['recent_matches', 'coach_report', 'coach_cases', 'coach_ask', 'goal_check', 'hero_matchup'];
