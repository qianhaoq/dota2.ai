/**
 * decision_points: the moments a side had a choice, what it chose, and how that went — from the player's side.
 *
 * The first kind is the one that decides most games: a fight won. The side that lost fewer heroes has the map for as
 * long as the others are dead. What did it do with that time? Pushed a building (and took it or not), took Roshan,
 * or neither. The replay shows which; whether it was right is the reader's judgment, and the corpus says how such
 * moments usually go.
 *
 * Over 321 fights with a winner in 32 parsed games (scripts/calibrate.mjs): with four or more of the losers still
 * dead 10 s after the fight, the winners took a building in 58 of 96, took Roshan in 2, pushed and took nothing in
 * 12, and did neither in 24; with three still dead, 59 of 115 took a building and 42 did neither.
 *
 * The second kind: a tier 1–3 tower fell. The side that took it has a choice: go on to the next building, turn to
 * Roshan, or leave. The side that lost it has one too: trade a building elsewhere or give the lane up. Over 379 tower
 * kills in 32 games: after a tier 1 with no won fight around it, the takers got nothing else in the next 120 s 68 times
 * in 108 and lost a building of their own 34 times (a tower trade); after a tier 3, the next building fell 82 times in 90.
 *
 * The third kind: a fight that began within 120 s after a hero finished a big item (the coach's rule, as power_spikes
 * and window_report call items big, on this game's release prices). Whether to take a fight into a fresh item is a
 * choice; the corpus says how such fights go. Over 32 games, of the fights with a winner that came within 120 s after
 * big items of one side only (begun at the first damage exchange), that side lost fewer heroes in 62 of 103; ahead
 * in gold it did so in 24 of 34, behind in 11 of 25 — about as often as a side behind in gold does in any fight: the fresh item mostly marks the richer side.
 *
 * Facts only. "Took a building" counts as tempo_report's "followed by a building" does (one of the losers' fell
 * from the fight's start to 120 s after its end), so the two never disagree. "Neither" means no building, no Aegis
 * pickup and no push of three hero-seconds by that side: the trace has no creeps, so farming or a wave pushed by
 * creeps alone is not seen.
 */
import { dist, heroOfName, region, stateAt } from '../../packages/review-engine/src/trace/query.js';
import { fightParticipation, goldAdvantage, itemTimeline, matchFights, sieges, traceClock, traceHeroIndex } from '../../packages/review-engine/src/trace/index.js';
import { ALWAYS_KEY_ITEMS, KEY_ITEM_MIN_COST } from '../coach/knowledge.js';
import { isBigItemIn, patchForGame } from './patchData.js';
import { aegisTakes } from './roshanReport.js';
import { gapsOf } from './fightReport.js';
import { moneyOf } from './farmReport.js';

/** What a won fight is followed by, over this many seconds from its last death: tempo_report's FOLLOW_UP_SECONDS, so the two agree. */
export const AFTER_SECONDS = 120;
/** The losers counted as still dead this long after the fight's last death (a death at the very end is not a window). */
export const STILL_DEAD_AFTER = 10;
const fail = (error, extra = {}) => ({ error, ...extra });
const unitName = (name) => name.replace(/^npc_dota_/, '');
const OBJECTIVE = /_(tower\d|melee_rax|range_rax|fort)(_(top|mid|bot))?$/;
const teamOfBuilding = (name) => (/goodguys/.test(name) ? 2 : /badguys/.test(name) ? 3 : null);
const TOWER = /_tower([123])_(top|mid|bot)$/;
/** A tower's hitters are those who hit it this long before it fell: siege_report's gap between two hits of one push. */
const LAST_HITS_SECONDS = 30;
/** Near a tower when it fell: within this of one who hit it then (siege_report's SIEGE_NEAR). */
const NEAR_TOWER = 1800;

/** Seconds until hero h is alive again after t, or null. */
function respawnIn(trace, h, t) {
  const alive = trace.states[h].alive;
  for (let i = Math.max(0, Math.round(t) - trace.t0); i < trace.n; i += 1) if (alive[i] === 1) return i + trace.t0 - Math.round(t);
  return null;
}

