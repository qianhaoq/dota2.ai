/**
 * The moments a game turned on, ranked by how much they moved the player's team's chance to win.
 *
 * The chance is the win-probability model's (packages/review-engine/src/value, fitted on 3,571 ranked games: the
 * gold-earned lead, the minute and the barracks). It is a ruler for ranking moments, not a number to show a
 * reader. It is read only:
 * - on a gold-earned lead (the match record's, or the replay's combat log summed): never on the net worth graph;
 * - from FROM_MINUTE on: before that the lanes decide, and match_overview's `lanes` says whether they did.
 *
 * For each fight (three or more hero deaths close together, as match_overview numbers them) from FROM_MINUTE on:
 * the chance the minute it began and two minutes after it ended — or, when the game ended within two minutes of
 * it, the result itself (the game is over: 100 or 0) — and what the player was doing: in it (fightParticipation),
 * dead, elsewhere (with the place), or not known (no sample).
 *
 * `stretch`: the largest fall of the team's chance as one stretch of play — from a minute to the lowest point
 * before the chance comes back by more than REBOUND — with the fights inside it. A game is often turned by two or
 * three fights in a row, not by one.
 *
 * `falls_by_my_part`: of all the chance the team lost across fights, the share lost in fights the player was in,
 * dead for, or elsewhere during. It says where the game was lost relative to the player; it does not say whose
 * fault a fight was.
 *
 * Calibrated on the 32 parsed games of the corpus (gold earned for all), 2026-11-26, model wp.v1 after #377:
 * see docs/GAME_UNDERSTANDING.md ("关键时刻") and `node scripts/calibrate.mjs <traces> --json` → key_moments.
 */
import { fightParticipation, heroStateAt, matchFights, traceClock, traceRegion } from '../../packages/review-engine/src/trace/index.js';
import { modelInputs, radiantWinProbabilityAt } from '../../packages/review-engine/src/value/index.js';

/** The chance is not read before this minute: the lanes decide that part of the game (match_overview's lanes). */
export const FROM_MINUTE = 5;
/** A stretch of falling chance ends when the chance comes back by more than this. */
export const REBOUND = 0.05;
/** The chance after a fight is read this long after its last death. */
export const AFTER = 120;
/** How many fights are listed, the largest changes first. */
export const LISTED = 6;

const pct = (p) => Math.round(p * 100);
const fail = (error, extra = {}) => ({ error, ...extra });

/**
 * @param {any} trace  a match trace, hero names linked
 * @param {{ hero: string }} args
 * @param {{ match?: any }} [ctx]  the match record, when there is one
 */
