/**
 * lane_phase: the player's laning stage rebuilt from the replay alone — it
 * works for a match OpenDota never parsed (lane_report needs that parse).
 *
 * Told from the player's side, until `until` (default 10:00, at most 15:00):
 * - lanes: which lane each hero spent the most of 1:00–until in, the player's
 *   lane partners and lane opponents, and OpenDota's lane role for that lane;
 * - day and night by five-minute phase, and whether this replay confirms it
 *   (Night Stalker's Void mini-stuns only at night, per Valve's text);
 * - presence: for every second the player was alive in the lane, how many lane
 *   partners and lane opponents stood within 1500 (1v2, 2v2, …);
 * - each partner absence (30 s or more away from the player, alive): where the
 *   partner went, what came of it (enemy deaths they took part in, their own
 *   deaths, wards, levels) and what the lane lost meanwhile (the player's
 *   deaths, seconds dead, levels against the lane opponents) — the trade
 *   measured on both sides; what a 2v2 would have given is not knowable;
 * - each death of the player: the phase, the next night, health and mana,
 *   levels and skill levels, consumables held and used, both lane opponents'
 *   health and distance, the partner's place and whether it was in an absence;
 * - wards placed by both sides (with the placer's place: the ward's own spot is
 *   not in the replay), the player's first ten skill points, levels at 5:00
 *   and 10:00, and how this lane usually goes (STRATZ by bracket, pro games).
 *
 * Facts, derived values (each with the rule that derives it) and what is not
 * known are kept apart. Nothing about vision is claimed: the replay has no fog
 * of war, so "not seen" is never "no vision".
 */
import { HEROES_BY_KEY } from '../../packages/review-engine/src/staticHeroes.js';
import { abilityLevel, dist, heldAt, heroOfName, region, stateAt } from '../../packages/review-engine/src/trace/query.js';
import { traceClock } from '../../packages/review-engine/src/trace/index.js';
import { createRequire } from 'node:module';
import { laneMatchup, MATCHUP_SOURCE } from '../coach/matchups.js';
import { BRACKET_LABEL, RANK_SOURCE, laneVsRank, reviewBracket } from '../coach/matchupsRank.js';
import { patchForGame } from './patchData.js';

const ALL_ABILITIES = createRequire(import.meta.url)('../data/constants/abilities.json');
const BY_KEY = HEROES_BY_KEY;
const slugOf = (hero) => String(hero ?? '').trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_');
const L = (ctx) => (ctx?.lang === 'zh' ? 'zh' : 'en');
const r2 = (n) => Math.round(n * 100) / 100;

export const LANE_START = 60;
export const PHASE = 300;
const NEAR = 1500;
const AWAY = 3000;
const MIN_ABSENCE = 30;
const MERGE_GAP = 5;
const INVOLVED_DAMAGE_WINDOW = 15;
const CONSUMABLES = ['tango', 'flask', 'clarity', 'faerie_fire', 'enchanted_mango', 'magic_stick', 'magic_wand', 'bottle', 'blood_grenade', 'smoke_of_deceit', 'tpscroll'];
const WARDS = { item_ward_observer: 'observer', item_ward_sentry: 'sentry', item_ward_dispenser: 'observer_or_sentry_from_a_dispenser' };

/** The lane a place is in: 'top', 'mid', 'bot', or null (jungle, base). */
export function laneOf(place) {
  if (!place) return null;
  if (place.endsWith('_top_lane')) return 'top';
  if (place.endsWith('_bot_lane')) return 'bot';
  if (place.endsWith('_mid')) return 'mid';
  return null;
}
/** OpenDota's lane role for a team's lane: Radiant's bottom and Dire's top are the safe lanes. */
export function laneRole(team, lane) {
  if (lane === 'mid') return 2;
  if (lane === 'bot') return team === 2 ? 1 : 3;
  if (lane === 'top') return team === 2 ? 3 : 1;
  return null;
}
const ROLE_NAME = { 1: 'safe_lane', 2: 'mid', 3: 'off_lane' };
/** Which side of the river a place is on, from a team's point of view. */
const sideFor = (place, team) => { if (!place) return null; if (place.startsWith('river')) return 'river'; const own = team === 2 ? 'radiant' : 'dire'; return place.startsWith(own) ? 'own_side' : 'enemy_side'; };

