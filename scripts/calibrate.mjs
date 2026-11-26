#!/usr/bin/env node
/**
 * What decides fights and pushes, measured on parsed games.
 * - Fights: for every fight with a winner (one side lost fewer heroes), how often the side ahead on each
 *   pre-fight measure of fight_report won it.
 * - Pushes (siege_report): how often a push took its building, by how many more heroes hit it than its
 *   owners had near, and by how many of the owners were dead when it began.
 * - Deaths (death_context): how often a death was traded (an enemy hero died within 15 s), by how many allies
 *   were within 2200 at it; and, every 5 s from 10:00, how often a living hero died in the next 20 s, by
 *   allies near and side of the map — whether standing alone is itself the danger.
 * - Wards (traces with a ward list): the same two questions split by observer wards within 1600 — a death's trade
 *   rate by whether the dead hero's side or the enemy had one near it, and the 20 s death rate of a living hero by
 *   enemy observers near them. Placements only, not what each side saw.
 * - After won fights (decision_points): by how many of the losers were still dead 10 s after, what the winners did —
 *   took a building, took Roshan, pushed and took nothing, or neither.
 * - After towers fell (decision_points): for each tier 1–3 tower taken, by tier and whether a won fight came first,
 *   what the takers did in the next 120 s and how often they lost a building of their own meanwhile.
 * - Fights after big items (decision_points): of the fights begun within 120 s after big items of one side only, how
 *   often that side lost fewer heroes, by whether it was ahead in gold; and the gold-ahead side's rate in the others.
 * - Ultimate edges: every moment a side came to have two or more ultimates ready than the other, whether a fight
 *   began (its first damage exchange) within 90 s, and how it went for that side.
 * - After won fights, by the losers' richest hero (games with net worth): with three or more losers still dead, how
 *   often the winners took a building when the richest was among them 30 s or more from respawning, or alive.
 * - Key moments (key_moments, gold-earned lead only): for each side, the largest falling stretch of its win chance —
 *   how far and how long, and for a lost game whether match_overview's turning fight is inside it — and, for every
 *   hero of a losing side, how the chance the team lost across fights splits by where that hero was.
 * - Roshans (roshan_report): each Aegis pickup, whether it was used or expired, and the buildings each side took
 *   in the 300 s after.
 *
 *   node scripts/calibrate.mjs <dir with *.trace.json.gz> [--json]
 *
 * Production traces: gs://<bucket>/agent/*.trace.json.gz. The numbers quoted in
 * docs/GAME_UNDERSTANDING.md and lib/agent/fightReport.js come from this script; re-run it
 * when the corpus grows and update both.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fightReport, ultimateEdges } from '../lib/agent/fightReport.js';
import { siegeReport } from '../lib/agent/siegeReport.js';
import { roshanReport } from '../lib/agent/roshanReport.js';
import { keyMoments } from '../lib/agent/keyMoments.js';
import { wardPlacers } from '../lib/agent/wardReport.js';
import { afterWonFights, afterTowersFell, fightsAfterBigItems, richestOf, LONG_RESPAWN, STILL_DEAD_AFTER } from '../lib/agent/decisionPoints.js';
import { moneyOf } from '../lib/agent/farmReport.js';
import { fightParticipation, goldAdvantage, linkHeroNames, matchFights, runTraceTool } from '../packages/review-engine/src/trace/index.js';
import { dist, heroOfName, region, stateAt } from '../packages/review-engine/src/trace/query.js';
import { heroStateAt, observersNear } from '../packages/review-engine/src/trace/state.js';

const dir = process.argv[2];
if (!dir) { console.error('usage: calibrate.mjs <dir> [--json]'); process.exit(2); }
const files = readdirSync(dir).filter((f) => f.endsWith('.trace.json.gz'));
const rows = [];
const pushes = [];
const deaths = [];
const moments = [];
const roshans = [];
// Roshan read from its kill rows (traces built since they were kept): one row per kill a hero landed.
const roshanKills = []; let gamesWithKillRows = 0; let pickupsWithNoKill = 0;
let wardGames = 0;
const afterWins = [];
const afterTowers = [];
const ultEdges = [];
const itemFights = [];
const plainFights = [];
const notInFight = []; let gamesWithCreepKills = 0;
const momentSides = []; const momentHeroes = [];
const wardTeams = []; let wardsPlaced = 0; let wardsPlacerUnknown = 0;
const saves = { ability: { n: 0, died: 0 }, item: { n: 0, died: 0 }, nothing: { n: 0, died: 0 }, heavy_given: { n: 0, died: 0 }, heavy_nothing: { n: 0, died: 0 } }; let saveGames = 0;
for (const f of files) {
  // As the site reads a stored trace: hero names linked to the combat log's.
  const trace = linkHeroNames(JSON.parse(gunzipSync(readFileSync(join(dir, f)))));
  // From Radiant's first hero: my_team = Radiant. Every fight is read once.
  const first = trace.heroes.find((h) => h.team === 2);
  for (const hero of trace.heroes) {
    for (const d of runTraceTool(trace, 'death_context', { hero: hero.key }).deaths ?? []) if (d.allies_within_2200.at_death != null) deaths.push({ allies: d.allies_within_2200.at_death, traded: d.traded_within_15s, obs: d.observers_within_1600 ?? null });
  }
  if (Array.isArray(trace.wards)) wardGames += 1;
  // Alive heroes not in a fight (fightParticipation): what the state says they were doing as it began — farming
  // only on traces that keep creep kills.
  if (Array.isArray(trace.creep_kills)) {
    gamesWithCreepKills += 1;
    for (const fight of matchFights(trace)) {
      const part = fightParticipation(trace, fight);
      trace.heroes.forEach((_, i) => { if (part.took_part.has(i)) return; const s = heroStateAt(trace, i, fight.from); if (s.known && s.alive) notInFight.push(s.doing); });
    }
  }
  // ward_report: who placed each ward (an item use of the side within 0.2 s), and per team the two heroes who placed most observers.
  // save_report: an ally under enemy-hero damage (the 3 s up to it), and whether they died within 5 s — after an ally's
  // ability or item on them, or with nothing given (every 5 s from 10:00). Only traces whose item uses keep a target.
  if ((trace.item_uses ?? []).some((u) => u.length >= 5)) {
    saveGames += 1;
    const nx = trace.heroes.map((h) => trace.names.indexOf(h.npc)); const seat = new Map(nx.map((x, i) => [x, i]));
    const dmg = new Map();
    for (const d of trace.damage) { const a = seat.get(d[1]); const b = seat.get(d[2]); if (a == null || b == null || trace.heroes[a].team === trace.heroes[b].team) continue; const k = `${d[0]}|${b}`; dmg.set(k, (dmg.get(k) ?? 0) + d[4]); }
    const took = (i, s) => { let v = 0; for (let k = s - 3; k <= s; k += 1) v += dmg.get(`${k}|${i}`) ?? 0; return v; };
    const died = (i, s) => trace.deaths.some((d) => d[1] === nx[i] && d[0] > s && d[0] <= s + 5);
    const recv = trace.heroes.map(() => new Set());
    const mark = (giver, to, s, kind) => { const a = seat.get(giver); const b = seat.get(to); if (a == null || b == null || a === b || trace.heroes[a].team !== trace.heroes[b].team) return; recv[b].add(Math.floor(s)); const tk = took(b, Math.floor(s)); if (tk <= 0) return; saves[kind].n += 1; if (died(b, s)) saves[kind].died += 1; if (tk >= 300) { saves.heavy_given.n += 1; if (died(b, s)) saves.heavy_given.died += 1; } };
    for (const c of trace.casts) mark(c[1], c[3], c[0], 'ability');
    for (const u of trace.item_uses) if (u.length >= 5 && u[4] != null) mark(u[1], u[4], u[0], 'item');
    for (let s = 600; s < trace.t0 + trace.n - 6; s += 5) trace.heroes.forEach((_, i) => { if (trace.states[i].alive[s - trace.t0] !== 1) return; const tk = took(i, s); if (tk <= 0) return; for (let k = s - 3; k <= s + 1; k += 1) if (recv[i].has(k)) return; saves.nothing.n += 1; if (died(i, s)) saves.nothing.died += 1; if (tk >= 300) { saves.heavy_nothing.n += 1; if (died(i, s)) saves.heavy_nothing.died += 1; } });
  }
  const placers = wardPlacers(trace);
  if (placers) {
    trace.wards.forEach((w, j) => { if (w[0] == null) return; wardsPlaced += 1; if (placers[j] === null) wardsPlacerUnknown += 1; });
    for (const tm of [2, 3]) { const c = trace.heroes.map((h, i) => i).filter((i) => trace.heroes[i].team === tm).map((i) => trace.wards.filter((w, j) => placers[j] === i && w[3] === 'o').length).sort((a, b) => b - a); wardTeams.push(c[0], c[1]); }
  }
  // Key moments, from each side once (its first hero), and every losing hero's split of the falls.
  for (const tm of [2, 3]) {
    const heroes = trace.heroes.filter((x) => x.team === tm);
    const km = keyMoments(trace, { hero: heroes[0].key });
    if (!km.read) continue;
    const ov = runTraceTool(trace, 'match_overview', {}, { perspective: heroes[0].key });
    const turn = ov.turning_fight?.ref ?? null;
    const st = km.stretch;
    momentSides.push({ lost: km.result === 'my_team_lost', lanes: ov.lanes?.lost_from_the_lanes ?? null, fall: st ? st.my_team_win_chance_from - st.my_team_win_chance_to : 0, minutes: st ? Number(st.to.split(':')[0]) - Number(st.from.split(':')[0]) : 0, turn, turnInside: turn && st ? st.fights.some((x) => x.ref === turn) : null, notRead: km.fights_not_read });
    if (km.result !== 'my_team_lost') continue;
    for (const x of heroes) { const k = keyMoments(trace, { hero: x.key }); if (k.read && k.falls_by_my_part.in_it != null) momentHeroes.push(k.falls_by_my_part); }
  }
  // Every 5 s from 10:00 to 20 s before the end: each living hero, and whether they died in the next 20 s.
  const died = trace.heroes.map((_, i) => trace.deaths.filter((d) => heroOfName(trace, d[1]) === i).map((d) => d[0]));
  for (let sec = 600; sec < trace.t0 + trace.n - 20; sec += 5) {
    const at = trace.heroes.map((_, i) => stateAt(trace, i, sec));
    trace.heroes.forEach((h, i) => {
      const s = at[i]; if (!s?.alive) return;
      const allies = trace.heroes.filter((o, j) => j !== i && o.team === h.team && at[j]?.alive && dist(at[j], s) <= 2200).length;
      const side = region(s.x, s.y); const enemyHalf = h.team === 2 ? side.startsWith('dire') : side.startsWith('radiant');
      const o = observersNear(trace, s, sec);
      moments.push({ allies, enemyHalf, died: died[i].some((d) => d > sec && d <= sec + 20), obs: o && { mine: o[h.team], enemy: o[h.team === 2 ? 3 : 2] } });
    });
  }
  // The losers' richest at the fight's start (the replay's net worth here: no match data), null when unknown.
  const money = moneyOf(trace, null, Math.floor((trace.t0 + trace.n - 1) / 60));
  for (const x of afterWonFights(trace)) {
    const rich = richestOf(trace, money, x.loser, Math.floor(x.from / 60));
    const dead = rich == null ? null : x.still_dead.find((d) => d.i === rich);
    // Dead with no known respawn time, or not sampled at that second: not known, never counted as alive (review of #312).
    const richest = rich == null ? null
      : dead ? (dead.respawn_in == null ? 'not_known' : dead.respawn_in >= LONG_RESPAWN ? 'dead_30s_or_more' : 'dead_under_30s')
        : stateAt(trace, rich, x.to + STILL_DEAD_AFTER) ? 'alive' : 'not_known';
    afterWins.push({ stillDead: x.still_dead.length, did: x.did, richest });
  }
  // Fights with a winner: those after big items of one side only (by that side's gold lead), and those after none.
  const withItems = new Map(fightsAfterBigItems(trace).fights.map((x) => [x.fight, x]));
  const adv = goldAdvantage(trace);
  matchFights(trace).forEach((f, fi) => {
    const lost = { 2: 0, 3: 0 };
    for (const d of f.deaths) { const v = heroOfName(trace, d[1]); if (v >= 0) lost[trace.heroes[v].team] += 1; }
    if (lost[2] === lost[3]) return;
    // The gold lead the minute it began: its first damage exchange, as fightsAfterBigItems reads it.
    const winner = lost[2] < lost[3] ? 2 : 3; const lead = adv?.[Math.floor(fightParticipation(trace, f).engaged_at / 60)];
    const x = withItems.get(fi + 1);
    if (!x) { if (Number.isFinite(lead) && lead) plainFights.push({ aheadWon: (lead > 0) === (winner === 2) }); return; }
    const sides = new Set(x.items.map((it) => it.team)); if (sides.size !== 1) return;
    const side = [...sides][0];
    itemFights.push({ won: side === winner, ahead: Number.isFinite(lead) && lead ? (lead > 0) === (side === 2) : null });
  });
  for (const x of ultimateEdges(trace)) ultEdges.push({ result: x.result });
  for (const x of afterTowersFell(trace)) afterTowers.push({ tier: x.tier, fight: x.fight != null, did: x.did, traded: x.lostBack.length > 0 });
  const ro = roshanReport(trace, { hero: first.key });
  if (ro.read_from === 'roshan_kills_and_aegis_pickups') gamesWithKillRows += 1;
  for (const x of ro.takes ?? []) {
    // The kill, when the trace kept it: who hit Roshan, for how long, whether the Aegis followed.
    // Kill or pickup by what the take was read from — not by whether its hits were kept: a kill whose damage rows
    // the trace lacks is still a kill, and its attempt is unknown (null), not left out of the kills.
    if (x.seen_by === 'kill' || x.seen_by === 'kill_and_aegis_pickup') roshanKills.push({ picked_up: x.seen_by === 'kill_and_aegis_pickup' && !x.aegis_stolen, stolen: x.aegis_stolen === true, hitters: x.attempt ? x.attempt.heroes_hitting.length : null, others: x.attempt ? x.attempt.other_side_hitting.length : null, seconds: x.attempt ? x.attempt.seconds : null });
    else if (ro.read_from === 'roshan_kills_and_aegis_pickups') pickupsWithNoKill += 1;
    // The table below is over Aegis pickups, as it always was: a kill nobody picked the Aegis up after has none of this.
    if (!x.aegis_holder) continue;
    // Read from the side that held the Aegis: after a steal, the killers' buildings are the other side's.
    const ours = x.buildings_taking_side_took_count; const theirs = x.buildings_other_side_took_in_the_next_300s.length;
    roshans.push({ aegis: x.aegis, took: x.aegis_stolen ? theirs : ours, lost: x.aegis_stolen ? ours : theirs, fights: x.fights_in_the_next_300s });
  }
  for (const p of siegeReport(trace, { hero: first.key }).pushes ?? []) {
    pushes.push({ took: p.took_it, margin: p.hitting_minus_owners_near, deadOwners: p.owners_dead_when_it_began });
  }
  const r = fightReport(trace, { hero: first.key });
  if (r.error) continue;
  for (const x of r.fights) {
    if (x.lost_fewer_heroes === 'even') continue;
    const m = x.my_team; const e = x.enemy;
    rows.push({
      match: trace.match_id, fight: x.fight, won: x.lost_fewer_heroes === 'my_team' ? 1 : -1,
      heroes: m.took_part_count - e.took_part_count,
      ultimates: m.ultimates_ready.length - e.ultimates_ready.length,
      levels: m.levels_of_those_in_it - e.levels_of_those_in_it,
      bkbs: m.black_king_bars_ready.length - e.black_king_bars_ready.length,
      gold: Number.isFinite(x.my_team_gold_lead) ? x.my_team_gold_lead : null,
    });
  }
}
const sgn = (v) => (v == null || v === 0 ? 0 : v > 0 ? 1 : -1);
function measure(name, pick) {
  let n = 0; let ok = 0;
  for (const r of rows) { const p = sgn(pick(r)); if (!p) continue; n += 1; if (p === r.won) ok += 1; }
  return { measure: name, fights: n, side_ahead_won: ok, rate: n ? Math.round((ok / n) * 100) : null };
}
const out = {
  games: files.length,
  fights_with_a_winner: rows.length,
  measures: [
    measure('more heroes took part', (r) => r.heroes),
    measure('two or more heroes more took part', (r) => (Math.abs(r.heroes) >= 2 ? r.heroes : 0)),
    measure('more ultimates ready', (r) => r.ultimates),
    measure('more Black King Bars ready', (r) => r.bkbs),
    measure('more levels among those in it', (r) => r.levels),
    measure('gold lead that minute', (r) => r.gold),
    measure('more heroes, else more ultimates, else gold', (r) => sgn(r.heroes) || sgn(r.ultimates) || sgn(r.gold)),
    measure('gold behind but more heroes took part', (r) => (sgn(r.gold) && sgn(r.heroes) && sgn(r.gold) !== sgn(r.heroes) ? r.heroes : 0)),
  ],
};
const share = (list) => ({ pushes: list.length, took_it: list.filter((p) => p.took).length, rate: list.length ? Math.round((list.filter((p) => p.took).length / list.length) * 100) : null });
// In order, as a list: an object's number-like keys would be sorted ahead of the others.
const bucket = (key, lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).map((v) => ({ value: v === lo ? (v === 0 ? '0' : `${v} or fewer`) : v === hi ? `${v} or more` : String(v), ...share(pushes.filter((p) => (v === lo ? key(p) <= v : v === hi ? key(p) >= v : key(p) === v))) }));
out.pushes = {
  total: share(pushes),
  by_heroes_hitting_minus_owners_near: bucket((p) => p.margin, -1, 3),
  two_or_more_hitting_than_near: share(pushes.filter((p) => p.margin >= 2)),
  at_most_one_more_hitting_than_near: share(pushes.filter((p) => p.margin <= 1)),
  by_owners_dead_when_it_began: bucket((p) => p.deadOwners, 0, 4),
};
const traded = (list) => ({ deaths: list.length, traded: list.filter((d) => d.traded).length, rate: list.length ? Math.round((list.filter((d) => d.traded).length / list.length) * 100) : null });
const risk = (list) => ({ moments: list.length, died_within_20s: list.filter((m) => m.died).length, rate: list.length ? Math.round((list.filter((m) => m.died).length / list.length) * 1000) / 10 : null });
const alliesLabel = (n) => (n >= 2 ? '2 or more' : String(n));
out.deaths = {
  traded_by_allies_within_2200_at_death: [0, 1, 2].map((n) => ({ allies: alliesLabel(n), ...traded(deaths.filter((d) => (n >= 2 ? d.allies >= 2 : d.allies === n))) })),
  died_within_20s_by_allies_near: [true, false].flatMap((half) => [0, 1, 2].map((n) => ({ side: half ? 'enemy half' : 'own half or river', allies: alliesLabel(n), ...risk(moments.filter((m) => m.enemyHalf === half && (n >= 2 ? m.allies >= 2 : m.allies === n))) }))),
};
// Only deaths and moments from traces with a ward list: an older trace has no wards, not zero wards.
const wd = deaths.filter((d) => d.obs); const wm = moments.filter((m) => m.obs);
out.wards = {
  games_with_wards: wardGames,
  deaths_traded: [
    { case: 'no observer of either side within 1600', ...traded(wd.filter((d) => !d.obs.my_team && !d.obs.enemy)) },
    { case: 'own observer within 1600', ...traded(wd.filter((d) => d.obs.my_team > 0)) },
    { case: 'no own observer within 1600', ...traded(wd.filter((d) => d.obs.my_team === 0)) },
    { case: 'enemy observer within 1600', ...traded(wd.filter((d) => d.obs.enemy > 0)) },
    { case: 'enemy observer near, no own one, no ally within 2200', ...traded(wd.filter((d) => d.obs.enemy > 0 && !d.obs.my_team && d.allies === 0)) },
  ],
  died_within_20s: [true, false].flatMap((half) => [
    { side: half ? 'enemy half' : 'own half or river', case: 'enemy observer within 1600', ...risk(wm.filter((m) => m.enemyHalf === half && m.obs.enemy > 0)) },
    { side: half ? 'enemy half' : 'own half or river', case: 'no enemy observer within 1600', ...risk(wm.filter((m) => m.enemyHalf === half && m.obs.enemy === 0)) },
    { side: half ? 'enemy half' : 'own half or river', case: 'alone, enemy observer within 1600', ...risk(wm.filter((m) => m.enemyHalf === half && m.allies === 0 && m.obs.enemy > 0)) },
    { side: half ? 'enemy half' : 'own half or river', case: 'alone, no enemy observer within 1600', ...risk(wm.filter((m) => m.enemyHalf === half && m.allies === 0 && m.obs.enemy === 0)) },
  ]),
};
const DID = ['took_a_building', 'took_roshan', 'pushed_and_took_nothing', 'neither'];
const TDID = ['took_another_building', 'took_roshan', 'pushed_and_took_nothing', 'neither'];
out.after_towers_fell = [1, 2, 3].flatMap((tier) => [true, false].map((fight) => {
  const list = afterTowers.filter((x) => x.tier === tier && x.fight === fight);
  return { tier, after_a_won_fight: fight, towers: list.length, ...Object.fromEntries(TDID.map((d) => [d, list.filter((x) => x.did === d).length])), takers_lost_a_building_meanwhile: list.filter((x) => x.traded).length };
}));
const rate = (l, k) => ({ fights: l.length, [k]: l.filter((x) => x.won ?? x.aheadWon).length });
out.fights_after_big_items = {
  one_side_only: rate(itemFights, 'item_side_lost_fewer'),
  item_side_ahead_in_gold: rate(itemFights.filter((x) => x.ahead === true), 'item_side_lost_fewer'),
  item_side_behind_in_gold: rate(itemFights.filter((x) => x.ahead === false), 'item_side_lost_fewer'),
  no_fresh_big_item: rate(plainFights, 'side_ahead_in_gold_lost_fewer'),
};
out.ultimate_edges = {
  moments: ultEdges.length,
  fight_within_90s: ultEdges.filter((x) => x.result).length,
  edge_side_lost_fewer: ultEdges.filter((x) => x.result === 'fewer').length,
  edge_side_lost_more: ultEdges.filter((x) => x.result === 'more').length,
  even: ultEdges.filter((x) => x.result === 'even').length,
};
// Wins with three or more losers still dead, by whether the losers' richest was one of them (games with net worth).
out.after_won_fights_three_or_more_still_dead_by_losers_richest = ['dead_30s_or_more', 'dead_under_30s', 'alive', 'not_known'].map((k) => {
  const list = afterWins.filter((x) => x.stillDead >= 3 && x.richest === k);
  return { losers_richest: k, fights: list.length, took_a_building: list.filter((x) => x.did === 'took_a_building').length, neither: list.filter((x) => x.did === 'neither').length };
});
out.after_won_fights = [0, 1, 2, 3, 4].map((n) => {
  const list = afterWins.filter((x) => (n === 4 ? x.stillDead >= 4 : x.stillDead === n));
  return { losers_still_dead_10s_after: n === 4 ? '4 or more' : String(n), fights: list.length, ...Object.fromEntries(DID.map((d) => [d, list.filter((x) => x.did === d).length])) };
});
const fightsAfter = roshans.flatMap((x) => x.fights);
if (gamesWithCreepKills) {
  const c = {}; for (const d of notInFight) c[d] = (c[d] ?? 0) + 1;
  out.not_in_a_fight = { games: gamesWithCreepKills, alive_heroes_not_in_a_fight: notInFight.length, doing: c };
}
if (saveGames) out.saves = { games: saveGames, ...saves };
if (wardsPlaced) {
  const s = wardTeams.slice().sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  out.wards_placed = { wards: wardsPlaced, placer_not_known: wardsPlacerUnknown, two_most_warding_heroes_of_a_team_observers: [q(0.25), q(0.5), q(0.75)] };
}
if (momentSides.length) {
  const q = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s.length ? [0.25, 0.5, 0.75].map((p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]) : null; };
  const lost = momentSides.filter((x) => x.lost); const won = momentSides.filter((x) => !x.lost);
  const named = lost.filter((x) => x.turn);
  const count = (pred) => momentHeroes.filter(pred).length;
  out.key_moments = {
    sides_read: momentSides.length,
    losing_sides: lost.length,
    losing_stretch_fall_quartiles: q(lost.map((x) => x.fall)),
    losing_stretch_minutes_quartiles: q(lost.map((x) => x.minutes)),
    losing_sides_with_a_stretch_of_20_or_more: lost.filter((x) => x.fall >= 20).length,
    losing_sides_lost_from_the_lanes: lost.filter((x) => x.lanes === true).length,
    lanes_lost_stretch_fall_quartiles: q(lost.filter((x) => x.lanes === true).map((x) => x.fall)),
    turning_fight_named: named.length,
    turning_fight_inside_the_stretch: named.filter((x) => x.turnInside).length,
    winning_stretch_fall_quartiles: q(won.map((x) => x.fall)),
    fights_not_read: momentSides.reduce((n, x) => n + x.notRead, 0),
    losing_heroes: momentHeroes.length,
    losing_heroes_in_it_for_80_percent_or_more: count((x) => x.in_it >= 0.8),
    losing_heroes_elsewhere_for_half_or_more: count((x) => x.elsewhere >= 0.5),
    losing_heroes_dead_for_half_or_more: count((x) => x.dead >= 0.5),
  };
}
if (gamesWithKillRows) {
  // What needs the hits is read over the kills whose hits were kept.
  const hit = roshanKills.filter((x) => x.seconds != null);
  const secs = hit.map((x) => x.seconds).sort((a, b) => a - b);
  const quart = (p) => (secs.length ? secs[Math.min(secs.length - 1, Math.floor(p * secs.length))] : null);
  out.roshan_kills = {
    games_with_kill_rows: gamesWithKillRows,
    kills: roshanKills.length,
    aegis_picked_up_by_the_killing_side_within_30s: roshanKills.filter((x) => x.picked_up).length,
    aegis_stolen_within_30s: roshanKills.filter((x) => x.stolen).length,
    no_pickup_seen_within_30s: roshanKills.filter((x) => !x.picked_up && !x.stolen).length,
    aegis_pickups_with_no_kill_row: pickupsWithNoKill,
    kills_with_the_hits_kept: hit.length,
    heroes_of_the_killing_side_hitting: hit.length ? Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, hit.filter((x) => x.hitters === n).length])) : null,
    kills_the_other_side_also_hit: hit.length ? hit.filter((x) => x.others > 0).length : null,
    attempt_seconds_quartiles: [quart(0.25), quart(0.5), quart(0.75)],
  };
}
out.roshans = {
  takes: roshans.length,
  aegis: { used: roshans.filter((x) => x.aegis === 'used').length, expired: roshans.filter((x) => x.aegis === 'expired').length, game_ended: roshans.filter((x) => x.aegis === 'game_ended').length },
  buildings_in_the_next_300s: { taking_side: roshans.reduce((n, x) => n + x.took, 0), other_side: roshans.reduce((n, x) => n + x.lost, 0) },
  takes_with_no_building_after: roshans.filter((x) => x.took === 0).length,
  fights_in_the_next_300s: { fights: fightsAfter.length, taking_side_lost_fewer: fightsAfter.filter((f) => f.aegis_side_deaths < f.other_side_deaths).length, other_side_lost_fewer: fightsAfter.filter((f) => f.aegis_side_deaths > f.other_side_deaths).length },
};
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`${out.games} games, ${out.fights_with_a_winner} fights where one side lost fewer heroes\n`);
  for (const m of out.measures) console.log(`${m.measure.padEnd(46)} ${String(m.side_ahead_won).padStart(4)}/${String(m.fights).padEnd(4)} ${m.rate}%`);
  const line = (label, x) => console.log(`${label.padEnd(46)} ${String(x.took_it).padStart(4)}/${String(x.pushes).padEnd(4)} ${x.rate}%`);
  console.log(`\n${out.pushes.total.pushes} pushes on buildings; share that took the building\n`);
  line('all pushes', out.pushes.total);
  line('two or more hitting than near', out.pushes.two_or_more_hitting_than_near);
  line('at most one more hitting than near', out.pushes.at_most_one_more_hitting_than_near);
  for (const x of out.pushes.by_heroes_hitting_minus_owners_near) line(`  hitting minus near: ${x.value}`, x);
  for (const x of out.pushes.by_owners_dead_when_it_began) line(`  owners dead when it began: ${x.value}`, x);
  console.log(`\n${deaths.length} deaths; share traded (an enemy hero died within 15 s)\n`);
  for (const x of out.deaths.traded_by_allies_within_2200_at_death) console.log(`${`  allies within 2200 at death: ${x.allies}`.padEnd(46)} ${String(x.traded).padStart(4)}/${String(x.deaths).padEnd(5)} ${x.rate}%`);
  console.log(`\n${afterWins.length} won fights; what the winners did (a building from the fight's start to 120 s after it, Roshan, a push for nothing, or neither)\n`);
  const fb = out.fights_after_big_items;
  console.log(`\nfights with a winner begun within 120 s after big items of one side only; share that side lost fewer\n`);
  console.log(`${'  all'.padEnd(46)} ${fb.one_side_only.item_side_lost_fewer}/${fb.one_side_only.fights}`);
  console.log(`${'  item side ahead in gold'.padEnd(46)} ${fb.item_side_ahead_in_gold.item_side_lost_fewer}/${fb.item_side_ahead_in_gold.fights}`);
  console.log(`${'  item side behind in gold'.padEnd(46)} ${fb.item_side_behind_in_gold.item_side_lost_fewer}/${fb.item_side_behind_in_gold.fights}`);
  console.log(`${'  no fresh big item: side ahead in gold'.padEnd(46)} ${fb.no_fresh_big_item.side_ahead_in_gold_lost_fewer}/${fb.no_fresh_big_item.fights}`);
  const ue = out.ultimate_edges;
  console.log(`\n${ue.moments} moments a side came to have 2+ more ultimates ready; a fight within 90 s in ${ue.fight_within_90s}: that side lost fewer ${ue.edge_side_lost_fewer}, more ${ue.edge_side_lost_more}, even ${ue.even}`);
  console.log(`\nwon fights with 3+ losers still dead 10 s after, by the losers' richest (games with net worth)\n`);
  for (const x of out.after_won_fights_three_or_more_still_dead_by_losers_richest) console.log(`${`  richest ${x.losers_richest}`.padEnd(46)} n=${String(x.fights).padEnd(4)} building ${x.took_a_building}  neither ${x.neither}`);
  console.log(`\n${afterTowers.length} tier 1–3 towers taken; what the takers did in the next 120 s, and how often they lost one meanwhile\n`);
  for (const x of out.after_towers_fell) console.log(`${`  tier ${x.tier}, ${x.after_a_won_fight ? 'after a won fight' : 'no won fight'}`.padEnd(46)} n=${String(x.towers).padEnd(4)} another ${x.took_another_building}  Roshan ${x.took_roshan}  push for nothing ${x.pushed_and_took_nothing}  neither ${x.neither}  lost one ${x.takers_lost_a_building_meanwhile}`);
  for (const x of out.after_won_fights) console.log(`${`  losers still dead 10 s after: ${x.losers_still_dead_10s_after}`.padEnd(46)} n=${String(x.fights).padEnd(4)} building ${x.took_a_building}  Roshan ${x.took_roshan}  push for nothing ${x.pushed_and_took_nothing}  neither ${x.neither}`);
  const ro = out.roshans;
  if (out.roshan_kills) { const k = out.roshan_kills; console.log(`\n${k.kills} Roshan kills in ${k.games_with_kill_rows} games with kill rows: Aegis picked up by the killing side within 30 s ${k.aegis_picked_up_by_the_killing_side_within_30s}, stolen by the other side ${k.aegis_stolen_within_30s}, no pickup seen ${k.no_pickup_seen_within_30s}; pickups with no kill row ${k.aegis_pickups_with_no_kill_row}; kills with their hits kept ${k.kills_with_the_hits_kept}; heroes hitting 1/2/3/4/5: ${k.heroes_of_the_killing_side_hitting ? [1, 2, 3, 4, 5].map((n) => k.heroes_of_the_killing_side_hitting[n]).join(' / ') : 'not known'}; the other side also hit ${k.kills_the_other_side_also_hit ?? 'not known'}; attempt seconds (quartiles) ${k.attempt_seconds_quartiles.map((v) => v ?? '–').join(' / ')}`); }
  console.log(`\n${ro.takes} Roshans (Aegis pickups): used ${ro.aegis.used}, expired ${ro.aegis.expired}, game ended ${ro.aegis.game_ended}`);
  console.log(`  in the 300 s after: the taking side took ${ro.buildings_in_the_next_300s.taking_side} buildings, the other side ${ro.buildings_in_the_next_300s.other_side}; takes with no building after: ${ro.takes_with_no_building_after}`);
  console.log(`  fights in those 300 s: ${ro.fights_in_the_next_300s.fights}, the taking side lost fewer in ${ro.fights_in_the_next_300s.taking_side_lost_fewer}, the other side in ${ro.fights_in_the_next_300s.other_side_lost_fewer}`);
  const w = out.wards;
  console.log(`\n${w.games_with_wards} games with a ward list (placements, not sight): share of deaths traded\n`);
  for (const x of w.deaths_traded) console.log(`${`  ${x.case}`.padEnd(56)} ${String(x.traded).padStart(4)}/${String(x.deaths).padEnd(5)} ${x.rate}%`);
  console.log(`\n  living heroes every 5 s from 10:00 in those games; share dead within 20 s\n`);
  for (const x of w.died_within_20s) console.log(`${`  ${x.side}, ${x.case}`.padEnd(56)} ${String(x.died_within_20s).padStart(5)}/${String(x.moments).padEnd(6)} ${x.rate}%`);
  console.log(`\nliving heroes every 5 s from 10:00; share dead within 20 s\n`);
  for (const x of out.deaths.died_within_20s_by_allies_near) console.log(`${`  ${x.side}, allies near: ${x.allies}`.padEnd(46)} ${String(x.died_within_20s).padStart(5)}/${String(x.moments).padEnd(6)} ${x.rate}%`);
}
