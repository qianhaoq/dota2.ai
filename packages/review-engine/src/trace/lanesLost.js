/**
 * A game lost from the lanes: the team was far behind when the lanes ended and never led again.
 *
 * Where a lost game went is either a fight it turned on (turningFight.js) or the lanes. In a game lost from the
 * lanes there is no later moment to point at: every fight after 10:00 was entered behind. For such a game the
 * first thing to change is what happened before 10:00 — and for any other game the early deaths, however many
 * came first, are not where it was lost.
 *
 * Read off the gold lead, told from the team's side, and only a lead that is gold earned (the match record's,
 * or the replay's combat log summed): the replay's net worth graph is 2,900 off on average, more than the
 * threshold here.
 *
 * Calibrated on the 32 parsed games of the corpus (64 sides, gold earned for all), 2026-11-25:
 * - 13 sides were 2,000 or more behind at 10:00; 11 of them lost;
 * - 8 of the 13 never led in any later minute (the closest any came: 2,187 behind), and all 8 lost. The other 5
 *   led again (by 425 to 15,484); 2 of those won;
 * - of the 8: the turning-fight rule names no fight for 5, and for 3 a fight before 10:30 — none has a later turn;
 * - on those 8 sides, 7 of the 40 heroes died four times or more before 10:00 (16 three times or more); on the
 *   other 24 losing sides, 7 of 120. Over all 320 heroes: 27 (8.4%) died four times or more before 10:00.
 */

/** The lanes are over at this game second. */
export const LANES_END = 600;
/** A team this far behind when the lanes end is losing (turningFight.js's STILL_IN_IT says the same of a fight). */
export const BEHIND_AFTER_LANES = -2000;
/** A hero who died this often before the lanes ended had a lane that went badly: 8.4% of the corpus's heroes. */
export const MANY_EARLY_DEATHS = 4;
/** The rule, as match_overview states it beside the answer. */
export const LANES_RULE = `my_team ${-BEHIND_AFTER_LANES} gold or more behind at 10:00, and not ahead in any minute after`;
/** Gold-lead sources this is read from: gold earned. */
const EARNED = new Set(['match_record', 'replay_gold_log']);

/**
 * @param {number[] | null | undefined} lead  the team's own gold lead per game minute (negative: behind)
 * @param {{ source?: string | null }} [o]  what the lead was read from (goldLead's source)
 * @returns {{ lost_from_the_lanes: boolean, my_team_gold_lead_at_10: number, my_team_best_gold_lead_after: number } | { unknown: 'no_gold_lead' | 'gold_lead_is_not_gold_earned' | 'gold_lead_stops_before_the_lanes_end' | 'gold_lead_has_a_minute_missing' }}
 *   unknown is "not known", never "no": a lead with a minute missing may have been ahead in that minute.
 */
export function lostFromTheLanes(lead, { source = null } = {}) {
  if (!Array.isArray(lead) || !lead.length) return { unknown: 'no_gold_lead' };
  // The net worth graph, or a lead whose source is not stated: not read.
  if (!EARNED.has(source)) return { unknown: 'gold_lead_is_not_gold_earned' };
  const m = LANES_END / 60;
  // The lead at 10:00 and at least one minute after it: a game over by then has no "after the lanes".
  if (lead.length <= m + 1) return { unknown: 'gold_lead_stops_before_the_lanes_end' };
  const after = lead.slice(m + 1);
  if (!Number.isFinite(lead[m]) || after.some((v) => !Number.isFinite(v))) return { unknown: 'gold_lead_has_a_minute_missing' };
  const best = Math.max(...after);
  // "Not ahead": level is not ahead.
  return { lost_from_the_lanes: lead[m] <= BEHIND_AFTER_LANES && best <= 0, my_team_gold_lead_at_10: lead[m], my_team_best_gold_lead_after: best };
}