/** Every fight one side lost fewer heroes in, and what the winners did in the AFTER_SECONDS after it. */
export function afterWonFights(trace) {
  const pushes = sieges(trace); const aegis = aegisTakes(trace);
  const out = [];
  matchFights(trace).forEach((f, fi) => {
    const lost = { 2: 0, 3: 0 };
    for (const d of f.deaths) { const v = heroOfName(trace, d[1]); if (v >= 0) lost[trace.heroes[v].team] += 1; }
    if (lost[2] === lost[3]) return;
    const winner = lost[2] < lost[3] ? 2 : 3; const loser = winner === 2 ? 3 : 2;
    const end = f.to; const until = end + AFTER_SECONDS;
    const at = end + STILL_DEAD_AFTER;
    // A loser with no sample at that second is unknown: not counted dead, and the count says how many were unknown.
    const losers = trace.heroes.map((h, i) => i).filter((i) => trace.heroes[i].team === loser);
    const still = losers.filter((i) => stateAt(trace, i, at)?.alive === false);
    const unknown = losers.filter((i) => !stateAt(trace, i, at)).length;
    // Pushes by the winners on the losers' buildings that overlap the fight and the 120 s after it, also one begun
    // during the fight and still going after it (review of #306).
    const theirs = pushes.filter((p) => p.owner === loser && p.to >= f.from && p.from <= until);
    const roshan = aegis.find((a) => trace.heroes[a.holder].team === winner && a.from >= end && a.from <= until);
    // Buildings of the losers that fell from the fight's start to 120 s after its end, whoever landed the last hit (creeps
    // can finish a tower heroes opened): as tempo_report counts a fight "followed by a building", from its start.
    // A building its own side destroyed (a deny) is nobody's objective, as tempo_report counts it (review of #306).
    const fell = (owner) => (trace.buildings ?? []).filter((b) => b[0] >= f.from && b[0] <= until && OBJECTIVE.test(trace.names[b[1]] ?? '') && teamOfBuilding(trace.names[b[1]]) === owner && b[2] !== owner);
    const took = fell(loser);
    // Who of the winners hit one of the losers' buildings in the window: every damage row, not only the pushes, since
    // sieges() drops a run under three hero-seconds and a single hit is still the player hitting (review of #306).
    const hitters = new Set();
    for (const [sec, a, target] of trace.damage ?? []) {
      if (sec < f.from || sec > until) continue;
      const name = trace.names[target];
      if (!name || !OBJECTIVE.test(name) || teamOfBuilding(name) !== loser) continue;
      const ah = heroOfName(trace, a); if (ah >= 0 && trace.heroes[ah].team === winner) hitters.add(ah);
    }
    const lostBack = fell(winner).filter((b) => b[0] >= end);
    out.push({
      fight: fi + 1, from: f.from, to: end, winner, loser, lost,
      still_dead: still.map((i) => ({ i, respawn_in: respawnIn(trace, i, at) })), unknown,
      pushes: theirs, took, roshan, lostBack, hitters,
      did: took.length ? 'took_a_building' : roshan ? 'took_roshan' : theirs.length ? 'pushed_and_took_nothing' : 'neither',
    });
  });
  return out;
}

/**
 * Every tier 1–3 tower that fell to the other side (a deny is nobody's objective), and what followed in the
 * AFTER_SECONDS after it: another building of the same side, an Aegis for the takers, a push that took nothing, or
 * neither; and the takers' own buildings that fell meanwhile (a trade).
 */
