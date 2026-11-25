/**
 * roshan_report: every Roshan the replay shows, from the player's side — who took it, who was there, what
 * became of the Aegis, and what each side did in the five minutes the Aegis lasts.
 *
 * Two things in a trace show a Roshan:
 * - every item a hero held: the Aegis of the Immortal appears in the inventory of the hero who picked it up and
 *   leaves it when the holder dies (it brings them back: used) or after 300 s (expired). Every trace has this;
 * - since 2026-11-25, the kill itself (`roshan_kills`: the death row of Roshan when a hero landed the last hit) and
 *   every second a hero damaged Roshan (`roshan_damage`). A trace built before that has neither: unknown, not none.
 *
 * With kills, a take is the kill: who landed it, which heroes hit Roshan in the attempt and for how long, whether
 * the other side hit it too, and where each hero of the other side stood when the attempt began. The Aegis pickup
 * by the killing side within 30 s is joined to it. Over the 32 parsed games: 50 kills and 51 pickups; 47 kills
 * have their pickup, 3 do not; the attempt (hits no more than 10 s apart, back from the kill) lasted 16 / 24 / 31 s
 * at the quartiles; 1 to 5 heroes of the killing side hit it (4 / 7 / 9 / 19 / 11 kills); the other side hit it
 * in 8. A pickup with no kill row (the last hit was a summon's or a creep's) is still a take, as before.
 * Without kills, a take is the pickup alone. A Roshan whose Aegis nobody picked up is then not seen.
 *
 * Who could see the attempt is not in the replay data: where the other side stood is where they stood.
 *
 * Why: over 52 Aegis takes in 32 parsed games (scripts/calibrate.mjs), the team with it took 139 buildings in
 * the next 300 s and lost 18, and only 7 takes were followed by no building. A take that bought nothing is
 * worth naming.
 */
import { matchFights, sieges, traceClock, traceHeroIndex } from '../../packages/review-engine/src/trace/index.js';
import { heroOfName, region, stateAt, dist } from '../../packages/review-engine/src/trace/query.js';
import { gapsOf } from './fightReport.js';

/** The Aegis lasts this long once picked up. */
export const AEGIS_SECONDS = 300;
/** A pickup by the killing side this soon after a kill is that Roshan's Aegis. */
export const PICKUP_WITHIN = 30;
/** Hits on Roshan no further apart than this, back from the kill, are one attempt. */
export const ATTEMPT_GAP = 10;
/** Other things a later Roshan drops; held within this many seconds of the Aegis pickup they came with it. */
const DROPS = ['item_cheese', 'item_refresher_shard', 'item_roshans_banner'];
const DROP_SECONDS = 15;
const OBJECTIVE = /_(tower\d|melee_rax|range_rax|fort)(_(top|mid|bot))?$/;
const teamOfBuilding = (name) => (/goodguys/.test(name) ? 2 : /badguys/.test(name) ? 3 : null);
const fail = (error, extra = {}) => ({ error, ...extra });

/** Every Aegis pickup in the trace: { holder, from, to, ended, ended_at }, in order. */
export function aegisTakes(trace) {
  const end = trace.t0 + trace.n - 1;
  const out = [];
  (trace.items ?? []).forEach((items, i) => {
    for (const [from, to] of items?.item_aegis?.held ?? []) {
      const died = trace.deaths.some((d) => heroOfName(trace, d[1]) === i && Math.abs(d[0] - to) <= 2);
      const ended = died ? 'used' : to - from >= AEGIS_SECONDS - 5 ? 'expired' : to >= end - 2 ? 'game_ended' : 'unknown';
      out.push({ holder: i, from, to, ended });
    }
  });
  return out.sort((a, b) => a.from - b.from);
}