/**
 * Day and night by five-minute phase from 0:00 (day first). Checked against this replay where it can be:
 * Valve's text for Night Stalker's Void says "At night, Void also mini-stuns". A Void cast on a hero that the
 * log shows stunning (a stun from Night Stalker within 0.5 s) is a night observation, one that does not is a
 * day observation; the cycle is `observed` when there are both and every one matches it.
 */
export function dayNight(trace, until = trace.n + trace.t0) {
  const phaseAt = (t) => (t < 0 ? 'day' : Math.floor(t / PHASE) % 2 === 0 ? 'day' : 'night');
  const phases = [];
  for (let a = 0; a < until; a += PHASE) phases.push({ from: traceClock(a), to: traceClock(Math.min(a + PHASE, until)), phase: phaseAt(a) });
  const ns = trace.names.indexOf('npc_dota_hero_night_stalker');
  const voidId = trace.names.indexOf('night_stalker_void');
  const darkId = trace.names.indexOf('night_stalker_darkness');
  const stun = trace.names.indexOf('modifier_stunned');
  const obs = [];
  if (ns >= 0 && voidId >= 0) {
    for (const c of trace.casts) {
      if (c[1] !== ns || c[2] !== voidId || heroOfName(trace, c[3]) < 0) continue;
      const stunned = trace.modifiers.some((m) => m[3] === ns && m[1] === c[3] && m[2] === stun && m[4] === 1 && Math.abs(m[0] - c[0]) <= 0.5);
      obs.push({ t: c[0], night: stunned });
    }
  }
  // Dark Ascension makes night for a while whatever the clock: a cast is listed, and its length is not in the data.
  const forced = darkId >= 0 ? trace.casts.filter((c) => c[2] === darkId && c[0] < until).map((c) => traceClock(c[0])) : [];
  // Judged on the stretch asked for, before the first Dark Ascension: after it, night can come off the clock.
  const firstDark = darkId >= 0 ? Math.min(...trace.casts.filter((c) => c[2] === darkId).map((c) => c[0]), Infinity) : Infinity;
  obs.splice(0, obs.length, ...obs.filter((o) => o.t < until && o.t < firstDark));
  const nights = obs.filter((o) => o.night); const days = obs.filter((o) => !o.night);
  const matches = obs.filter((o) => (o.night ? 'night' : 'day') === phaseAt(o.t)).length;
  return {
    rule: 'day and night alternate every 5:00 from day at 0:00',
    basis: nights.length && days.length && matches === obs.length ? 'observed_in_this_replay' : obs.length ? 'contradicted_or_partial_in_this_replay' : 'not_observable_in_this_replay',
    ...(obs.length ? { observations: { void_mini_stunned_at: nights.map((o) => traceClock(o.t)), void_did_not_stun_at: days.map((o) => traceClock(o.t)), matching_the_rule: matches, total: obs.length, valve_text: 'Night Stalker Void: "At night, Void also mini-stuns"' } } : {}),
    ...(forced.length ? { night_forced_by_dark_ascension_at: forced } : {}),
    phases,
    phaseAt,
  };
}

function laneAssignment(trace, until) {
  return trace.heroes.map((h, i) => {
    const count = { top: 0, mid: 0, bot: 0, other: 0 }; let seen = 0;
    for (let t = LANE_START; t < until; t += 1) { const s = stateAt(trace, i, t); if (!s || !s.alive) continue; seen += 1; count[laneOf(region(s.x, s.y)) ?? 'other'] += 1; }
    const best = ['top', 'mid', 'bot'].sort((a, b) => count[b] - count[a])[0];
    // Under 40% of its living time in any one lane: no lane is claimed for it.
    const lane = seen && count[best] / seen >= 0.4 ? best : null;
    return { hero: h.key, team: h.team, lane, share_of_living_time_in_it: seen ? r2(count[best] / seen) : null, seconds_sampled: seen };
  });
}

