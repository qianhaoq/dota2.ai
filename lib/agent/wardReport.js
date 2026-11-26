/**
 * ward_report: the wards a hero placed, and the other side's wards they killed (#358 item 1).
 *
 * The trace keeps each ward's placement (when, which side, where) but not who placed it. The hero is read off the
 * item uses: a ward item (observer, sentry, or the dispenser) used by a hero of the ward's side within PLACED_WITHIN
 * seconds of the ward appearing. On the 32-game corpus all 3,242 placed wards had such a use within 0.1 s; for 24
 * (0.7%) two heroes of the side used a ward item within that time, and then who placed it is not known (counted as
 * such, never guessed).
 *
 * A reference, not a target: on the corpus the two heroes of each team who placed the most observers placed 4 / 7 / 11
 * (quartiles) a game; per hero the median was 1 and dewards 2.
 *
 * What it does not say: where the other side could see — no tool says who saw whom. Observers near a fight did not
 * decide it on the corpus (of 97 decided fights where one side had more observers within 1600 as it began, that side
 * lost fewer heroes in 49), so it gives no such count.
 */
import { traceClock, traceRegion } from '../../packages/review-engine/src/trace/index.js';

export const PLACED_WITHIN = 0.2;
const WARD_ITEM = /^item_ward_(observer|sentry|dispenser)$/;
const STRETCH = 600;
/** What the corpus showed, quoted beside the counts. */
export const WARD_REFERENCE = { two_most_warding_heroes_of_a_team_observers_per_game: { quarter_below: 4, median: 7, quarter_above: 12 }, games: 32 };

/** Each placed ward's placer (seat), or null when not known; undefined when the trace cannot say at all. */
export function wardPlacers(trace) {
  if (!Array.isArray(trace.wards) || !Array.isArray(trace.item_uses)) return undefined;
  // Heroes the combat log names (an unnamed one has index -1, which means "nobody" elsewhere in the trace).
  const seat = new Map(trace.heroes.map((h, i) => [trace.names.indexOf(h.npc), i]).filter(([n]) => n >= 0));
  const uses = trace.item_uses.filter((r) => WARD_ITEM.test(trace.names[r[2]] ?? '')).map((r) => ({ t: r[0], h: seat.get(r[1]) })).filter((u) => u.h != null);
  return trace.wards.map((w) => {
    if (w[0] == null) return null;
    const who = new Set(uses.filter((u) => trace.heroes[u.h].team === w[2] && Math.abs(u.t - w[0]) <= PLACED_WITHIN).map((u) => u.h));
    return who.size === 1 ? [...who][0] : null;
  });
}

export function wardReport(trace, args = {}) {
  const h = trace.heroes.findIndex((x) => x.key === args.hero);
  if (h < 0) return { error: 'unknown_hero', heroes: trace.heroes.map((x) => x.key) };
  const key = trace.heroes[h].key; const team = trace.heroes[h].team;
  const base = { ref: `wards:${key}`, ref_scope: 'summary', hero: key };
  const placers = wardPlacers(trace);
  if (placers === undefined) return { ...base, read: false, gaps: [{ topic: 'wards', reason: Array.isArray(trace.wards) ? 'no_item_uses_in_trace' : 'no_ward_placements_in_trace' }] };
  const mine = trace.wards.map((w, i) => ({ w, i })).filter(({ i }) => placers[i] === h);
  const placed = (kind) => mine.filter(({ w }) => w[3] === kind);
  const end = trace.t0 + trace.n - 1;
  const stretches = [];
  for (let a = 0; a < end; a += STRETCH) stretches.push({ from: traceClock(a), to: traceClock(Math.min(a + STRETCH, end)), observers: placed('o').filter(({ w }) => w[0] >= a && w[0] < a + STRETCH).length, sentries: placed('s').filter(({ w }) => w[0] >= a && w[0] < a + STRETCH).length });
  // Each hero of the player's team, by observers placed: where the player stands among them.
  const allies = trace.heroes.map((x, i) => i).filter((i) => trace.heroes[i].team === team).map((i) => ({ hero: trace.heroes[i].key, observers: trace.wards.filter((w, j) => placers[j] === i && w[3] === 'o').length }));
  allies.sort((a, b) => b.observers - a.observers);
  const sameSideUnknown = trace.wards.filter((w, j) => w[2] === team && w[0] != null && placers[j] === null).length;
  // The other side's wards the hero killed (the trace's creep_kills 'o' / 's').
  const nx = trace.names.indexOf(trace.heroes[h].npc);
  const kills = Array.isArray(trace.creep_kills) ? trace.creep_kills.filter((r) => nx >= 0 && r[1] === nx && (r[2] === 'o' || r[2] === 's')) : null;
  return {
    ...base, read: true,
    observers_placed: placed('o').length,
    sentries_placed: placed('s').length,
    placed_by_ten_minutes: stretches,
    // When and where, in order (place: a map region key).
    placements: mine.sort((a, b) => a.w[0] - b.w[0]).slice(0, 40).map(({ w }) => ({ clock: traceClock(w[0]), kind: w[3] === 'o' ? 'observer' : 'sentry', place: traceRegion(w[4], w[5]) })),
    my_team_by_observers_placed: allies,
    // Wards of the player's side whose placer is not known (two of them used a ward item at once): not counted above.
    my_team_wards_placer_not_known: sameSideUnknown,
    observers_killed: kills ? kills.filter((r) => r[2] === 'o').length : null,
    sentries_killed: kills ? kills.filter((r) => r[2] === 's').length : null,
    ...(kills ? { killed_at: kills.slice(0, 30).map((r) => ({ clock: traceClock(r[0]), kind: r[2] === 'o' ? 'observer' : 'sentry' })) } : {}),
    reference: WARD_REFERENCE,
    rule: `a ward is the hero's when a ward item of theirs was used within ${PLACED_WITHIN} s of it appearing and no other hero of the side used one then; the reference is what the corpus showed, not a target; where a ward could see is not known`,
    gaps: [{ topic: 'vision', reason: 'ward_placements_only_not_what_each_side_saw' }, ...(kills ? [] : [{ topic: 'wards_killed', reason: 'no_creep_kills_in_trace' }])],
  };
}

export const WARD_TOOL = {
  name: 'ward_report',
  description: "The wards a hero placed (use the player; most useful for a support): observers and sentries by count, by ten-minute stretch and when and where each went; where the hero stands on their team by observers placed; the other side's wards they killed; and what the corpus showed for the two most-warding heroes of a team (a reference, not a target). Never what anyone could see.",
  input_schema: { type: 'object', properties: { hero: { type: 'string', description: 'Hero key as in match_overview, e.g. "disruptor". Use the player.' } }, required: ['hero'], additionalProperties: false },
  run: wardReport,
};
