/**
 * save_report: what a hero gave their own side (#358 item 2) — every ability and item they used on an allied hero
 * (themselves included, apart), whether that hero was taking damage from enemy heroes as it was given, and whether
 * they died in the next seconds.
 *
 * From the trace's casts (they keep a hero target) and item uses (they keep one since the trace builder writes it:
 * a trace built before has no fifth column, and then what items were given to whom is not known — said under gaps).
 * "In danger": the hero took damage from enemy heroes in the DANGER_BEFORE seconds up to it. "Died": a death of that
 * hero within DIED_WITHIN seconds after. What was given is named, not judged: whether a cast was a save depends on the
 * ability, which the tool does not classify.
 *
 * Calibrated on the 32-game corpus rebuilt with item targets (2026-11-26): an ally taking damage from enemy heroes
 * died within 5 s after an ally's ability on them in 13% (76 of 595), after an ally's item 21% (42 of 200); a hero
 * taking such damage with nothing given, every 5 s from 10:00, 14% (1,744 of 12,610). Under 300+ damage in 3 s: 25%
 * with something given (100 of 404), 31% without (1,375 of 4,444). Who gets help is who is in trouble, so these say
 * little about whether a given cast saved anyone: the review says what was given and what followed, not that it saved
 * or failed to.
 */
import { traceClock } from '../../packages/review-engine/src/trace/index.js';

export const DANGER_BEFORE = 3;
export const DIED_WITHIN = 5;
/** Uses on allies listed, each with its own ref; uses on oneself listed apart, fewer. */
const LISTED = 40;
const SELF_LISTED = 10;

export function saveReport(trace, args = {}) {
  const h = trace.heroes.findIndex((x) => x.key === args.hero);
  if (h < 0) return { error: 'unknown_hero', heroes: trace.heroes.map((x) => x.key) };
  const key = trace.heroes[h].key; const team = trace.heroes[h].team;
  const nameIx = (i) => trace.names.indexOf(trace.heroes[i].npc);
  // A hero the combat log never names has no index (-1): the same -1 the builder writes for "no target", so it is
  // left out of every lookup — an untargeted cast must not become one given to that hero.
  const seatOf = new Map(trace.heroes.map((x, i) => [nameIx(i), i]).filter(([n]) => n >= 0));
  const me = nameIx(h);
  if (me < 0) return { ref: `saves:${key}`, ref_scope: 'summary', hero: key, gaps: [{ topic: 'items_given', reason: 'hero_not_named_in_the_combat_log' }] };
  const allies = new Set(trace.heroes.map((x, i) => i).filter((i) => trace.heroes[i].team === team));
  const enemies = new Set(trace.heroes.map((x, i) => i).filter((i) => trace.heroes[i].team !== team).map(nameIx).filter((n) => n >= 0));
  const itemTargetsKnown = (trace.item_uses ?? []).some((u) => u.length >= 5);
  const given = [];
  for (const c of trace.casts ?? []) {
    const to = seatOf.get(c[3]);
    if (c[1] === me && to != null && allies.has(to)) given.push({ t: c[0], what: trace.names[c[2]], kind: 'ability', to });
  }
  if (itemTargetsKnown) for (const u of trace.item_uses) {
    const to = u[4] == null ? undefined : seatOf.get(u[4]);
    if (u[1] === me && to != null && allies.has(to)) given.push({ t: u[0], what: trace.names[u[2]], kind: 'item', to });
  }
  given.sort((a, b) => a.t - b.t);
  const enemyDamageTo = (i, from, to) => (trace.damage ?? []).filter((d) => nameIx(i) >= 0 && d[2] === nameIx(i) && enemies.has(d[1]) && d[0] >= Math.floor(from) && d[0] <= Math.floor(to)).reduce((s, d) => s + d[4], 0);
  const diedSoon = (i, t) => (trace.deaths ?? []).some((d) => nameIx(i) >= 0 && d[1] === nameIx(i) && d[0] > t && d[0] <= t + DIED_WITHIN);
  const rows = given.map((g) => {
    const taken = enemyDamageTo(g.to, g.t - DANGER_BEFORE, g.t);
    return { clock: traceClock(g.t), kind: g.kind, what: g.what.replace(/^item_/, ''), to: g.to === h ? 'self' : trace.heroes[g.to].key, in_danger: taken > 0, enemy_damage_taken_before: taken, died_within_5s: diedSoon(g.to, g.t) };
  });
  // Each use on an ally is a record of its own (saves:<hero>:<n>), so a sentence about one can cite it.
  const toAllies = rows.filter((r) => r.to !== 'self').map((r, i) => ({ ref: `saves:${key}:${i + 1}`, ...r }));
  const onSelf = rows.filter((r) => r.to === 'self');
  const inDanger = toAllies.filter((r) => r.in_danger);
  return {
    ref: `saves:${key}`, ref_scope: 'summary', hero: key,
    given_to_allies: toAllies.length,
    given_to_allies_in_danger: inDanger.length,
    of_those_the_ally_died_within_5s: inDanger.filter((r) => r.died_within_5s).length,
    used_on_self: onSelf.length,
    // Each ally: how many times, and what.
    by_ally: Object.fromEntries([...new Set(toAllies.map((r) => r.to))].map((a) => [a, toAllies.filter((r) => r.to === a).length])),
    given: toAllies.slice(0, LISTED),
    ...(toAllies.length > LISTED ? { given_not_listed: toAllies.length - LISTED } : {}),
    self_uses: onSelf.slice(0, SELF_LISTED).map(({ to, ...r }) => r),
    rule: `given = an ability or item the hero used on an allied hero (self apart); in_danger = that ally took damage from enemy heroes in the ${DANGER_BEFORE} s up to it; died_within_5s = that ally died within ${DIED_WITHIN} s after. Whether a cast was meant as a save is not classified`,
    gaps: itemTargetsKnown ? [] : [{ topic: 'items_given', reason: 'item_targets_not_in_trace' }],
  };
}

export const SAVE_TOOL = {
  name: 'save_report',
  description: "What a hero gave their own side (use the player; most useful for a support): every ability and item they used on an allied hero, with whether that ally was taking damage from enemy heroes as it was given and whether they died within 5 s; how many times each ally; what they used on themselves, apart. Names what was given, does not judge whether it was a save.",
  input_schema: { type: 'object', properties: { hero: { type: 'string', description: 'Hero key as in match_overview. Use the player.' } }, required: ['hero'], additionalProperties: false },
  run: saveReport,
};