/** Seconds-runs where `pred(t)` holds, joined across gaps of up to MERGE_GAP, at least `min` long. */
function runs(from, to, pred, min) {
  const out = []; let start = null; let last = null;
  for (let t = from; t < to; t += 1) {
    if (pred(t)) { if (start == null || t - last > MERGE_GAP) { if (start != null && last - start + 1 >= min) out.push([start, last + 1]); start = t; } last = t; }
  }
  if (start != null && last - start + 1 >= min) out.push([start, last + 1]);
  return out;
}

/**
 * The first `n` skill points of hero i, in order, from the replay's ability levels. Only the abilities of
 * `listed` count (the release's list for the hero: no talents, no innate ability levelled at the start).
 */
export function skillOrder(trace, i, listed, n = 10) {
  const keep = new Set(listed);
  const pts = [];
  for (const [key, e] of Object.entries(trace.abilities[i] ?? {})) {
    if (key.startsWith('special_bonus')) continue;
    let prev = 0;
    for (const [at, level] of e.levels ?? []) { for (let l = prev + 1; l <= level; l += 1) pts.push({ t: at, ability: key, level: l }); prev = level; }
  }
  // Points read at the same sample keep the order of their levels; only real ability keys of the hero count.
  return pts.filter((p) => keep.has(p.ability)).sort((a, b) => a.t - b.t || a.level - b.level).slice(0, n);
}

