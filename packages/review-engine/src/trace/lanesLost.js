/**
 * A game lost from the lanes: the team was far behind when the lanes ended and stayed that far behind.
 *
 * Where a lost game went is either a fight it turned on (turningFight.js) or the lanes. In a game lost from the
 * lanes there is no later moment to point at: every fight after 10:00 was entered already losing. For such a game
 * the first thing to change is what happened before 10:00 — and for any other game the early deaths, however many
 * came first, are not where it was lost.
 *
 * "Far behind" is turningFight.js's own line (STILL_IN_IT): a team further behind than that is not "still in it",
 * so the turning-fight rule cannot name a fight from 10:00 on in a game lost from the lanes. The two never
 * disagree: a game that came back within 2,000 and then lost a fight is not lost from the lanes.
 *
 * Read off the gold lead, told from the team's side, and only a lead that is gold earned (the match record's, or
 * the replay's combat log summed): the replay's net worth graph is 2,900 off on average, more than the line. And
 * only a lead that reaches the minute the game ended in: a series that stops early does not know whether the team
 * came back after it.
 *
 * Calibrated on the 32 parsed games of the corpus (64 sides, gold earned for all), 2026-11-25:
 * - 13 sides were 2,000 or more behind at 10:00; 11 of them lost;
 * - 8 stayed more than 2,000 behind in every minute from 10:00 on (the closest any came: 2,187), and all 8 lost.
 *   The other 5 led again (by 425 to 15,484); 2 of those won. ("Never ahead after" picks the same 8.)
 * - of the 8: the turning-fight rule names no fight for 5, and for 3 a fight before 10:30;
 * - on those 8 sides, 7 of the 40 heroes died four times or more before 10:00 (16 three times or more); on the
 *   other 24 losing sides, 7 of 120. Over all 320 heroes: 27 (8.4%) died four times or more before 10:00;
 * - every gold series of the corpus (17 match records, 15 summed from the log) reaches the minute the Ancient fell in.
 */
import { STILL_IN_IT } from './turningFight.js';

/** The lanes are over at this game second. */
export const LANES_END = 600;
/** Further behind than this is not "still in it" (turningFight.js). */
export const BEHIND_AFTER_LANES = STILL_IN_IT;
/** A hero who died this often before the lanes ended had a lane that went badly: 8.4% of the corpus's heroes. */
export const MANY_EARLY_DEATHS = 4;
/** The rule, as match_overview states it beside the answer. */
export const LANES_RULE = `gold-curve indicator (not a draft or cause verdict — scaling lineups can trail by >${-BEHIND_AFTER_LANES} at 10:00 without losing the game in lane): my_team more than ${-BEHIND_AFTER_LANES} gold behind at 10:00 and in every minute after, to the end of the game`;
/** Gold-lead sources this is read from: gold earned. */
const EARNED = new Set(['match_record', 'replay_gold_log']);

/**
 * @param {number[] | null | undefined} lead  the team's own gold lead per game minute (negative: behind)
 * @param {{ source?: string | null, end?: number | null }} [o]  what the lead was read from (goldLead's source), and
 *   the game second the game ended (the Ancient's fall)
 * @returns {{ lost_from_the_lanes: boolean, my_team_gold_lead_at_10: number, my_team_best_gold_lead_after: number } | { unknown: 'no_gold_lead' | 'gold_lead_is_not_gold_earned' | 'game_end_not_known' | 'game_ended_before_the_lanes_did' | 'gold_lead_stops_before_the_game_ended' | 'gold_lead_has_a_minute_missing' }}
 *   unknown is "not known", never "no": a minute missing may be the minute they came back in.
 */
export function lostFromTheLanes(lead, { source = null, end = null } = {}) {
  if (!Array.isArray(lead) || !lead.length) return { unknown: 'no_gold_lead' };
  // The net worth graph, or a lead whose source is not stated: not read.
  if (!EARNED.has(source)) return { unknown: 'gold_lead_is_not_gold_earned' };
  if (!Number.isFinite(end) || end <= 0) return { unknown: 'game_end_not_known' };
  const m = LANES_END / 60; const last = Math.floor(end / 60);
  // A game over by 10:00 has no "after the lanes".
  if (last <= m) return { unknown: 'game_ended_before_the_lanes_did' };
  if (lead.length - 1 < last) return { unknown: 'gold_lead_stops_before_the_game_ended' };
  const from10 = lead.slice(m, last + 1);
  if (from10.some((v) => !Number.isFinite(v))) return { unknown: 'gold_lead_has_a_minute_missing' };
  const after = from10.slice(1);
  return { lost_from_the_lanes: from10.every((v) => v < BEHIND_AFTER_LANES), my_team_gold_lead_at_10: lead[m], my_team_best_gold_lead_after: Math.max(...after) };
}
