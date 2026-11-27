/**
 * Replay queries the model can use to check a fact for itself (#405, B), instead of waiting for a report built for
 * that question.
 *
 * - combat_log: the trace's own rows in a window, filtered by hero and kind — casts, item uses (with the hero an
 *   item went to), hero deaths, purchases, damage between heroes and to buildings (summed per second by attacker,
 *   target and source), control and spell-immunity effects put on heroes, buildings destroyed, creep kills, gold by
 *   reason (per minute), Smoke of Deceit and runes on heroes, Roshan and Tormentor kills. Each row has its own ref (`log:<kind>:<n>`, n its place in the
 *   trace), so a sentence about one can cite it.
 * - hero_track: one hero second by second over a window: alive, where, what the replay shows them doing, health,
 *   mana, level.
 *
 * Nothing is inferred: a row says what the log wrote. A kind the trace was built without is a gap, never "none".
 */
import { classifyDeath, heroStateAt, traceClock, traceRegion, traceSeconds } from '../../packages/review-engine/src/trace/index.js';
import { heroOfName, nameOf } from '../../packages/review-engine/src/trace/query.js';

export const LOG_WINDOW = 180;
export const LOG_ROWS = 200;
export const TRACK_WINDOW = 120;

const fail = (error, extra = {}) => ({ error, ...extra });
const KILL = { l: 'lane_creep', d: 'deny', n: 'neutral', o: 'enemy_observer_ward', s: 'enemy_sentry_ward', c: 'enemy_courier', u: 'lane_creep_side_not_known', x: 'other' };
const GOLD = { 0: 'other', 1: 'death', 6: 'selling', 11: 'building', 12: 'hero_kill_or_assist', 13: 'lane_creep', 14: 'neutral', 15: 'roshan_or_tormentor', 16: 'courier', 17: 'bounty_rune', 20: 'ward', 21: 'courier' };
const CONTROL = { i: 'spell_immune', r: 'rooted', s: 'silenced', t: 'other' };

/**
 * Each kind: the trace field, the row's time, the heroes it involves (indexes into trace.names), and the row as the
 * model reads it. `minute`: the row's time is a game minute, not a second.
 */
const KINDS = {
  cast: { field: 'casts', t: (r) => r[0], who: (r) => [r[1], r[3]], row: (tr, r) => ({ by: nameOf(tr, r[1]), ability: nameOf(tr, r[2]), target: r[3] >= 0 ? nameOf(tr, r[3]) : null }) },
  item_use: { field: 'item_uses', t: (r) => r[0], who: (r) => [r[1], r.length >= 5 ? r[4] ?? -1 : -1], row: (tr, r) => ({ by: nameOf(tr, r[1]), item: nameOf(tr, r[2]), ...(r.length >= 5 ? { to_hero: r[4] != null && r[4] >= 0 ? nameOf(tr, r[4]) : null } : {}) }) },
  death: { field: 'deaths', t: (r) => r[0], who: (r) => [r[1], r[2]], row: (tr, r) => { const c = classifyDeath(tr, r); return { hero: nameOf(tr, r[1]), killer: r[2] >= 0 ? nameOf(tr, r[2]) : null, ...(c.real ? {} : { resurrected_by: c.by }) }; } },
  purchase: { field: 'purchases', t: (r) => r[0], who: (r) => [r[1]], row: (tr, r) => ({ by: nameOf(tr, r[1]), item: nameOf(tr, r[2]) }) },
  damage: { field: 'damage', t: (r) => r[0], who: (r) => [r[1], r[2]], row: (tr, r) => ({ from: nameOf(tr, r[1]), to: nameOf(tr, r[2]), source: r[3] >= 0 ? nameOf(tr, r[3]) : 'attack', amount: r[4] }) },
  effect: { field: 'modifiers', t: (r) => r[0], who: (r) => [r[1], r[3]], keep: (r) => r[4] === 1, row: (tr, r) => ({ on: nameOf(tr, r[1]), effect: nameOf(tr, r[2]), by: r[3] >= 0 ? nameOf(tr, r[3]) : null, kind: r[5] ? 'stun' : CONTROL[r[6]] ?? 'other' }) },
  building: { field: 'buildings', t: (r) => r[0], who: () => [], row: (tr, r) => ({ building: nameOf(tr, r[1]) }) },
  creep_kill: { field: 'creep_kills', t: (r) => r[0], who: (r) => [r[1]], row: (tr, r) => ({ by: nameOf(tr, r[1]), what: KILL[r[2]] ?? 'other', last_hits_then: r[3] ?? null }) },
  // A minute's gold: `from` and `to` are that minute's first and last second, so a sentence giving the minute as clock times is backed.
  gold: { field: 'gold', minute: true, t: (r) => r[0] * 60, who: (r) => [r[1]], row: (tr, r) => ({ hero: nameOf(tr, r[1]), minute: r[0], from: r[0] * 60, to: r[0] * 60 + 59, reason: GOLD[r[2]] ?? `code_${r[2]}`, gold: r[3] }) },
  smoke: { field: 'smokes', t: (r) => r[0], who: (r) => [r[1], r[2]], row: (tr, r) => ({ hero: nameOf(tr, r[1]), used_by: nameOf(tr, r[2]), until: r[3] == null ? null : traceClock(r[3]) }) },
  rune: { field: 'runes', t: (r) => r[0], who: (r) => [r[1]], row: (tr, r) => ({ hero: nameOf(tr, r[1]), rune: r[2], until: r[3] == null ? null : traceClock(r[3]) }) },
  roshan_kill: { field: 'roshan_kills', t: (r) => r[0], who: (r) => [r[1]], row: (tr, r) => ({ last_hit: r[1] >= 0 ? nameOf(tr, r[1]) : null }) },
  tormentor_kill: { field: 'tormentor_kills', t: (r) => r[0], who: (r) => [r[1]], row: (tr, r) => ({ last_hit: r[1] >= 0 ? nameOf(tr, r[1]) : null }) },
};
export const LOG_KINDS = Object.keys(KINDS);

