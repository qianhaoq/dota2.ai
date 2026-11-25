/**
 * The fight a lost game turned on.
 *
 * Read off the gold lead around each fight the team lost more heroes in while it was still in the game:
 * - the fight the game ended within two minutes of, when there is one: the game was open going in and over
 *   coming out, so nothing before it had turned it for good;
 * - else the one after which the lead fell the most by two minutes on — when that fall is large enough.
 * A team already far behind loses more gold in every fight after that; those fights widen the gap, they do not
 * turn anything. And a game can be lost without one fight that cost this much.
 *
 * A lost fight that could be it and has no gold lead to tell by makes the answer "not known" — never "none".
 *
 * Calibrated on the 32 parsed games of the corpus (gold lead summed from the combat log), 2026-11-25:
 * - 23 of the 32 losing sides have one: 3 lost a last fight entered still in the game (once 3,442 ahead) with the
 *   Ancient down inside two minutes; 20 by the largest fall. The other 9 lost without a fight that cost that much
 *   while still in it. None was "not known";
 * - of the 20: the lead never came back to where it stood before that fight in all 20, and the side never led
 *   again in 16. Minute of the fight: quartiles 19 / 25 / 47. Fall: quartiles 3553 / 4650 / 9120;
 * - before the last-fight rule those 3 games were given an earlier fight, and in 2 of them the lead had come
 *   back after it: the earlier fight was a swing, the last one was the game;
 * - the largest-fall rule names a fight for 17 of the 32 winning sides, and there the lead came back in 15: for a
 *   winner it is a setback, not a turn, which is why match_overview names it only for a game the team lost;
 * - "lost more heroes in it": on a gold lead read from the replay's net worth graph, 9 of 21 fights named
 *   without it were fights the side had not lost — the graph's points are not on the minute. On gold earned the
 *   condition changes no losing side's fight; it stays as the guard.
 */

/** A team this far behind is already losing: fights after that are not where it turned. */
export const STILL_IN_IT = -2000;
/** A fight has to cost more than this much of the lead to be a turn. */
export const TURN_DROP = 1500;
/** A fight the game ended this soon after has no lead "two minutes on": the Ancient fell instead. */
export const ENDED_WITHIN = 120;
/** The rule, as match_overview states it beside the fight. */
export const TURN_RULE = `of the fights my_team lost more heroes in, entered at a gold lead of ${STILL_IN_IT} or better: the one the game ended within two minutes of; else the one after which the lead fell the most by two minutes after it, if by more than ${TURN_DROP}`;

/**
 * @template {{ to?: number, my_team_deaths?: number, enemy_deaths?: number, my_team_gold_lead_before?: number | null, my_team_gold_lead_2min_after?: number | null }} F
 * @param {F[]} fights  as match_overview lists them, told from one team's side
 * @param {{ end?: number | null }} [o]  the second the game ended (the Ancient's fall), when known
 * @returns {{ fight: F | null, by: 'game_ended_after_it' | 'largest_fall' | null, undecided: F[] }}
 *   `undecided`: lost fights that could be the turn and have no gold lead to tell by — none before them, or none
 *   two minutes on for another reason than the game ending. With any of those and no fight the game ended on,
 *   `fight` is null and that null is "not known", not "none": the caller must not say the game had no turn.
 */
export function turnOf(fights, { end = null } = {}) {
  const undecided = []; let best = null; let drop = TURN_DROP; let ended = null;
  for (const f of fights ?? []) {
    if (!(f.my_team_deaths > f.enemy_deaths)) continue;
    const before = f.my_team_gold_lead_before; const after = f.my_team_gold_lead_2min_after;
    if (before == null) { undecided.push(f); continue; }
    if (before < STILL_IN_IT) continue;
    if (after == null) {
      // Still in the game, lost, and no lead two minutes on. Because the game was over by then: nothing after this
      // fight can be the turn, so it is. For any other reason (a gold series that stops short): not known.
      if (Number.isFinite(end) && Number.isFinite(f.to) && end >= f.to && end - f.to <= ENDED_WITHIN) ended = f; else undecided.push(f);
      continue;
    }
    if (before - after > drop) { drop = before - after; best = f; }
  }
  if (ended) return { fight: ended, by: 'game_ended_after_it', undecided };
  if (undecided.length) return { fight: null, by: null, undecided };
  return { fight: best, by: best ? 'largest_fall' : null, undecided };
}

/**
 * The fight alone (turnOf): null when there is none — or when it is not known, which the caller reads off turnOf.
 * @template {{ to?: number, my_team_deaths?: number, enemy_deaths?: number, my_team_gold_lead_before?: number | null, my_team_gold_lead_2min_after?: number | null }} F
 * @param {F[]} fights
 * @param {{ end?: number | null }} [o]
 * @returns {F | null}
 */
export function turningFight(fights, o) {
  return turnOf(fights, o).fight;
}