export function afterTowersFell(trace) {
  const pushes = sieges(trace); const aegis = aegisTakes(trace); const wins = afterWonFights(trace);
  const buildings = trace.buildings ?? [];
  const out = [];
  for (const b of buildings) {
    const name = trace.names[b[1]] ?? ''; const m = TOWER.exec(name);
    const owner = m && teamOfBuilding(name);
    if (!owner || b[2] === owner) continue;
    const taker = owner === 2 ? 3 : 2; const t = b[0]; const until = t + AFTER_SECONDS;
    const fell = (side) => buildings.filter((x) => x[0] > t && x[0] <= until && OBJECTIVE.test(trace.names[x[1]] ?? '') && teamOfBuilding(trace.names[x[1]]) === side && x[2] !== side);
    const took = fell(owner);
    // Who of the takers hit it in its last 30 s, and where each stood then: what "near it" is measured from.
    const hitters = new Set();
    for (const [sec, a, target] of trace.damage ?? []) {
      if (target !== b[1] || sec < t - LAST_HITS_SECONDS || sec > t) continue;
      const ah = heroOfName(trace, a); if (ah >= 0 && trace.heroes[ah].team === taker) hitters.add(ah);
    }
    const spots = [...hitters].map((i) => stateAt(trace, i, t)).filter((x) => x?.alive);
    out.push({
      at: t, building: b[1], name, tier: Number(m[1]), owner, taker, hitters, spots, took,
      lostBack: fell(taker),
      roshan: aegis.find((a) => trace.heroes[a.holder].team === taker && a.from > t && a.from <= until),
      // Pushes by the takers on the owners' other buildings that overlap the 120 s after.
      pushes: pushes.filter((p) => p.owner === owner && p.building !== b[1] && p.to > t && p.from <= until),
      // The fight the takers won that this tower fell in or within 120 s of: then it is that fight's follow-up too.
      fight: wins.find((w) => w.winner === taker && t >= w.from && t <= w.to + AFTER_SECONDS)?.fight ?? null,
    });
  }
  for (const x of out) x.did = x.took.length ? 'took_another_building' : x.roshan ? 'took_roshan' : x.pushes.length ? 'pushed_and_took_nothing' : 'neither';
  return out.sort((x, y) => x.at - y.at);
}

/** A loser this long or more from respawning, 10 s after the fight, is out of the next push. */
export const LONG_RESPAWN = 30;

/**
 * The richest hero of `team` at the start of minute `m` by `money` (farm_report's money: the match data's gold
 * earned, else the replay's net worth), or null when unknown for any of them. Ties: null — no one is "the richest".
 */
export function richestOf(trace, money, team, m) {
  if (!money || m > money.last) return null;
  const of = trace.heroes.map((h, i) => ({ i, v: h.team === team ? money.series.get(h.key)?.[m] : undefined })).filter((x) => trace.heroes[x.i].team === team);
  if (of.some((x) => !Number.isFinite(x.v))) return null;
  of.sort((a, b) => b.v - a.v);
  return of.length > 1 && of[0].v === of[1].v ? null : of[0].i;
}

/** A fight is "after a big item" when it began within this many seconds after the item was first held. */
export const ITEM_SECONDS = 120;

/**
 * Every fight that began within ITEM_SECONDS after a hero finished a big item, with every such item of either side,
 * how many heroes each side lost, and the Radiant gold lead the minute it began (null when not known).
 */
export function fightsAfterBigItems(trace, ctx = {}) {
  const pd = patchForGame(trace.match_id, ctx.match);
  const items = trace.heroes.flatMap((h, i) => (itemTimeline(trace, { hero: h.key }).items ?? [])
    .filter((x) => x.first_held.t > trace.t0 && isBigItemIn(pd, x.item, { minCost: KEY_ITEM_MIN_COST, always: ALWAYS_KEY_ITEMS }))
    .map((x) => ({ ref: x.ref, t: x.first_held.t, hero: i, team: h.team, item: x.item })));
  const adv = goldAdvantage(trace, { match: ctx.match });
  const out = [];
  matchFights(trace).forEach((f, fi) => {
    // The fight begins at its first damage exchange (fight_report's engaged_at), not its first death: an item first
    // held during the opening exchange was not one the fight was taken into (review of #310).
    const start = fightParticipation(trace, f).engaged_at;
    const recent = items.filter((x) => x.t < start && x.t >= start - ITEM_SECONDS).sort((a, b) => a.t - b.t);
    if (!recent.length) return;
    const lost = { 2: 0, 3: 0 };
    for (const d of f.deaths) { const v = heroOfName(trace, d[1]); if (v >= 0) lost[trace.heroes[v].team] += 1; }
    const lead = adv?.[Math.floor(start / 60)];
    out.push({ fight: fi + 1, from: start, items: recent, lost, radiantLead: Number.isFinite(lead) ? lead : null });
  });
  return { exact: pd.exact, release: pd.name, fights: out };
}