/** One row of the log as the model reads it, by its ref (`log:<kind>:<n>`), or null. */
export function logRow(trace, kind, n) {
  const k = KINDS[kind];
  const r = k && Number.isInteger(n) && n >= 0 ? trace[k.field]?.[n] : null;
  if (!Array.isArray(r) || (k.keep && !k.keep(r))) return null;
  return { ref: `log:${kind}:${n}`, ...(k.minute ? {} : { t: Math.round(k.t(r) * 10) / 10, clock: traceClock(k.t(r)) }), kind, ...k.row(trace, r) };
}

export function combatLog(trace, args = {}) {
  const from = traceSeconds(args.from); const to = traceSeconds(args.to);
  if (from == null || to == null || to < from) return fail('bad_window', { hint: 'from and to as seconds or "m:ss", from before to' });
  if (to - from > LOG_WINDOW) return fail('window_too_long', { max_seconds: LOG_WINDOW });
  const kinds = Array.isArray(args.kinds) && args.kinds.length ? args.kinds : LOG_KINDS;
  const unknown = kinds.filter((k) => !KINDS[k]);
  if (unknown.length) return fail('unknown_kind', { kinds: LOG_KINDS });
  let heroName = null;
  if (args.hero != null) {
    const h = trace.heroes.findIndex((x) => x.key === args.hero);
    if (h < 0) return fail('unknown_hero', { heroes: trace.heroes.map((x) => x.key) });
    heroName = h;
  }
  const rows = []; const gaps = [];
  for (const kind of kinds) {
    const k = KINDS[kind];
    const list = trace[k.field];
    // A field the trace was built without: what happened is not known, not "nothing".
    if (!Array.isArray(list)) { gaps.push({ topic: kind, reason: 'not_in_this_trace' }); continue; }
    if (kind === 'item_use' && list.length && !list.some((r) => r.length >= 5)) gaps.push({ topic: 'item_use', reason: 'item_targets_not_in_trace' });
    list.forEach((r, n) => {
      const t = k.t(r);
      // A minute's gold is in the window when any second of that minute is.
      if (k.minute ? t + 59 < from || t > to : t < from || t > to) return;
      if (k.keep && !k.keep(r)) return;
      if (heroName != null && !k.who(r).some((i) => i >= 0 && heroOfName(trace, i) === heroName)) return;
      rows.push({ t, row: logRow(trace, kind, n) });
    });
  }
  rows.sort((a, b) => a.t - b.t);
  return {
    ref_scope: 'rows', from: traceClock(from), to: traceClock(to), ...(heroName != null ? { hero: args.hero } : {}), kinds,
    rows: rows.slice(0, LOG_ROWS).map((x) => x.row),
    ...(rows.length > LOG_ROWS ? { rows_not_listed: rows.length - LOG_ROWS, hint: 'narrow the window, the hero or the kinds' } : {}),
    rule: 'Each row is the combat log as the replay wrote it, with its own ref. damage is summed per second by attacker, target and source ("attack": a right click); an illusion\'s damage is its own attacker ("illusion:<hero>"). effect lists effects put on heroes (stuns, roots, silences, spell immunity) as they began. smoke and rune: when a hero had one, until when (the log does not say whether a smoke expired or was broken); a bounty rune is gold (bounty_rune), a wisdom rune is not seen. gold is per game minute and reason; it does not add up to net worth. A summon\'s creep kill has no row of its own.',
    gaps,
  };
}