export function keyMoments(trace, args = {}, ctx = {}) {
  const h = trace.heroes.findIndex((x) => x.key === args.hero);
  if (h < 0) return fail('unknown_hero', { heroes: trace.heroes.map((x) => x.key) });
  const key = trace.heroes[h].key; const team = trace.heroes[h].team;
  const base = { ref: `moments:${key}`, ref_scope: 'summary', hero: key };
  const fort = (trace.buildings ?? []).find((b) => /_fort$/.test(trace.names[b[1]] ?? ''));
  // Who won is whose Ancient fell; without it the game's end is not known.
  const loser = fort ? (/goodguys/.test(trace.names[fort[1]]) ? 2 : /badguys/.test(trace.names[fort[1]]) ? 3 : 0) : 0;
  const inputs = modelInputs(trace, ctx);
  if (inputs.unknown || !loser) {
    const reason = inputs.unknown ?? 'game_end_not_known';
    return { ...base, read: false, gaps: [{ topic: 'key_moments', reason }] };
  }
  const end = fort[0];
  const won = loser !== team;
  const chance = (t) => { const p = radiantWinProbabilityAt(trace, t, ctx); return p.unknown ? null : team === 2 ? p.radiant : 1 - p.radiant; };
  // The last whole minute before the one the Ancient fell in: the model is not read on a game already over.
  const lastMinute = Math.floor(end / 60) - 1;

  const fights = [];
  matchFights(trace).forEach((f, fi) => {
    if (f.from < FROM_MINUTE * 60) return;
    const ref = `fight:${fi + 1}`;
    const lost = { 2: 0, 3: 0 };
    for (const d of f.deaths) { const v = trace.heroes.findIndex((x) => x.npc === trace.names[d[1]]); if (v >= 0) lost[trace.heroes[v].team] += 1; }
    const beforeM = Math.floor(f.from / 60);
    const before = beforeM <= lastMinute ? chance(beforeM * 60) : null;
    const endedOnIt = end - f.to <= AFTER && end >= f.to;
    const afterM = Math.ceil((f.to + AFTER) / 60);
    // Two minutes after; near the end, the last minute before the Ancient's, when that is after the fight.
    const afterAt = afterM <= lastMinute ? afterM : lastMinute * 60 > f.to ? lastMinute : null;
    const after = endedOnIt ? (won ? 1 : 0) : afterAt != null ? chance(afterAt * 60) : null;
    const part = fightParticipation(trace, f);
    const s = heroStateAt(trace, h, f.from);
    const me = part.took_part.has(h) ? { part: 'in_it' } : !s.known ? { part: null } : !s.alive ? { part: 'dead' } : { part: 'elsewhere', place: traceRegion(...[stateXY(trace, h, f.from)].flat()) };
    fights.push({
      ref, clock: `${traceClock(f.from)}–${traceClock(f.to)}`, from: f.from, to: f.to,
      my_team_deaths: lost[team], enemy_deaths: lost[team === 2 ? 3 : 2],
      my_team_win_chance_before: before == null ? null : pct(before),
      my_team_win_chance_after: after == null ? null : pct(after),
      change: before == null || after == null ? null : pct(after) - pct(before),
      ...(endedOnIt ? { game_ended_after_it: true } : {}),
      me: me.part, ...(me.place ? { my_place: me.place } : {}),
    });
  });

  // The largest fall as one stretch, minute by minute.
  const series = [];
  for (let m = FROM_MINUTE; m <= lastMinute; m += 1) series.push([m, chance(m * 60)]);
  let stretch = null;
  for (let i = 0; i < series.length; i += 1) {
    if (series[i][1] == null) continue;
    let lo = i;
    for (let j = i + 1; j < series.length; j += 1) {
      if (series[j][1] == null) break;
      if (series[j][1] < series[lo][1]) lo = j;
      if (series[j][1] - series[lo][1] > REBOUND) break;
    }
    const fall = series[i][1] - series[lo][1];
    if (lo > i && (!stretch || fall > stretch.fall)) stretch = { i, lo, fall };
  }
  const inStretch = stretch ? fights.filter((f) => f.from >= (series[stretch.i][0] - 1) * 60 && f.from < series[stretch.lo][0] * 60) : [];

  const known = fights.filter((f) => f.change != null);
  const fell = known.filter((f) => f.change < 0);
  const total = fell.reduce((n, f) => n - f.change, 0);
  const share = (part) => (total > 0 ? Math.round((fell.filter((f) => f.me === part).reduce((n, f) => n - f.change, 0) / total) * 100) / 100 : null);

  return {
    ...base, read: true,
    result: won ? 'my_team_won' : 'my_team_lost',
    gold_lead_source: inputs.source,
    read_from_minute: FROM_MINUTE,
    stretch: stretch ? {
      from: `${series[stretch.i][0]}:00`, to: `${series[stretch.lo][0]}:00`,
      my_team_win_chance_from: pct(series[stretch.i][1]), my_team_win_chance_to: pct(series[stretch.lo][1]),
      fights: inStretch.map((f) => ({ ref: f.ref, clock: f.clock, change: f.change, me: f.me })),
    } : null,
    // The fight the game ended within two minutes of, when there was one: its change is read against the result.
    game_ended_on: (() => { const f = fights.find((x) => x.game_ended_after_it); return f ? { ref: f.ref, clock: f.clock, my_team_win_chance_before: f.my_team_win_chance_before, me: f.me } : null; })(),
    // The fights that moved the chance most, either way.
    largest_changes: [...known].sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, LISTED).map(({ from, to, ...f }) => f),
    // Of all the chance my_team lost across fights: the share lost where the player was in it, dead or elsewhere. Null: no fight lost any.
    falls_by_my_part: { in_it: share('in_it'), dead: share('dead'), elsewhere: share('elsewhere'), not_known: share(null) },
    fights_read: known.length,
    fights_not_read: fights.length - known.length,
    rule: `win chance = the win-probability model on the gold-earned lead, from ${FROM_MINUTE}:00 on; a fight's change = the chance two minutes after its last death (the last minute before the end, when that comes first; the result, when the game ended within two minutes) less the chance the minute it began; stretch = the largest fall from one minute to the lowest point before the chance came back by more than ${pct(REBOUND)}; it ranks moments and says nothing of whose fault a fight was`,
    gaps: fights.length - known.length ? [{ topic: 'key_moments', reason: `${fights.length - known.length} fight(s) with no chance before or after (the gold lead does not cover that minute)` }] : [],
  };
}

function stateXY(trace, h, t) {
  const k = Math.round(t) - trace.t0; const st = trace.states[h];
  return [st.x[k], st.y[k]];
}

export const KEY_MOMENTS_TOOL = {
  name: 'key_moments',
  description: "The fights that moved the player's team's chance to win the most, from 5:00 on, read from the win-probability model on the gold-earned lead: for each, the chance before and two minutes after (the result, when the game ended on it), and what the player was doing (in it, dead, elsewhere). Also the largest falling stretch of the game with the fights inside it, and how the chance the team lost splits between fights the player was in, dead for, or elsewhere during. A ranking of moments, not a verdict on whose fault a fight was.",
  input_schema: { type: 'object', properties: { hero: { type: 'string', description: 'Hero key as in match_overview, e.g. "beastmaster". Told from this hero\'s side: use the player.' } }, required: ['hero'], additionalProperties: false },
  run: keyMoments,
};