/** Where hero h was when a tower fell: hit it, near it, dead, elsewhere; or unknown (not sampled). */
function whereAtTower(trace, h, x) {
  if (x.hitters.has(h)) return { me: 'hit_it' };
  const s = stateAt(trace, h, x.at);
  if (!s) return { me: 'unknown' };
  if (!s.alive) return { me: 'dead' };
  // Nobody of the takers seen hitting it (creeps finished it): where the tower stands is not known, so neither is near.
  if (!x.spots.length) return { me: 'alive_tower_spot_unknown', my_place: region(s.x, s.y) };
  const d = Math.min(...x.spots.map((p) => dist(p, s)));
  return { me: d <= NEAR_TOWER ? 'near' : 'elsewhere', my_place: region(s.x, s.y), distance_from_its_hitters: d };
}

export function decisionPoints(trace, args = {}, ctx = {}) {
  const h = traceHeroIndex(trace, args.hero);
  if (h < 0) return fail('unknown_hero', { heroes: trace.heroes.map((x) => x.key) });
  const key = trace.heroes[h].key; const team = trace.heroes[h].team;
  // The losers' richest hero at the fight's start, and whether they were still dead 10 s after it.
  const money = moneyOf(trace, ctx.match, Math.floor((trace.t0 + trace.n - 1) / 60));
  const points = afterWonFights(trace).map((x, i) => {
    const mine = x.winner === team;
    const rich = richestOf(trace, money, x.loser, Math.floor(x.from / 60));
    const richDead = rich == null ? null : x.still_dead.find((d) => d.i === rich) ?? null;
    return {
      ref: `decision:${key}:${i + 1}`,
      kind: 'after_a_won_fight',
      fight: `fight:${x.fight}`,
      clock: traceClock(x.to),
      won_by: mine ? 'my_team' : 'enemy',
      deaths: { my_team: x.lost[team], enemy: x.lost[team === 2 ? 3 : 2] },
      // The losers still dead 10 s after the fight's last death, and how long each had left: the window the winners had.
      losers_still_dead_10s_after: x.still_dead.length,
      ...(x.unknown ? { losers_not_sampled: x.unknown } : {}),
      losers_respawn_in: x.still_dead.map((d) => ({ hero: trace.heroes[d.i].key, seconds: d.respawn_in })),
      // What the winners did: a building of the losers fell from the fight's start to 120 s after its end; else an Aegis
      // pickup; else a push that took nothing; else neither.
      winners_did: x.did,
      buildings_winners_took: x.took.map((b) => ({ building: unitName(trace.names[b[1]]), clock: traceClock(b[0]), during_the_fight: b[0] <= x.to })),
      pushes: x.pushes.map((p) => ({ building: unitName(p.name), clock: traceClock(p.from), took_it: x.took.some((b) => b[1] === p.building), hitting: [...new Set(p.hits.filter(([sec]) => sec >= x.from && sec <= x.to + AFTER_SECONDS).map(([, j]) => j))].map((j) => trace.heroes[j].key) })),
      ...(x.roshan ? { roshan_at: traceClock(x.roshan.from) } : {}),
      // Buildings the losers took back from the winners in the same 120 s.
      losers_took_back: x.lostBack.map((b) => ({ building: unitName(trace.names[b[1]]), clock: traceClock(b[0]) })),
      // Who was the losers' richest when it began (farm_report's money) and whether they were still dead 10 s after it.
      // Not sampled at that second: unknown (null), not alive — absent from still_dead is not proof they were up (review of #312).
      ...(rich != null ? { losers_richest: { hero: trace.heroes[rich].key, still_dead_10s_after: richDead != null ? true : stateAt(trace, rich, x.to + STILL_DEAD_AFTER) ? false : null, ...(richDead ? { respawn_in: richDead.respawn_in } : {}) } } : {}),
      ...(mine ? { me: x.hitters.has(h) ? 'hit_a_building' : stateAt(trace, h, x.to + STILL_DEAD_AFTER)?.alive === false ? 'dead' : 'did_not_hit' } : {}),
    };
  });
  // Tower points follow the fight points, so a fight point keeps its number when a later kind is added.
  const towers = afterTowersFell(trace).map((x, i) => {
    const mine = x.taker === team;
    const keys = (list) => list.map((b) => ({ building: unitName(trace.names[b[1]]), clock: traceClock(b[0]) }));
    return {
      ref: `decision:${key}:${points.length + i + 1}`,
      kind: 'after_a_tower_fell',
      building: unitName(x.name), tier: x.tier,
      clock: traceClock(x.at),
      taken_by: mine ? 'my_team' : 'enemy',
      after_won_fight: x.fight ? `fight:${x.fight}` : null,
      hitting: [...x.hitters].map((j) => trace.heroes[j].key),
      // What the takers did in the next 120 s: another of the owners' buildings fell; else an Aegis pickup; else a push
      // that took nothing; else neither.
      takers_did: x.did,
      buildings_takers_took_next: keys(x.took),
      ...(x.roshan ? { roshan_at: traceClock(x.roshan.from) } : {}),
      pushes: x.pushes.map((p) => ({ building: unitName(p.name), clock: traceClock(p.from), took_it: x.took.some((b) => b[1] === p.building) })),
      // The takers' own buildings that fell in the same 120 s: a trade.
      owners_took_back: keys(x.lostBack),
      ...whereAtTower(trace, h, x),
    };
  });
  points.push(...towers);
  // Fights after big items follow the tower points, for the same reason.
  const bigs = fightsAfterBigItems(trace, ctx);
  const other = team === 2 ? 3 : 2;
  const items = bigs.fights.map((x, i) => {
    const sides = new Set(x.items.map((it) => it.team));
    return {
      ref: `decision:${key}:${points.length + i + 1}`,
      kind: 'fight_after_a_big_item',
      fight: `fight:${x.fight}`,
      clock: traceClock(x.from),
      // Every big item of either side first held in the 120 s before the fight began, each with item_timeline's ref.
      items: x.items.map((it) => ({ hero: trace.heroes[it.hero].key, side: it.team === team ? 'my_team' : 'enemy', item: it.item, clock: traceClock(it.t), ref: it.ref })),
      items_from: sides.size === 2 ? 'both' : sides.has(team) ? 'my_team' : 'enemy',
      deaths: { my_team: x.lost[team], enemy: x.lost[other] },
      lost_fewer: x.lost[team] < x.lost[other] ? 'my_team' : x.lost[team] > x.lost[other] ? 'enemy' : 'even',
      ...(x.radiantLead != null ? { my_team_gold_lead: team === 2 ? x.radiantLead : -x.radiantLead } : {}),
    };
  });
  points.push(...items);
  const after = (who) => { const l = items.filter((p) => p.items_from === who); return { fights: l.length, my_team_lost_fewer: l.filter((p) => p.lost_fewer === 'my_team').length, enemy_lost_fewer: l.filter((p) => p.lost_fewer === 'enemy').length, even: l.filter((p) => p.lost_fewer === 'even').length }; };
  const by = (who) => points.filter((p) => p.kind === 'after_a_won_fight' && p.won_by === who);
  const richWins = by('my_team').filter((p) => p.losers_richest?.still_dead_10s_after && p.losers_richest.respawn_in >= LONG_RESPAWN);
  const towersBy = (who) => towers.filter((p) => p.taken_by === who);
  const towerCounts = (list) => ({ towers: list.length, took_another_building: list.filter((p) => p.takers_did === 'took_another_building').length, took_roshan: list.filter((p) => p.takers_did === 'took_roshan').length, pushed_and_took_nothing: list.filter((p) => p.takers_did === 'pushed_and_took_nothing').length, neither: list.filter((p) => p.takers_did === 'neither').length, lost_a_building_meanwhile: list.filter((p) => p.owners_took_back.length).length });
  const lost = towersBy('enemy');
  const count = (list, did) => list.filter((p) => p.winners_did === did).length;
  const window = (list) => list.filter((p) => p.losers_still_dead_10s_after >= 3);
  return {
    ref: `decision:${key}`, ref_scope: 'summary',
    hero: key,
    fights_my_team_won: by('my_team').length,
    fights_enemy_won: by('enemy').length,
    // After the fights the player's team won, what it did in the next 120 s.
    my_team_after_its_wins: { took_a_building: count(by('my_team'), 'took_a_building'), took_roshan: count(by('my_team'), 'took_roshan'), pushed_and_took_nothing: count(by('my_team'), 'pushed_and_took_nothing'), neither: count(by('my_team'), 'neither') },
    // The same, only the wins with three or more enemies still dead 10 s after: the clearest windows.
    // The player's team's wins with the enemy's richest hero still dead 10 s after and 30 s or more from respawning.
    ...(money ? { money_source: money.source, my_team_wins_with_enemy_richest_long_dead: { fights: richWins.length, took_a_building: count(richWins, 'took_a_building'), neither: count(richWins, 'neither') } } : {}),
    my_team_wins_with_three_or_more_still_dead: { fights: window(by('my_team')).length, neither: count(window(by('my_team')), 'neither'), took_a_building: count(window(by('my_team')), 'took_a_building') },
    // After each tier 1–3 tower a side took, what it did in the next 120 s; and the buildings it lost meanwhile.
    towers_my_team_took: towerCounts(towersBy('my_team')),
    towers_enemy_took: towerCounts(lost),
    // Where the player was when each of their team's towers fell.
    when_my_team_lost_a_tower_i_was: { towers: lost.length, near_it: lost.filter((p) => p.me === 'near').length, was_dead: lost.filter((p) => p.me === 'dead').length, elsewhere: lost.filter((p) => p.me === 'elsewhere').length, not_known: lost.filter((p) => p.me === 'unknown' || p.me === 'alive_tower_spot_unknown').length },
    // Fights begun within 120 s after big items of only one side: how each went.
    fights_after_enemy_big_items: after('enemy'),
    fights_after_my_team_big_items: after('my_team'),
    ...(bigs.exact ? {} : { item_prices_of_release: bigs.release, item_prices_exact: false }),
    enemy_after_its_wins: { took_a_building: count(by('enemy'), 'took_a_building'), took_roshan: count(by('enemy'), 'took_roshan'), pushed_and_took_nothing: count(by('enemy'), 'pushed_and_took_nothing'), neither: count(by('enemy'), 'neither') },
    points,
    rule_towers: `after a tier 1–3 tower fell to the other side (not a deny): what its takers did in the next ${AFTER_SECONDS} s — another of the owners' buildings fell, else an Aegis pickup, else a push that took nothing, else neither — and the takers' own buildings that fell meanwhile; "near" = within ${NEAR_TOWER} of one who hit it in its last ${LAST_HITS_SECONDS} s`,
    rule_items: `a fight that began within ${ITEM_SECONDS} s after a hero first held a big item (built from a recipe and ${KEY_ITEM_MIN_COST}+ gold on this game's prices, or a key item such as Blink or BKB): every such item of either side, and who lost fewer heroes`,
    rule: `after a fight one side lost fewer heroes in: the losers still dead ${STILL_DEAD_AFTER} s after its last death, and what the winners did — took a building (one of the losers' fell from the fight's start to ${AFTER_SECONDS} s after its end, whoever landed the last hit), else took Roshan (an Aegis pickup), else pushed (three hero-seconds or more on a building) and took nothing, else neither`,
    gaps: [...gapsOf(trace), { topic: 'creeps', reason: 'neither = no push by heroes and no Aegis: a wave pushed by creeps, farming or smoking for the next fight are not seen' }],
  };
}

