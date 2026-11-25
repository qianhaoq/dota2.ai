/**
 * The fight a lost game turned on.
 *
 * Read off the gold lead around each fight: of the fights the team lost more heroes in, entered while it was
 * still in the game, the one after which its lead fell the most — when that fall is large enough. A team already
 * far behind loses more gold in every fight after that; those fights widen the gap, they do not turn anything.
 * And a game can be lost without one fight that cost this much.
 *
 * Calibrated on the 32 parsed games of the corpus (gold lead summed from the combat log), 2026-11-25:
 * - 23 of the 32 losing sides have one; the other 9 lost without a fight that cost that much while still in it;
 * - in 21 of those 23 the lead never came back to where it stood before that fight, and in 17 the side never
 *   led again: it is where the game went, not one swing among several;
 * - minute of the fight: quartiles 19 / 24 / 39. Fall: quartiles 3254 / 4650 / 7172;
 * - in 9 of the 15 games with a second candidate the fall is at least 1.3 times that one's. Where it is not,
 *   two fights cost about the same and this names the larger;
 * - the same rule names a fight for 17 of the 32 winning sides, and there the lead came back in 15: for a
 *   winner it is a setback, not a turn, which is why match_overview names it only for a game the team lost;
 * - "lost more heroes in it": on a gold lead read from the replay's net worth graph, 9 of 21 fights named
 *   without it were fights the side had not lost — the graph's points are not on the minute. On gold earned the
 *   condition changes no losing side's fight; it stays as the guard.
 */

/** A team this far behind is already losing: fights after that are not where it turned. */
export const STILL_IN_IT = -2000;
/** A fight has to cost more than this much of the lead to be a turn. */
export const TURN_DROP = 1500;
/** The rule, as match_overview states it beside the fight. */
export const TURN_RULE = `of the fights my_team lost more heroes in, entered at a gold lead of ${STILL_IN_IT} or better: the one after which the lead fell the most by two minutes after it, if by more than ${TURN_DROP}`;

/**
 * @template {{ my_team_deaths?: number, enemy_deaths?: number, my_team_gold_lead_before?: number | null, my_team_gold_lead_2min_after?: number | null }} F
 * @param {F[]} fights  as match_overview lists them, told from one team's side
 * @returns {F | null}  null when no fight cost that much — or when the fights carry no gold lead at all,
 *   which is not the same thing: the caller knows whether there was gold to read.
 */
export function turningFight(fights) {
  let best = null; let drop = TURN_DROP;
  for (const f of fights ?? []) {
    if (f.my_team_gold_lead_before == null || f.my_team_gold_lead_2min_after == null || f.my_team_gold_lead_before < STILL_IN_IT) continue;
    if (!(f.my_team_deaths > f.enemy_deaths)) continue;
    const d = f.my_team_gold_lead_before - f.my_team_gold_lead_2min_after;
    if (d > drop) { drop = d; best = f; }
  }
  return best;
}