export function lanePhase(trace, args = {}, ctx = {}) {
  const lang = L(ctx);
  const slug = slugOf(args.hero ?? ctx.perspective);
  const me = trace.heroes.findIndex((h) => h.key === slug);
  if (me < 0) return { error: 'unknown_hero', heroes: trace.heroes.map((h) => h.key) };
  const until = Math.round(Math.min(900, Math.max(300, Number(args.until) || 600)));
  const pd = patchForGame(trace.match_id, ctx.match);
  const team = trace.heroes[me].team;
  const lanes = laneAssignment(trace, until);
  // The release's ability list for the hero: what counts as a skill point.
  const listed = (pd.heroAbilities(BY_KEY.get(slug)?.id) ?? []).map((a) => a.id);
  const myLane = lanes[me].lane;
  const dn = dayNight(trace, until);
  const npcIndex = (i) => trace.names.indexOf(trace.heroes[i].npc);
  const partners = myLane ? lanes.map((l, i) => ({ ...l, i })).filter((l) => l.i !== me && l.team === team && l.lane === myLane) : [];
  const opponents = myLane ? lanes.map((l, i) => ({ ...l, i })).filter((l) => l.team !== team && l.lane === myLane) : [];
  const at = (i, t) => stateAt(trace, i, t);
  const levelAt = (i, t) => at(i, t)?.level ?? null;

  // Every second the player was alive in the lane: how many partners and opponents stood within NEAR.
  const presence = {}; let laneSeconds = 0; let unknownSeconds = 0;
  for (let t = LANE_START; t < until; t += 1) {
    const s = at(me, t);
    if (!s) { unknownSeconds += 1; continue; }
    if (!s.alive || laneOf(region(s.x, s.y)) !== myLane) continue;
    const count = (list) => { let n = 0; for (const o of list) { const x = at(o.i, t); if (x == null) return null; if (x.alive && dist(s, x) <= NEAR) n += 1; } return n; };
    const a = count(partners); const e = count(opponents);
    if (a == null || e == null) { unknownSeconds += 1; continue; }
    laneSeconds += 1;
    const key = `${a + 1}v${e}`;
    presence[key] = (presence[key] ?? 0) + 1;
  }

  const myNpc = npcIndex(me);
  const allDeaths = trace.deaths.filter((d) => d[0] < until);
  const myDeaths = allDeaths.filter((d) => d[1] === myNpc).sort((a, b) => a[0] - b[0]);
  const killerOf = (d) => { const k = heroOfName(trace, d[2]); return k >= 0 ? trace.heroes[k].key : (trace.names[d[2]] ?? '').replace(/^npc_dota_/, '') || null; };
  const enemyIdx = trace.heroes.map((h, i) => i).filter((i) => trace.heroes[i].team !== team);

  // Partner absences: alive and farther than AWAY from the player (or, while the player is dead, out of the lane).
  const absences = partners.map((p) => {
    const away = (t) => { const x = at(p.i, t); if (!x || !x.alive) return false; const s = at(me, t); return s && s.alive ? dist(s, x) > AWAY : laneOf(region(x.x, x.y)) !== myLane; };
    return runs(LANE_START, until, away, MIN_ABSENCE).map(([from, to], k) => {
      const places = {};
      for (let t = from; t < to; t += 1) { const x = at(p.i, t); if (x) { const r = region(x.x, x.y); places[r] = (places[r] ?? 0) + 1; } }
      const pNpc = npcIndex(p.i);
      const enemyDeaths = allDeaths.filter((d) => d[0] >= from && d[0] <= to + 5 && enemyIdx.some((e) => npcIndex(e) === d[1])).map((d) => {
        const victim = heroOfName(trace, d[1]);
        const px = at(p.i, d[0]); const vx = at(victim, d[0] - 1);
        const near = px && vx ? dist(px, vx) <= NEAR : null;
        const hit = trace.damage.some(([sec, a, tgt]) => a === pNpc && tgt === d[1] && sec >= d[0] - INVOLVED_DAMAGE_WINDOW && sec <= d[0]);
        return { clock: traceClock(d[0]), hero: trace.heroes[victim].key, killer: killerOf(d), partner_within_1500: near, partner_damaged_them_in_15s: hit };
      });
      const wards = trace.item_uses.filter((u) => u[1] === pNpc && u[0] >= from && u[0] <= to && WARDS[trace.names[u[2]]]).map((u) => { const x = at(p.i, u[0]); return { clock: traceClock(u[0]), kind: WARDS[trace.names[u[2]]], placer_at: x ? region(x.x, x.y) : null }; });
      const mine = myDeaths.filter((d) => d[0] >= from && d[0] <= to);
      let deadSeconds = 0; let aloneVs2 = 0;
      for (let t = from; t < to; t += 1) {
        const s = at(me, t); if (!s) continue;
        if (!s.alive) { deadSeconds += 1; continue; }
        if (opponents.length >= 2 && opponents.every((o) => { const x = at(o.i, t); return x && x.alive && dist(s, x) <= NEAR; })) aloneVs2 += 1;
      }
      const lv = (t) => ({ me: levelAt(me, t), partner: levelAt(p.i, t), ...Object.fromEntries(opponents.map((o) => [o.hero, levelAt(o.i, t)])) });
      return {
        ref: `absence:${slug}:${p.hero}:${k + 1}`, partner: p.hero, from: traceClock(from), to: traceClock(to), seconds: to - from,
        partner_was_in: Object.entries(places).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([place, s]) => ({ place, seconds: s })),
        // What the absence produced, as far as the replay shows it.
        payoff_measured: {
          enemy_hero_deaths: enemyDeaths, enemy_hero_deaths_partner_took_part_in: enemyDeaths.filter((x) => x.partner_within_1500 || x.partner_damaged_them_in_15s).length,
          partner_deaths: allDeaths.filter((d) => d[1] === pNpc && d[0] >= from && d[0] <= to).map((d) => ({ clock: traceClock(d[0]), killer: killerOf(d) })),
          partner_casts_on_enemy_heroes: trace.casts.filter((c) => c[1] === pNpc && c[0] >= from && c[0] <= to && enemyIdx.some((e) => npcIndex(e) === c[3])).length,
          wards_placed: wards,
        },
        // What the lane lost meanwhile.
        cost_measured: {
          my_deaths: mine.map((d) => ({ clock: traceClock(d[0]), killer: killerOf(d) })),
          my_seconds_dead: deadSeconds,
          my_seconds_alive_with_both_lane_opponents_within_1500: opponents.length >= 2 ? aloneVs2 : null,
        },
        levels_at_start: lv(from), levels_at_end: lv(to),
        not_measurable: ['what_staying_for_the_2v2_would_have_given', 'gold_and_last_hits', 'creep_waves_and_pulls'],
      };
    });
  }).flat();
  const absenceAt = (t) => absences.find((a) => { const f = toSec(a.from); return t >= f && t <= f + a.seconds; }) ?? null;

  const consumablesAt = (t) => Object.entries(trace.items[me] ?? {}).filter(([k, e]) => CONSUMABLES.includes(k.replace(/^item_/, '')) && heldAt(e, t)).map(([k]) => k.replace(/^item_/, ''));
  const deaths = myDeaths.map((d, n) => {
    const t = d[0];
    const s10 = at(me, t - 10); const s1 = at(me, t - 1);
    const phase = dn.phaseAt(t);
    const opp = opponents.map((o) => { const x10 = at(o.i, t - 10); const x1 = at(o.i, t - 1); return { hero: o.hero, level: x1?.level ?? null, health_share_10s_before: x10?.max_hp ? r2(x10.hp / x10.max_hp) : null, health_share_1s_before: x1?.max_hp && x1.alive ? r2(x1.hp / x1.max_hp) : null, distance_1s_before: x1 && s1 && x1.alive ? dist(x1, s1) : null, alive: x1 ? x1.alive : null }; });
    // The trade in the 15 s before: damage the player dealt to and took from each lane opponent, and their spells on the player.
    const trade = (from, to) => { let v = 0; for (const [sec, a, tgt, , val] of trace.damage) if (a === from && tgt === to && sec >= t - 15 && sec <= t) v += val; return v; };
    const damage = Object.fromEntries(opponents.map((o) => [o.hero, { dealt_by_me: trade(myNpc, npcIndex(o.i)), taken_by_me: trade(npcIndex(o.i), myNpc) }]));
    const spellsOnMe = trace.casts.filter((c) => c[3] === myNpc && c[0] >= t - 15 && c[0] <= t && opponents.some((o) => npcIndex(o.i) === c[1])).map((c) => ({ by: trace.heroes[heroOfName(trace, c[1])].key, ability: trace.names[c[2]], seconds_before_death: Math.round((t - c[0]) * 10) / 10 }));
    const part = partners.map((p) => { const x = at(p.i, t - 1); const died = allDeaths.filter((pd2) => pd2[1] === npcIndex(p.i) && pd2[0] <= t && pd2[0] >= t - 60).at(-1); return { hero: p.hero, alive: x ? x.alive : null, ...(died ? { died_seconds_before: Math.round((t - died[0]) * 10) / 10, killed_by: killerOf(died) } : {}), distance_1s_before: x && s1 && x.alive ? dist(x, s1) : null, at: x ? region(x.x, x.y) : null, in_an_absence: Boolean(absences.find((a) => a.partner === p.hero && t >= toSec(a.from) && t <= toSec(a.from) + a.seconds)) }; });
    const abil = Object.fromEntries(Object.entries(trace.abilities[me] ?? {}).filter(([k]) => listed.includes(k)).map(([k, e]) => [k, abilityLevel(e, t - 1)]).filter(([, v]) => v > 0));
    const used = trace.item_uses.filter((u) => u[1] === myNpc && u[0] >= t - 15 && u[0] <= t).map((u) => trace.names[u[2]].replace(/^item_/, ''));
    return {
      // Not this record's own ref: death_context's record of the same death, for the full window.
      death_context_ref: `death:${slug}:${n + 1}`, clock: traceClock(t), killer: killerOf(d), phase,
      ...(phase === 'day' ? { next_night_in_seconds: Math.round(PHASE - (Math.max(0, t) % PHASE)) } : { night_ends_in_seconds: Math.round(PHASE - (Math.max(0, t) % PHASE)) }),
      place: s1 ? region(s1.x, s1.y) : null, side_of_river: s1 ? sideFor(region(s1.x, s1.y), team) : null,
      my_level: s1?.level ?? null, my_skill_levels: abil,
      my_health_share_10s_before: s10?.max_hp ? r2(s10.hp / s10.max_hp) : null, my_mana_10s_before: s10?.mana ?? null,
      consumables_held_10s_before: s10 ? consumablesAt(t - 10) : null, items_used_in_last_15s: used,
      damage_in_last_15s_with_lane_opponents: damage, lane_opponent_unit_target_spells_on_me_in_last_15s: spellsOnMe,
      lane_opponents: opp, lane_partners: part,
      other_allies_within_2200: trace.heroes.map((h, i) => i).filter((i) => i !== me && trace.heroes[i].team === team && !partners.some((p) => p.i === i)).filter((i) => { const x = at(i, t - 1); return x && s1 && x.alive && dist(x, s1) <= 2200; }).map((i) => trace.heroes[i].key),
    };
  });

  const wards = trace.item_uses.filter((u) => u[0] < until && WARDS[trace.names[u[2]]]).map((u) => { const h = heroOfName(trace, u[1]); const x = h >= 0 ? at(h, u[0]) : null; return h < 0 ? null : { clock: traceClock(u[0]), side: trace.heroes[h].team === team ? 'my_team' : 'enemy', hero: trace.heroes[h].key, kind: WARDS[trace.names[u[2]]], placer_at: x ? region(x.x, x.y) : null }; }).filter(Boolean);
  const order = skillOrder(trace, me, listed);
  const names = (key) => { const a = pd.heroAbilities(BY_KEY.get(slug)?.id)?.find((x) => x.id === key); return a ? a[lang] ?? a.en : ALL_ABILITIES[key]?.dname ?? key; };
  const nightText = Object.keys(trace.abilities[me] ?? {}).filter((k) => /night/i.test(ALL_ABILITIES[k]?.desc ?? '')).map((k) => ({ ability: k, name: names(k), valve_says: String(ALL_ABILITIES[k].desc).replace(/\s+/g, ' ').trim() }));

  // How this lane usually goes: the player's hero against each lane opponent.
  const meId = BY_KEY.get(slug)?.id;
  const myPlayer = (ctx.match?.players ?? []).find((p) => p && p.hero_id === meId);
  const bracket = ctx.match ? reviewBracket(ctx.match.players, myPlayer ?? {}) : null;
  const baselines = opponents.map((o) => {
    const v = BY_KEY.get(o.hero)?.id;
    const pub = bracket && v != null ? laneVsRank(meId, v, bracket.key) : null;
    const pro = v != null ? laneMatchup(meId, v) : null;
    return {
      against: o.hero,
      in_public_lanes_of_this_bracket: pub ? { bracket: pub.bracket, bracket_name: BRACKET_LABEL[pub.bracket]?.[lang] ?? pub.bracket, lanes: pub.n, share_won: r2(pub.won), share_even: r2(pub.even), share_lost: r2(pub.lost), share_lost_badly: r2(pub.stomped), matchup: pub.verdict, source: 'STRATZ', patch: RANK_SOURCE.patch, weeks: RANK_SOURCE.weeks } : null,
      in_pro_lanes: pro ? { games: pro.n, core_gold_difference_at_10_00_mean: pro.mean, matchup: pro.verdict, since: MATCHUP_SOURCE.since } : null,
    };
  });

  const role = laneRole(team, myLane);
  return {
    ref: `lane_phase:${slug}`, hero: slug, until: traceClock(until), data_release: pd.name, release_exact: pd.exact,
    facts: {
      my_lane: myLane, my_lane_role: role ? ROLE_NAME[role] : null, opendota_lane_role: role,
      lane_partners: partners.map((p) => p.hero), lane_opponents: opponents.map((o) => o.hero),
      lanes: lanes.map((l) => ({ hero: l.hero, side: l.team === team ? 'my_team' : 'enemy', lane: l.lane, share_of_living_time_in_it: l.share_of_living_time_in_it })),
      seconds_alive_in_lane_by_heroes_within_1500: presence,
      seconds_alive_in_lane: laneSeconds,
      levels_at_5_00: Object.fromEntries(trace.heroes.map((h, i) => [h.key, levelAt(i, 300)])),
      // When each hero of the lane first had level 6 (null: not by the end of the replay's samples).
      level_6_at: Object.fromEntries([me, ...partners.map((p) => p.i), ...opponents.map((o) => o.i)].map((i) => { const lv = trace.states[i]?.level ?? []; const k = lv.findIndex((x) => x != null && x >= 6); return [trace.heroes[i].key, k < 0 ? null : traceClock(k + trace.t0)]; })),
      levels_at_10_00: until >= 600 ? Object.fromEntries(trace.heroes.map((h, i) => [h.key, levelAt(i, 600)])) : null,
      my_first_skill_points: order.map((p) => ({ level_point: order.indexOf(p) + 1, ability: p.ability, name: names(p.ability), clock: traceClock(p.t) })),
      my_deaths: deaths,
      partner_absences: absences,
      wards_placed: wards,
    },
    day_and_night: { rule: dn.rule, basis: dn.basis, ...(dn.observations ? { observations: dn.observations } : {}), ...(dn.night_forced_by_dark_ascension_at ? { night_forced_by_dark_ascension_at: dn.night_forced_by_dark_ascension_at } : {}), phases: dn.phases, ...(nightText.length ? { my_abilities_that_change_at_night: nightText } : {}) },
    lane_baselines: baselines,
    derived_rules: {
      lane: 'the lane (top, mid, bottom) a hero spent the most living time in from 1:00, when it is 40% or more of that time',
      presence: 'per second the player was alive in their lane: lane partners and lane opponents alive within 1500, counted as <partners + me>v<opponents>',
      absence: `a lane partner alive and more than ${AWAY} from the player (or out of the lane while the player was dead) for ${MIN_ABSENCE} s or more, gaps of up to ${MERGE_GAP} s joined`,
      took_part: 'an enemy death counts as one the partner took part in when the partner was within 1500 of the victim or damaged them in the 15 s before',
      day_night: dn.rule,
    },
    not_known: [
      { topic: 'vision', reason: 'no_fog_of_war_in_the_replay: who could see whom is unknown, which is not the same as nobody seeing' },
      { topic: 'ward_spots', reason: 'only_the_placer_position_is_known; a dispenser use can be a placement or a switch between ward types' },
      { topic: 'point_and_area_spells_on_me', reason: 'the_log_names_no_target_for_them: only unit-target spells are listed per death; damage_in_last_15s counts all of them' },
      { topic: 'item_charges', reason: 'not_in_the_replay_trace: a Magic Wand held may have had no charges' },
      { topic: 'creep_waves_pulls_and_lane_equilibrium', reason: 'no_creep_entities_in_the_replay' },
      { topic: 'gold_and_last_hits', reason: ctx.match?.players?.some((p) => Array.isArray(p?.gold_t)) ? 'see_lane_report' : 'match_not_parsed_for_per_minute_gold' },
      { topic: 'what_a_player_intended_or_was_told', reason: 'not_in_the_replay' },
      ...(dn.basis === 'observed_in_this_replay' ? [] : [{ topic: 'day_night', reason: `${dn.basis}; the 5:00 cycle is assumed` }]),
      ...(pd.exact ? [] : [{ topic: 'release', reason: `${pd.reason}; ${pd.name} data used` }]),
      ...(bracket ? [] : [{ topic: 'public_lane_baseline', reason: ctx.match ? 'bracket_unknown' : 'no_match_data_for_this_game' }]),
    ],
    note: 'Facts are counted from the replay. A partner absence is a trade: payoff_measured is what it produced, cost_measured what the lane lost meanwhile; what staying would have produced is not measurable, so judge the decision from what each side had at the time (levels, health, the phase of day and night, the lane opponents) and say it is a judgment. Do not read a later outcome back into an earlier choice. Vision is unknown, not absent.',
  };
}
const toSec = (clock) => { const m = String(clock).match(/^(-)?(\d+):(\d\d)$/); return m ? (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : NaN; };

const HERO = { type: 'string', description: 'Hero key as in match_overview. Use the player\'s hero.' };
export const LANE_PHASE_TOOL = {
  name: 'lane_phase',
  description: 'The player\'s laning stage from the replay alone (works when lane_report has no economy): who laned where and the lane role; per second alive in lane, how many partners and lane opponents were within 1500 (1v2, 2v2); every absence of a lane partner — where they went, what it produced (enemy deaths they took part in, their deaths, wards) and what the lane lost meanwhile (your deaths, seconds dead, levels); each of your deaths before the end of the lane with day or night and the time to the next night, health, mana, skill levels, consumables, the lane opponents\' health and distance, where your partner was; wards placed by both sides; your first ten skill points; levels at 5:00 and 10:00; how this lane usually goes in public games of your bracket and in pro games. Use it before saying anything about the lane, a support leaving it, or what to do when left alone.',
  input_schema: { type: 'object', properties: { hero: HERO, until: { type: 'integer', description: 'End of the stretch in seconds (300–900, default 600).' } }, required: ['hero'], additionalProperties: false },
  run: lanePhase,
};