export function roshanReport(trace, args = {}) {
  const h = traceHeroIndex(trace, args.hero);
  if (h < 0) return fail('unknown_hero', { heroes: trace.heroes.map((x) => x.key) });
  const key = trace.heroes[h].key; const team = trace.heroes[h].team;
  const fights = matchFights(trace); const pushes = sieges(trace);
  // The kills, when the trace kept them, each joined to the Aegis pickup that followed it; then the pickups no
  // kill accounts for. `a`: the pickup (or null), `k`: the kill (or null). One of the two is always there.
  const knowsKills = Array.isArray(trace.roshan_kills);
  const pickups = aegisTakes(trace); const joined = new Set();
  const kills = (knowsKills ? trace.roshan_kills : []).map((row) => {
    const killer = heroOfName(trace, row[1]);
    const side = row[2] === 2 || row[2] === 3 ? row[2] : killer >= 0 ? trace.heroes[killer].team : null;
    return { t: row[0], killer, side };
  }).filter((k) => k.side != null).sort((x, y) => x.t - y.t);
  const events = kills.map((k) => {
    const ai = pickups.findIndex((a, j) => !joined.has(j) && trace.heroes[a.holder].team === k.side && a.from >= k.t - 2 && a.from <= k.t + PICKUP_WITHIN);
    if (ai >= 0) joined.add(ai);
    return { k, a: ai >= 0 ? pickups[ai] : null, t: k.t };
  }).concat(pickups.map((a, j) => ({ a, j })).filter(({ j }) => !joined.has(j)).map(({ a }) => ({ k: null, a, t: a.from }))).sort((x, y) => x.t - y.t);
  /** Roshan's damage rows as [second, hero index, damage], heroes only. */
  const hits = (Array.isArray(trace.roshan_damage) ? trace.roshan_damage : []).map(([sec, who, dmg]) => [sec, heroOfName(trace, who), dmg]).filter((x) => x[1] >= 0);
  const takes = events.map(({ k, a }, i) => {
    const side = k ? k.side : trace.heroes[a.holder].team; const mine = side === team; const other = side === 2 ? 3 : 2;
    // The 300 s that follow are the Aegis's: from its pickup when there is one, else from the kill.
    const from = a ? a.from : k.t; const until = from + AEGIS_SECONDS;
    // Where it happened: the killer at the kill, else the holder at the pickup.
    const anchor = k && k.killer >= 0 ? k.killer : a ? a.holder : -1;
    const when = k ? k.t : a.from;
    const at = anchor >= 0 ? stateAt(trace, anchor, when) : null;
    // The attempt: the hits back from the kill with no gap longer than ATTEMPT_GAP.
    let attempt = null;
    if (k) {
      const back = hits.filter((x) => x[0] <= k.t + 1).sort((x, y) => y[0] - x[0]);
      let start = Math.floor(k.t); const dealt = new Map();
      for (const [sec, who, dmg] of back) { if (start - sec > ATTEMPT_GAP) break; start = Math.min(start, sec); dealt.set(who, (dealt.get(who) ?? 0) + dmg); }
      const list = (tm) => [...dealt].filter(([who]) => trace.heroes[who].team === tm).sort((x, y) => y[1] - x[1]).map(([who, damage]) => ({ hero: trace.heroes[who].key, damage: Math.round(damage) }));
      // Each hero of the other side when the attempt began: where, how far from where Roshan died, or dead. Null: no position then.
      const elsewhere = trace.heroes.map((x, j) => j).filter((j) => trace.heroes[j].team === other).map((j) => {
        const s0 = stateAt(trace, j, start);
        return !s0 ? { hero: trace.heroes[j].key, place: null } : !s0.alive ? { hero: trace.heroes[j].key, dead: true } : { hero: trace.heroes[j].key, place: region(s0.x, s0.y), ...(at ? { distance: Math.round(dist(s0, at)) } : {}) };
      });
      attempt = { started: traceClock(start), seconds: Math.max(0, Math.round(k.t - start)), heroes_hitting: list(side), other_side_hitting: list(other), other_side_when_it_began: elsewhere, i_hit_it: dealt.has(h) };
    }
    const near = (tm) => (at ? trace.heroes.map((x, j) => j).filter((j) => j !== anchor && trace.heroes[j].team === tm).filter((j) => { const s = stateAt(trace, j, when); return s?.alive && dist(s, at) <= 2200; }).map((j) => trace.heroes[j].key) : null);
    const buildings = (trace.buildings ?? []).filter((b) => b[0] >= from && b[0] <= until && OBJECTIVE.test(trace.names[b[1]] ?? '')).map((b) => ({ clock: traceClock(b[0]), building: trace.names[b[1]].replace(/^npc_dota_/, ''), owner: teamOfBuilding(trace.names[b[1]]) }));
    const took = (tm) => buildings.filter((b) => b.owner && b.owner !== tm);
    const inWindow = fights.map((f, fi) => ({ f, fi })).filter(({ f }) => f.from >= from && f.from <= until).map(({ f, fi }) => {
      const lost = { 2: 0, 3: 0 };
      for (const d of f.deaths) { const v = heroOfName(trace, d[1]); if (v >= 0) lost[trace.heroes[v].team] += 1; }
      return { fight: `fight:${fi + 1}`, clock: traceClock(f.from), aegis_side_deaths: lost[side], other_side_deaths: lost[other] };
    });
    const theirPushes = pushes.filter((p) => p.from >= from && p.from <= until && p.owner !== side);
    const drops = [];
    (trace.items ?? []).forEach((items, j) => { for (const k of DROPS) for (const [f0] of items?.[k]?.held ?? []) if (Math.abs(f0 - from) <= DROP_SECONDS) drops.push({ item: k.replace(/^item_/, ''), hero: trace.heroes[j].key }); });
    const holderNear = near(side); const otherNear = near(other);
    return {
      ref: `roshan:${key}:${i + 1}`,
      // When Roshan died, when the kill is in the trace; else when the Aegis was picked up.
      clock: traceClock(when),
      taken_by: mine ? 'my_team' : 'enemy',
      // What this take is read from: the kill row (and its pickup, when one followed), or the pickup alone.
      seen_by: k ? (a ? 'kill_and_aegis_pickup' : 'kill') : 'aegis_pickup',
      ...(k ? { killed_by: k.killer >= 0 ? trace.heroes[k.killer].key : null, attempt } : {}),
      ...(a ? { aegis_holder: trace.heroes[a.holder].key, ...(k ? { aegis_picked_up_at: traceClock(a.from) } : {}) } : {}),
      ...(at ? { place: region(at.x, at.y) } : {}),
      // Who stood within 2200 of the killer as Roshan died (of the holder at the pickup, without a kill): who was at
      // the Roshan. Null: that hero's position was not sampled.
      taking_side_near: holderNear,
      other_side_near: otherNear,
      me: a && a.holder === h ? 'holder' : anchor === h || holderNear?.includes(key) || otherNear?.includes(key) ? 'there' : at ? 'not_there' : null,
      ...(drops.length ? { also_dropped: drops } : {}),
      // The kill with no pickup by the killing side within 30 s: the Aegis was not seen picked up — not "wasted".
      aegis: a ? a.ended : 'no_pickup_seen_within_30s',
      ...(a?.ended === 'used' ? { aegis_used_at: traceClock(a.to) } : a?.ended === 'expired' ? { aegis_expired_at: traceClock(a.to) } : {}),
      // In the 300 s the Aegis lasts from the pickup (from the kill, without one), whatever became of it.
      buildings_taking_side_took_in_the_next_300s: took(side).map((b) => ({ clock: b.clock, building: b.building })),
      buildings_other_side_took_in_the_next_300s: took(other).map((b) => ({ clock: b.clock, building: b.building })),
      buildings_taking_side_took_count: took(side).length,
      fights_in_the_next_300s: inWindow,
      taking_side_pushes_in_the_next_300s: { pushes: theirPushes.length, took_it: theirPushes.filter((p) => p.fell_at != null).length },
    };
  });
  const by = (who) => takes.filter((x) => x.taken_by === who);
  // The Tormentors a hero landed the last hit on, when the trace kept them (same death rows as Roshan's).
  const tormentors = Array.isArray(trace.tormentor_kills) ? trace.tormentor_kills.map((row) => {
    const killer = heroOfName(trace, row[1]);
    const side = row[2] === 2 || row[2] === 3 ? row[2] : killer >= 0 ? trace.heroes[killer].team : null;
    return { clock: traceClock(row[0]), taken_by: side == null ? null : side === team ? 'my_team' : 'enemy', killed_by: killer >= 0 ? trace.heroes[killer].key : null };
  }) : null;
  const withKill = takes.filter((x) => x.attempt);
  return {
    ref: `roshan:${key}`, ref_scope: 'summary',
    hero: key,
    // How the Roshans below were found. null counts: this trace was built before kills were kept — unknown, not none.
    read_from: knowsKills ? 'roshan_kills_and_aegis_pickups' : 'aegis_pickups_only',
    roshan_kills_in_the_trace: knowsKills ? kills.length : null,
    my_team_roshans_i_hit: knowsKills ? withKill.filter((x) => x.taken_by === 'my_team' && x.attempt.i_hit_it).length : null,
    roshans_the_other_side_also_hit: knowsKills ? withKill.filter((x) => x.attempt.other_side_hitting.length > 0).length : null,
    tormentors_my_team_took: tormentors ? tormentors.filter((x) => x.taken_by === 'my_team').length : null,
    tormentors_enemy_took: tormentors ? tormentors.filter((x) => x.taken_by === 'enemy').length : null,
    ...(tormentors ? { tormentors } : {}),
    roshans_my_team_took: by('my_team').length,
    roshans_enemy_took: by('enemy').length,
    my_team_aegis_used: by('my_team').filter((x) => x.aegis === 'used').length,
    my_team_aegis_expired: by('my_team').filter((x) => x.aegis === 'expired').length,
    buildings_my_team_took_with_aegis: by('my_team').reduce((n, x) => n + x.buildings_taking_side_took_count, 0),
    buildings_enemy_took_with_aegis: by('enemy').reduce((n, x) => n + x.buildings_taking_side_took_count, 0),
    my_team_roshans_with_no_building_after: by('my_team').filter((x) => x.buildings_taking_side_took_count === 0).length,
    roshans_i_was_at: takes.filter((x) => x.me === 'holder' || x.me === 'there').length,
    takes,
    rule: knowsKills
      ? `a Roshan here is its kill by a hero, joined to the Aegis pickup by the killing side within ${PICKUP_WITHIN} s; a pickup with no kill row (the last hit was not a hero's) is a take too. attempt = the hits on Roshan back from the kill with no gap over ${ATTEMPT_GAP} s; other_side_when_it_began = where each hero of the other side stood then, and how far from where Roshan died; used = the holder died while holding the Aegis; expired = held 300 s; near = within 2200 of the killer at the kill; what followed = the 300 s from the pickup (from the kill, without one)`
      : 'a Roshan here is an Aegis pickup (this trace has no Roshan kill rows): taken at the second a hero first held the Aegis; used = the holder died while holding it; expired = held 300 s; near = within 2200 of the holder at the pickup; what followed = the 300 s from the pickup',
    gaps: [...gapsOf(trace).filter((g) => g?.topic !== 'roshan'), knowsKills
      ? { topic: 'roshan', reason: 'a Roshan whose last hit was not a hero\'s is seen only by its Aegis pickup, and not at all when nobody picked the Aegis up; who could see an attempt is not in the replay data' }
      : { topic: 'roshan', reason: 'no Roshan kill in this trace (built before kills were kept): a take is an Aegis pickup; a Roshan whose Aegis was denied or left is not seen, nor an Aegis carried in the backpack; who hit Roshan, for how long, and the Tormentors are not known' }],
  };
}

export const ROSHAN_TOOL = {
  name: 'roshan_report',
  description: "Every Roshan the replay shows (an Aegis pickup), from the player's side: when, which side took it, who held the Aegis, who of each side stood near it, where the player was (holder / there / not_there), what else dropped (Cheese, Refresher Shard, Roshan's Banner) and who got it, whether the Aegis was used (its holder died and came back) or expired, and in the 300 s after the pickup: the buildings each side took, the fights and who lost fewer, and the taking side's pushes. Totals per side, and the player's team's Roshans with no building after. Use it for \"what did we do with Roshan / why did their Roshan win them the game\".",
  input_schema: { type: 'object', properties: { hero: { type: 'string', description: 'Hero key as in match_overview, e.g. "beastmaster". The report is told from this hero\'s side: use the player.' } }, required: ['hero'], additionalProperties: false },
  run: roshanReport,
};