export function heroTrack(trace, args = {}) {
  const h = trace.heroes.findIndex((x) => x.key === args.hero);
  if (h < 0) return fail('unknown_hero', { heroes: trace.heroes.map((x) => x.key) });
  const from = traceSeconds(args.from); const to = traceSeconds(args.to);
  if (from == null || to == null || to < from) return fail('bad_window', { hint: 'from and to as seconds or "m:ss", from before to' });
  if (to - from > TRACK_WINDOW) return fail('window_too_long', { max_seconds: TRACK_WINDOW });
  const seconds = [];
  for (let t = Math.ceil(from); t <= Math.floor(to); t += 1) {
    // Only a second with its own sample: heroStateAt would borrow one up to 2 s away, and label it with this clock.
    const own = trace.states?.[h]?.x?.[t - trace.t0] != null;
    const s = own ? heroStateAt(trace, h, t) : { known: false };
    // A second with no sample: not known, said so.
    seconds.push(s.known ? { clock: traceClock(t), alive: s.alive, ...(s.alive ? { place: s.place } : { respawn_in: s.respawn_in ?? null }), doing: s.doing, hp_pct: s.hp_pct, mana: s.mana, level: s.level } : { clock: traceClock(t), known: false });
  }
  return {
    // Cited whole: a sentence may quote any second's numbers.
    ref: `track:${args.hero}:${Math.ceil(from)}:${Math.floor(to)}`, hero: args.hero, from: traceClock(from), to: traceClock(to),
    seconds,
    rule: 'doing is what the replay shows within a few seconds: trading damage with enemy heroes, hitting enemy buildings, farming (a creep kill within 10 s), in own base, or none of these. place is a map region.',
    gaps: [
      ...(seconds.some((s) => s.known === false) ? [{ topic: 'samples', reason: 'some seconds have no sample' }] : []),
      // Without creep kills the trace cannot show farming: "none of these" then does not rule it out.
      ...(Array.isArray(trace.creep_kills) ? [] : [{ topic: 'farming', reason: 'no_creep_kills_in_trace: farming is not seen, and none_of_these does not rule it out' }]),
    ],
  };
}

const TIME = { type: ['number', 'string'], description: 'Game time: seconds, or "m:ss".' };
export const REPLAY_QUERY_TOOLS = [
  {
    name: 'combat_log',
    description: `The replay's own rows in a window of at most ${LOG_WINDOW} s, filtered by hero (as actor or target) and kind: casts, item uses (and which hero an item went to), deaths, purchases, damage between heroes and to buildings, stuns and other effects on heroes, buildings destroyed, creep kills, gold by reason, Smoke of Deceit and runes, Roshan and Tormentor kills. Use it to check a fact before you state it. Each row has its own ref.`,
    input_schema: { type: 'object', properties: { from: TIME, to: TIME, hero: { type: 'string', description: 'Hero key as in match_overview; leave out for every hero.' }, kinds: { type: 'array', items: { type: 'string', enum: LOG_KINDS }, description: 'Leave out for every kind.' } }, required: ['from', 'to'], additionalProperties: false },
    run: combatLog,
  },
  {
    name: 'hero_track',
    description: `One hero second by second over at most ${TRACK_WINDOW} s: alive, where, what the replay shows them doing, health, mana, level.`,
    input_schema: { type: 'object', properties: { hero: { type: 'string', description: 'Hero key as in match_overview.' }, from: TIME, to: TIME }, required: ['hero', 'from', 'to'], additionalProperties: false },
    run: heroTrack,
  },
];