export const DECISION_TOOL = {
  name: 'decision_points',
  description: "The moments a side had a choice, from the player's side. Now: every fight one side lost fewer heroes in — who won it, how many of the losers were still dead 10 s after and for how long, and what the winners did in the next 120 s: pushed a building and took it, pushed and took nothing, took Roshan, or neither; the buildings the losers took back meanwhile; and for the player's team's wins, whether the player hit a building. Totals: what each side did after its wins, and the player's team's wins with three or more enemies still dead. Then every tier 1–3 tower that fell (kind after_a_tower_fell): who took it, whether it was a won fight's follow-up, what the takers did in the next 120 s (another building, Roshan, a push for nothing, or neither), the takers' own buildings that fell meanwhile (a trade), and where the player was — hit it, near it, dead or elsewhere and in which region. Totals per side, and where the player was when their team's towers fell. Then every fight begun within 120 s after a big item (kind fight_after_a_big_item): whose items, which, and who lost fewer heroes; totals for fights after only the enemy's or only the player's team's items. Use it for \"we won fights but lost the game\", for what a won fight or a taken tower should have become, and for towers lost while the player was elsewhere, and for fights taken into an enemy's fresh item.",
  input_schema: { type: 'object', properties: { hero: { type: 'string', description: 'Hero key as in match_overview, e.g. "beastmaster". The report is told from this hero\'s side: use the player.' } }, required: ['hero'], additionalProperties: false },
  run: decisionPoints,
};
