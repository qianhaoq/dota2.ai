/**
 * Query tools over a match trace — the questions a reviewer asks of a replay.
 * Pure and deterministic: (trace, args) → JSON. One registry (TRACE_TOOLS)
 * feeds the agent's function schema, the MCP server and the CLI.
 *
 * Every answer is a list of facts with their game time and, where one event
 * backs it, the row of trace/events.jsonl it came from. A record that
 * describes one moment (a death, a cast, a fight, an immunity window, an
 * item) carries a `ref`: a stable handle a review cites as its evidence, so
 * a reader — or a checker — can see exactly which record a sentence is about.
 * A tool's own counts and totals (deaths_total, by_target, …) belong to the
 * result's top-level `ref` with `ref_scope: 'summary'`: citing it covers those
 * numbers only, not everything nested below. Tools report; they do
 * not judge. What the trace cannot show is returned under `gaps`, never
 * guessed: an absent value is unknown, not false.
 */
import { heroByKey } from '../staticHeroes.js';
import { heroStateAt, observersNear, boughtBackAfter, classifyDeath, realDeaths, resurrections, reincarnationAtDeath } from './state.js';
import {
  abilityLevel, clock, cooldownLeft, dist, heldAt, heroIndex, heroOfName, immunityIntervals, manaCost, mostMana, nameId, nameOf, nearby, region, seconds, stateAt, unit,
} from './query.js';
import { TURN_RULE, turnOf } from './turningFight.js';
import { LANES_END, LANES_RULE, lostFromTheLanes } from './lanesLost.js';

const TEAM = { 2: 'radiant', 3: 'dire' };
/** Hero deaths closer together than this belong to one fight. */
const FIGHT_GAP = 15;
const FIGHT_MIN_DEATHS = 3;
/** Item uses that say nothing about a fight. */
const NOISE_ITEMS = /^item_(tango|clarity|flask|faerie_fire|branches|ward_|enchanted_mango|famango|great_famango|bottle|quelling_blade|madstone|tpscroll$)/;
const MAX_TIMELINE_ROWS = 150;
const MAX_FIGHT_WINDOW = 180;

const fail = (error, extra = {}) => ({ error, ...extra });
const gapsFor = (trace, topics) => (trace.gaps ?? []).filter((g) => topics.includes(g.topic));
const heroKeys = (trace) => trace.heroes.map((h) => h.key);
const where = (s) => (s ? { x: s.x, y: s.y, region: region(s.x, s.y) } : null);

/**
 * Whose side the answer is told from: `ctx.perspective` is a hero of the
 * match. With it, heroes carry `side` (me / ally / enemy) and fights, gold
 * and buildings are stated as my team's and the enemy's, so a reader never
 * has to translate Radiant/Dire or the sign of a gold difference.
 */
function viewer(trace, ctx) {
  const h = ctx?.perspective == null ? -1 : heroIndex(trace, ctx.perspective);
  return h < 0 ? null : { h, team: trace.heroes[h].team, key: trace.heroes[h].key };
}
const sideOf = (v, trace, h) => (!v || h < 0 ? {} : { side: h === v.h ? 'me' : trace.heroes[h].team === v.team ? 'ally' : 'enemy' });
/** Team that owns a building, from its engine name (goodguys = Radiant). */
const buildingTeam = (name) => (/goodguys/.test(name) ? 2 : /badguys/.test(name) ? 3 : 0);

/** The last second of the game: when the Ancient fell, else the last sample. An extract can run on into the post-game. */
function gameEnd(trace) {
  const fort = trace.buildings.find((b) => /_fort$/.test(trace.names[b[1]]));
  return fort ? fort[0] : trace.t0 + trace.n - 1;
}

function needHero(trace, hero) {
  const h = heroIndex(trace, hero);
  return h < 0 ? { err: fail('unknown_hero', { heroes: heroKeys(trace) }) } : { h, npc: nameId(trace, trace.heroes[h].npc) };
}

/**
 * Abilities this hero can cast: cast at least once, or costing mana (so an
 * active ability the player never pressed still counts as "ready, not
 * used"). Passive abilities that cost mana and trigger automatically on death
 * (`skeleton_king_reincarnation`) are excluded: they have no button to press.
 * A cooldown alone proves nothing: passives have them too (Counter Helix). A
 * never-cast ability that costs nothing cannot be told from a passive in the
 * replay: a stated gap, not a guess.
 */
const DEATH_TRIGGERED_ABILITIES = new Set(['skeleton_king_reincarnation']);
function castable(trace, h, npc) {
  const set = new Set();
  for (const c of trace.casts) if (c[1] === npc) set.add(trace.names[c[2]]);
  for (const [k, e] of Object.entries(trace.abilities[h])) if (e.mana > 0 && !DEATH_TRIGGERED_ABILITIES.has(k)) set.add(k);
  return set;
}

/** Hero deaths grouped into fights: [{ from, to, deaths: [[t, victimName, killerName, row]] }]. */
/** The fights match_overview numbers ("fight:N" is the Nth): three or more hero deaths, each within FIGHT_GAP seconds of the last. */
export function matchFights(trace) {
  return fights(trace);
}

function fights(trace) {
  const out = [];
  for (const d of [...realDeaths(trace)].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && d[0] - last.to <= FIGHT_GAP) { last.to = d[0]; last.deaths.push(d); } else out.push({ from: d[0], to: d[0], deaths: [d] });
  }
  return out.filter((f) => f.deaths.length >= FIGHT_MIN_DEATHS);
}

function deathRow(trace, d, t0 = null, view = null) {
  const v = heroOfName(trace, d[1]);
  return { t: d[0], clock: clock(d[0]), ...(t0 == null ? {} : { dt: Math.round((d[0] - t0) * 10) / 10 }), hero: nameOf(trace, d[1]), ...(view ? sideOf(view, trace, v) : { team: v >= 0 ? TEAM[trace.heroes[v].team] : null }), killer: nameOf(trace, d[2]), row: d[3] };
}

/** The combat log's gold reason for what selling an item gave back: money moved, not money earned. */
const GOLD_SOLD = 6;
/**
 * A net worth graph is read as one point a minute when it is short of the game's minutes by no more than this:
 * three points, or 15% of the game if that is more. The 23 corpus graphs that are per minute are 0 to 3 short
 * (34 for 35 minutes … 63 for 66); the one that is not has 36 points for 74.
 */
const GRAPH_SHORT_POINTS = 3;
const GRAPH_SHORT_SHARE = 0.15;

/**
 * Radiant's lead in gold earned, per game minute, summed from the combat log's gold rows (the trace's `gold`):
 * at minute m, what Radiant's heroes had gained before m:00 less what Dire's had — every gain but an item sold.
 *
 * The passive income is not in the log. It is the same for all ten heroes (checked per hero on 9100904020: each
 * is short of the match record by the same 277 / 1152 / 2025 / 2897 gold at 10 / 20 / 30 / 40 minutes), so it
 * cancels in a lead. Against the match record's radiant_gold_adv over the 17 corpus games that have both: 223
 * gold a minute apart on average over 774 minutes, 15 of the games within 140. What it lacks is income only
 * one side has and the log does not list: an abandoned ally's share (one game, 160 a minute after the
 * abandon) and gold-per-minute items and talents (one game, about 240 a minute late on).
 *
 * Null for a trace built before the gold rows were kept: it does not know.
 */
function earnedLead(trace) {
  if (!Array.isArray(trace?.gold) || !trace.gold.length || !Array.isArray(trace.heroes)) return null;
  const last = Math.floor(gameEnd(trace) / 60);
  if (!(last >= 0)) return null;
  // step[m]: what was gained in the minute before m:00 (gold before the horn counts into minute 0's).
  const step = new Array(last + 1).fill(0);
  for (const [minute, who, reason, sum] of trace.gold) {
    if (!(sum > 0) || reason === GOLD_SOLD) continue;
    const h = heroOfName(trace, who);
    const side = h < 0 ? 0 : trace.heroes[h].team === 2 ? 1 : trace.heroes[h].team === 3 ? -1 : 0;
    const m = Math.max(0, minute + 1);
    if (side && m <= last) step[m] += side * sum;
  }
  let lead = 0;
  return step.map((v) => (lead += v));
}

/**
 * The replay's net worth graph, per hero, when it can be read as one point a game minute: every hero has one,
 * and the shortest covers the game. Some replays' graphs are sparser (9099561801: 36 points for 73:37): read as
 * minutes they put minute 49's net worth at minute 24. The builder already leaves out a graph that is denser.
 * Null otherwise.
 */
export function netWorthGraph(trace) {
  const nw = Array.isArray(trace?.net_worth) ? trace.net_worth : null;
  if (!nw || !Array.isArray(trace.heroes) || nw.length !== trace.heroes.length || nw.some((g) => !Array.isArray(g) || !g.length)) return null;
  const minutes = Math.min(...nw.map((g) => g.length));
  const game = Math.floor(gameEnd(trace) / 60) + 1;
  if (game - minutes > Math.max(GRAPH_SHORT_POINTS, GRAPH_SHORT_SHARE * game)) return null;
  return nw;
}

/**
 * Radiant's lead per game minute and where it is from, best first:
 * - `match_record`: the match record's gold lead (OpenDota's radiant_gold_adv), when the caller has it;
 * - `replay_gold_log`: the same quantity — gold earned — summed from the replay's combat log (earnedLead);
 * - `replay_net_worth`: the replay's net worth graph summed by team. Another quantity (items and gold held, so
 *   a death or a buyback moves it), and which second of a minute a point was taken is not recorded: on the same
 *   17 games it is 2898 a minute away from the record on average.
 * Null when there is none of the three.
 * @returns {{ lead: number[], source: 'match_record' | 'replay_gold_log' | 'replay_net_worth' } | null}
 */
export function goldLead(trace, ctx = {}) {
  if (Array.isArray(ctx.match?.radiant_gold_adv) && ctx.match.radiant_gold_adv.length) return { lead: ctx.match.radiant_gold_adv, source: 'match_record' };
  const earned = earnedLead(trace);
  if (earned) return { lead: earned, source: 'replay_gold_log' };
  const nw = netWorthGraph(trace);
  if (!nw) return null;
  const minutes = Math.min(...nw.map((g) => g.length));
  return { lead: Array.from({ length: minutes }, (_, m) => trace.heroes.reduce((sum, h, i) => sum + (h.team === 2 ? 1 : h.team === 3 ? -1 : 0) * nw[i][m], 0)), source: 'replay_net_worth' };
}

/** Radiant's lead per game minute (goldLead), or null. */
export function goldAdvantage(trace, ctx = {}) {
  return goldLead(trace, ctx)?.lead ?? null;
}

/** What a tool says its gold lead was read from. */
export const GOLD_LEAD_SOURCE = { match_record: 'match_data_gold_lead', replay_gold_log: 'replay_gold_log_lead', replay_net_worth: 'replay_net_worth_lead' };

export function matchOverview(trace, _args = {}, ctx = {}) {
  // Real deaths only (in-place Reincarnation / Aegis revivals are not hero deaths on the scoreboard or in fights).
  // The log names the unit that landed the last hit (a summon, a creep), which is not the scoreboard's kill credit.
  const died = trace.heroes.map(() => 0); const diedEarly = trace.heroes.map(() => 0);
  for (const d of realDeaths(trace)) { const v = heroOfName(trace, d[1]); if (v >= 0) { died[v] += 1; if (d[0] < LANES_END) diedEarly[v] += 1; } }
  const view = viewer(trace, ctx);
  const gold = goldLead(trace, ctx);
  const adv = gold?.lead ?? null;
  const advAt = (t) => (adv && Number.isFinite(adv[Math.floor(t / 60)]) ? adv[Math.floor(t / 60)] : null);
  const mine = (radiantAdv) => (radiantAdv == null ? null : view.team === 2 ? radiantAdv : -radiantAdv);
  const end = trace.buildings.find((b) => /_fort$/.test(trace.names[b[1]]));
  // Who lost is whose Ancient fell — never who landed the last hit on it: that row often names no side (7 of
  // 32 parsed games), and read that way both teams were told they lost. 0: no Ancient fell in this trace.
  const loser = end ? buildingTeam(trace.names[end[1]]) : 0;
  const tally = { my_team_lost_fewer: 0, enemy_lost_fewer: 0, even: 0 };
  const allFights = fights(trace);
  const allRes = resurrections(trace);
  const fightRows = allFights.map((f, fi) => {
    const lost = { 2: 0, 3: 0 };
    for (const d of f.deaths) { const v = heroOfName(trace, d[1]); if (v >= 0) lost[trace.heroes[v].team] += 1; }
    const revivals = allRes.filter((r) => {
      if (r.t < f.from - FIGHT_GAP || r.t > f.to + FIGHT_GAP) return false;
      const distTo = (x) => (r.t < x.from ? x.from - r.t : r.t > x.to ? r.t - x.to : 0);
      const here = distTo(f);
      return allFights.every((o, oi) => oi === fi || distTo(o) > here || (distTo(o) === here && oi > fi));
    }).map((r) => ({ clock: clock(r.t), hero: nameOf(trace, r.victim), ...(view ? sideOf(view, trace, r.heroIndex) : { team: r.heroIndex >= 0 ? TEAM[trace.heroes[r.heroIndex].team] : null }), by: r.by }));
    const base = { ref: `fight:${fi + 1}`, from: f.from, to: f.to, clock: `${clock(f.from)}–${clock(f.to)}` };
    if (!view) {
      return {
        ...base, deaths: { radiant: lost[2], dire: lost[3] },
        fewer_deaths: lost[2] === lost[3] ? 'even' : lost[2] < lost[3] ? 'radiant' : 'dire',
        victims: f.deaths.map((d) => nameOf(trace, d[1])),
        ...(revivals.length ? { resurrections: revivals } : {}),
        ...(adv ? { radiant_gold_adv_before: advAt(f.from), radiant_gold_adv_2min_after: advAt(f.to + 120) } : {}),
      };
    }
    const my = lost[view.team]; const their = lost[view.team === 2 ? 3 : 2];
    const fewer = my === their ? 'even' : my < their ? 'my_team' : 'enemy';
    tally[fewer === 'even' ? 'even' : fewer === 'my_team' ? 'my_team_lost_fewer' : 'enemy_lost_fewer'] += 1;
    return {
      ...base, my_team_deaths: my, enemy_deaths: their, lost_fewer_heroes: fewer,
      victims: f.deaths.map((d) => ({ hero: nameOf(trace, d[1]), ...sideOf(view, trace, heroOfName(trace, d[1])) })),
      ...(revivals.length ? { resurrections: revivals } : {}),
      ...(adv ? { my_team_gold_lead_before: mine(advAt(f.from)), my_team_gold_lead_2min_after: mine(advAt(f.to + 120)) } : {}),
    };
  });
  // The fight the game turned on, against the viewer's team: said only with a gold lead to read it from.
  const turn = view && adv ? turnOf(fightRows, { end: end ? end[0] : null }) : null;
  // A lost fight that could be the turn has no gold lead around it, and the game did not end on a fight: not known.
  const turnNotKnown = Boolean(view && loser === view.team && turn && !turn.fight && turn.undecided.length);
  // Was a lost game lost from the lanes? From the viewer's side, and only off a lead that is gold earned.
  const lanes = view && loser === view.team ? lostFromTheLanes(adv ? adv.map((v) => mine(v)) : null, { source: gold?.source, end: end ? end[0] : null }) : null;
  return {
    ref: 'overview', ref_scope: 'summary',
    match_id: trace.match_id,
    duration: end ? { t: end[0], clock: clock(end[0]) } : null,
    ...(view ? { told_from: { hero: view.key, note: 'my_team is this hero\'s team; a negative gold lead means my_team was behind' }, result: loser ? (loser === view.team ? 'my_team_lost' : 'my_team_won') : null } : { winner: loser ? TEAM[loser === 2 ? 3 : 2] : null }),
    heroes: trace.heroes.map((h, i) => ({ hero: h.key, ...(view ? sideOf(view, trace, i) : { team: TEAM[h.team] }), deaths: died[i], deaths_before_10: diedEarly[i], final_level: stateAt(trace, i, trace.t0 + trace.n - 1)?.level ?? null })),
    ...(view ? { fights_total: fightRows.length, fights_tally: tally } : {}),
    // What the gold leads below were read from: gold earned (the match record's, or summed from the replay's combat
    // log), or the replay's net worth graph — items and gold held, which a death or a buyback moves.
    ...(gold ? { gold_lead_source: GOLD_LEAD_SOURCE[gold.source] } : {}),
    // The fight the game turned on, for a game my_team lost. null: not known — no gold lead at all, or none around a
    // lost fight that could be it (see gaps). { none: true }: every such fight has its gold, and none cost my_team
    // that much of its lead. Absent for a game my_team
    // won or one with no Ancient down: the fight a winner's lead fell most in is not where the game turned.
    ...(view && loser === view.team ? { turning_fight: !turn || turnNotKnown ? null : turn.fight ? { ref: turn.fight.ref, from: turn.fight.from, to: turn.fight.to, clock: turn.fight.clock, my_team_deaths: turn.fight.my_team_deaths, enemy_deaths: turn.fight.enemy_deaths, my_team_gold_lead_before: turn.fight.my_team_gold_lead_before, my_team_gold_lead_2min_after: turn.fight.my_team_gold_lead_2min_after, ...(turn.by === 'game_ended_after_it' ? { game_ended_within_two_minutes: true } : {}), rule: TURN_RULE } : { none: true } } : {}),
    // For a game my_team lost: was it lost from the lanes (lanesLost.js)? null: not known (see gaps) — never "no".
    ...(lanes ? { lanes: lanes.unknown ? null : { ...lanes, rule: LANES_RULE } } : {}),
    fights: fightRows,
    buildings: trace.buildings.map((b) => ({
      ref: `building:${unit(trace.names[b[1]])}`, t: b[0], clock: clock(b[0]), building: unit(trace.names[b[1]]),
      ...(view ? { lost_by: buildingTeam(trace.names[b[1]]) === view.team ? 'my_team' : 'enemy' } : { taken_by: TEAM[b[2]] ?? null }),
      row: b[3],
    })),
    gaps: [...gapsFor(trace, ['roshan', 'vision']), ...(adv ? [] : [{ topic: 'gold_advantage', reason: 'not_in_trace' }]), ...(turnNotKnown ? [{ topic: 'turning_fight', reason: 'no_gold_lead_around_a_lost_fight_that_could_be_it' }] : []), ...(lanes?.unknown && lanes.unknown !== 'no_gold_lead' ? [{ topic: 'lanes', reason: lanes.unknown }] : [])],
  };
}

export function deathContext(trace, args = {}, ctx = {}) {
  const view = viewer(trace, ctx);
  const { h, npc, err } = needHero(trace, args.hero);
  if (err) return err;
  // Whole seconds: the window is part of the records' refs, and a ref has to resolve to the same window.
  const window = Math.round(Math.min(30, Math.max(4, Number(args.window) || 12)));
  const real = realDeaths(trace);
  const all = real.filter((d) => d[1] === npc).sort((a, b) => a[0] - b[0]);
  const myRawDeaths = (trace.deaths ?? []).filter((d) => d[1] === npc);
  const hasReincarnation = trace.heroes[h].key === 'skeleton_king' || Boolean(trace.abilities?.[h]?.skeleton_king_reincarnation);
  if (args.index != null && !all[args.index - 1]) return fail('no_such_death', { deaths: all.length });
  // Every death is worked out, also when one is asked for: the order below is over all of them.
  const pick = all.map((d, i) => [d, i + 1]);
  const can = castable(trace, h, npc);
  // The fights of the game as match_overview groups them (three or more hero deaths, none more than 15 s after
  // the one before). That grouping is by time alone, over the whole map: a death counts as "in a fight" only if
  // it is one of them and an ally was within 2200 at some second before it — a hero picked off alone while a
  // fight went on elsewhere was not in it.
  const fought = new Set(fights(trace).flatMap((f) => f.deaths));
  // Where the hero respawns: each snapshot says how far from it the hero stood, so the window shows whether they
  // were heading home or away from it. Null when the trace never sampled a respawn.
  const fountain = ownFountain(trace, h, npc);
  const out = pick.map(([d, n]) => {
    const t = d[0]; const from = t - window;
    const snapshots = [...new Set([window, 8, 4, 1].filter((x) => x <= window))].map((back) => {
      const { me, allies, enemies } = nearby(trace, h, t - back, 2200);
      // What the replay shows the hero doing then (state.js): farming, trading damage with enemy heroes, hitting an
      // enemy building, in their own base — or none of these, when only the place is known.
      const doing = me ? heroStateAt(trace, h, t - back).doing ?? null : null;
      // A dead hero's position is the body or the fountain: no distance is measured from it.
      return { dt: -back, me: me ? { hp: me.hp, max_hp: me.max_hp, mana: me.mana, ...where(me), doing, to_own_fountain: fountain && me.alive ? dist(me, fountain) : null } : null, allies, enemies };
    });
    const atDeath = nearby(trace, h, t, 2200);
    // Every second of the window and the death itself, not only the snapshots: an ally who came and went between two of them was there.
    let mostAllies = atDeath.me && snapshots.every((x) => x.me) ? Math.max(atDeath.allies.length, ...snapshots.map((x) => x.allies.length)) : null;
    for (let sec = Math.floor(from); mostAllies != null && sec < t; sec += 1) { const at = nearby(trace, h, sec, 2200); mostAllies = at.me ? Math.max(mostAllies, at.allies.length) : null; }
    const abilities = Object.entries(trace.abilities[h]).filter(([k, e]) => can.has(k) && abilityLevel(e, from) > 0)
      .map(([k, e]) => ({ ability: k, level: abilityLevel(e, from), cooldown_left: cooldownLeft(e, from), mana_cost: manaCost(e, from, t) }));
    // Ready is not castable: with less mana all window long than it costs, it was never an option.
    const mana = mostMana(trace, h, from, t);
    const noMana = (a) => a.mana_cost != null && mana != null && mana < a.mana_cost;
    const items = Object.entries(trace.items[h]).filter(([, e]) => heldAt(e, from))
      .map(([k, e]) => ({ item: k.replace(/^item_/, ''), ...(e.cd.length ? { cooldown_left: cooldownLeft(e, from) } : {}) }));
    const dmg = new Map(); const sources = new Map(); let firstHero = null; const attackers = new Set();
    for (const [sec, a, target, infl, value] of trace.damage) {
      if (target !== npc || sec < Math.floor(from) || sec > t) continue;
      const key = `${a}|${infl}`;
      dmg.set(key, (dmg.get(key) ?? 0) + value);
      const src = `${nameOf(trace, a) ?? 'unknown'}: ${infl >= 0 ? 'abilities and items' : 'attacks'}`;
      sources.set(src, (sources.get(src) ?? 0) + value);
      const ah = heroOfName(trace, a);
      if (ah >= 0 && (firstHero == null || sec < firstHero)) firstHero = sec;
      if (ah >= 0 && trace.heroes[ah].team !== trace.heroes[h].team) attackers.add(ah);
    }
    const inWindow = (x) => x >= from && x <= t + 0.05;
    const dt = (x) => Math.round((x - t) * 10) / 10;
    const myCasts = trace.casts.filter((c) => c[1] === npc && inWindow(c[0]));
    // The first moment in the window the hero could not act freely: a disable sampled as already on at its
    // start counts from 0, whether or not the log shows it being applied inside the window.
    let disabledAt = null;
    for (const kind of DISABLED) for (const [a, b] of trace.controls[h]?.[kind] ?? []) if (b > from && a <= t) { const at = Math.max(a, from); if (disabledAt == null || at < disabledAt) disabledAt = at; }
    for (const m of trace.modifiers) if (m[1] === npc && m[4] === 1 && m[6] !== 'i' && inWindow(m[0]) && (disabledAt == null || m[0] < disabledAt)) disabledAt = m[0];
    const castNames = new Set(myCasts.map((c) => trace.names[c[2]]));
    return {
      // The window is part of what the record says (its damage, its snapshots): a non-default one is in the ref.
      ref: `death:${trace.heroes[h].key}:${n}${window === 12 ? '' : `:w${window}`}`, n, t, clock: clock(t), killer: nameOf(trace, d[2]), row: d[3],
      at: where(stateAt(trace, h, t - 1)),
      level: stateAt(trace, h, t - 1)?.level ?? null,
      snapshots,
      at_window_start: { abilities, items },
      most_mana_in_window: mana,
      ready_not_cast: abilities.filter((a) => a.cooldown_left === 0 && !castNames.has(a.ability) && !noMana(a)).map((a) => a.ability),
      off_cooldown_without_the_mana: abilities.filter((a) => a.cooldown_left === 0 && !castNames.has(a.ability) && noMana(a)).map((a) => a.ability),
      health_share_at_window_start: share(snapshots[0]?.me),
      // How much closer to their own fountain the hero was at the last snapshot than at the window's start: positive
      // heading home, negative heading away from it. Null when either distance is unknown. Over 1089 deaths outside
      // fights in 32 games (scripts/calibrate.mjs), the 101 heading home by 1500 or more were traded 13% of the time,
      // the fewest of any; 240 began farming (17%). An escape that came too late buys nothing.
      // Both ends alive and in this life: a window that reaches back past the hero's previous death or gravestone
      // (a respawn, buyback or in-place revival less than a window ago) has no heading (Codex P1 on #415).
      moved_toward_own_fountain: snapshots[0]?.me?.to_own_fountain != null && snapshots.at(-1)?.me?.to_own_fountain != null && !myRawDeaths.some((o) => o !== d && o[0] < t && (classifyDeath(trace, o).revived_at ?? o[0]) >= from) ? snapshots[0].me.to_own_fountain - snapshots.at(-1).me.to_own_fountain : null,
      // From the health itself, not the rounded share: 495 of 1000 is below half.
      below_half_health_at_window_start: snapshots[0]?.me?.max_hp ? snapshots[0].me.hp * 2 < snapshots[0].me.max_hp : null,
      // Null where the hero's position was not sampled: whether an ally was near is then unknown.
      in_a_fight: !fought.has(d) ? false : mostAllies == null ? null : mostAllies >= 1,
      // Null where the hero's own position was not sampled: no ally listed is then unknown, not alone.
      // "At death" is the moment itself, not the last snapshot a second before: an ally can arrive in that second.
      allies_within_2200: { at_window_start: snapshots[0].me ? snapshots[0].allies.length : null, at_death: atDeath.me ? atDeath.allies.length : null, most_in_any_second: mostAllies },
      first_hero_damage_dt: firstHero == null ? null : Math.round(firstHero - t),
      // Counted over every damage row of the window, not over the ten largest listed below.
      enemy_heroes_dealing_damage: attackers.size,
      seconds_before_first_disable: disabledAt == null ? null : Math.max(0, Math.round((disabledAt - from) * 10) / 10),
      damage_taken: [...dmg].map(([k, v]) => { const [a, i] = k.split('|').map(Number); return { from: nameOf(trace, a), by: i >= 0 ? trace.names[i].replace(/^item_/, '') : 'attack', value: v }; }).sort((x, y) => y.value - x.value).slice(0, 10),
      controls_on_me: trace.modifiers.filter((m) => m[1] === npc && m[4] === 1 && m[6] !== 'i' && inWindow(m[0]))
        .map((m) => ({ dt: dt(m[0]), modifier: trace.names[m[2]], from: nameOf(trace, m[3]), kind: { t: 'stun', r: 'root', s: 'silence' }[m[6]], ...(m[5] ? { duration: m[5] } : {}) })),
      my_casts: myCasts.map((c) => ({ dt: dt(c[0]), ability: trace.names[c[2]], target: nameOf(trace, c[3]), row: c[4] })),
      my_item_uses: trace.item_uses.filter((u) => u[1] === npc && inWindow(u[0])).map((u) => ({ dt: dt(u[0]), item: trace.names[u[2]].replace(/^item_/, ''), row: u[3] })),
      enemy_casts_on_me: trace.casts.filter((c) => c[3] === npc && c[1] !== npc && inWindow(c[0]) && heroOfName(trace, c[1]) >= 0 && trace.heroes[heroOfName(trace, c[1])].team !== trace.heroes[h].team)
        .map((c) => ({ dt: dt(c[0]), by: nameOf(trace, c[1]), ability: trace.names[c[2]], row: c[4] })),
      other_deaths: real.filter((o) => o !== d && Math.abs(o[0] - t) <= 20).map((o) => deathRow(trace, o, t, view)),
      // Whether the team got a hero back for it: an enemy hero died for real within TRADE_SECONDS of this death, before or after.
      traded_within_15s: real.some((o) => { const v = heroOfName(trace, o[1]); return v >= 0 && trace.heroes[v].team !== trace.heroes[h].team && Math.abs(o[0] - t) <= TRADE_SECONDS; }),
      // The allies who were not within 2200 at the death: what the replay shows them doing, where, how far.
      allies_elsewhere: alliesElsewhere(trace, h, t, atDeath),
      // Observer wards standing within 1600 of where the hero died, each side's. Null: the trace has no ward list.
      observers_within_1600: wardsAt(trace, h, atDeath, t),
      // The clock of a buyback after this death, false when none, null when the trace does not record buybacks.
      bought_back: (() => { const b = boughtBackAfter(trace, h, t); return b == null || b === false ? b : clock(b); })(),
      ...(hasReincarnation ? { reincarnation_at_death: reincarnationAtDeath(trace, h, t) } : {}),
      damage_sources: sources,
    };
  });
  const heroKey = trace.heroes[h].key;
  // Whether hero `j` can be placed (or ruled out as dead) at `t`: a hero with unsampled alive or position may have been standing within 2200.
  const heroNearKnown = (j, t) => {
    const st = stateAt(trace, j, t);
    if (st) {
      const rawAlive = trace.states?.[j]?.alive?.[st.t - trace.t0];
      if (rawAlive === 0) return true;
      return rawAlive === 1 && st.x != null && st.y != null;
    }
    const k0 = Math.round(t) - trace.t0;
    return k0 >= 0 && k0 < trace.n && trace.states?.[j]?.alive?.[k0] === 0;
  };
  const myRes = resurrections(trace).filter((r) => r.heroIndex === h).map((r, i) => {
    const atRes = nearby(trace, h, r.t, 2200);
    const meKnown = Boolean(atRes.me && atRes.me.x != null && atRes.me.y != null);
    const alliesKnown = meKnown && trace.heroes.every((o, j) => j === h || o.team !== trace.heroes[h].team || heroNearKnown(j, r.t));
    const enemiesKnown = meKnown && trace.heroes.every((o, j) => o.team === trace.heroes[h].team || heroNearKnown(j, r.t));
    const nextIdx = all.findIndex((d) => d[0] > r.t);
    const nextReal = nextIdx >= 0 ? all[nextIdx] : null;
    const diedSoon = !nextReal ? false
      : r.revived_at != null ? (nextReal[0] - r.revived_at <= 20 ? { ref: `death:${heroKey}:${nextIdx + 1}`, clock: clock(nextReal[0]), killer: nameOf(trace, nextReal[2]), seconds_after_revive: Math.round((nextReal[0] - r.revived_at) * 10) / 10 } : false)
        : nextReal[0] - r.t <= 27 ? null : false;
    return {
      ref: `resurrection:${heroKey}:${i + 1}`, hero: heroKey, n: i + 1, t: r.t, clock: clock(r.t), by: r.by, killer: nameOf(trace, r.killer), row: r.row,
      revived_at: r.revived_at == null ? null : clock(r.revived_at),
      at: meKnown ? where(atRes.me) : null,
      allies_within_2200: alliesKnown ? atRes.allies.map((a) => a.hero) : null,
      enemies_within_2200: enemiesKnown ? atRes.enemies.map((e) => e.hero) : null,
      died_for_real_within_20s: diedSoon,
    };
  });
  const killers = {};
  for (const d of all) { const k = nameOf(trace, d[2]) ?? 'unknown'; killers[k] = (killers[k] ?? 0) + 1; }
  // The counts below are over this window: a non-default one is in the summary's ref, as in each death's.
  return {
    ref: `deaths:${heroKey}${window === 12 ? '' : `:w${window}`}`, ref_scope: 'summary', hero: heroKey, team: TEAM[trace.heroes[h].team], window, deaths_total: all.length, killed_by: killers,
    ...(myRes.length ? { resurrections_total: myRes.length, resurrections_at: myRes.map((r) => r.clock) } : {}),
    ...deathPatterns(trace, out, { allSources: args.all_damage_sources === true }), ...leftUnused(out, heroKey),
    deaths: args.index == null ? out : [out[args.index - 1]],
    ...(myRes.length ? { resurrections: myRes } : {}),
    gaps: gapsFor(trace, ['vision', 'creeps', 'unused_free_abilities']),
  };
}

const share = (me) => (me?.max_hp ? Math.round((me.hp / me.max_hp) * 100) / 100 : null);

const fountainCache = new WeakMap();
/** A hero back within this distance of where they fell came back in place (the Aegis), not in the fountain. */
const IN_PLACE = 1500;
/**
 * Where hero h's fountain is, from the trace itself: the first position sampled alive after one of the hero's
 * deaths (a hero respawns in their fountain). The trace has no building or fountain positions; null when no
 * respawn was sampled (unknown, not anywhere).
 */
export function ownFountain(trace, h, npc = nameId(trace, trace.heroes[h].npc)) {
  let byHero = fountainCache.get(trace);
  if (!byHero) fountainCache.set(trace, (byHero = new Map()));
  if (byHero.has(h)) return byHero.get(h);
  const s = trace.states[h];
  const own = trace.heroes[h].team === 2 ? 'radiant_base' : 'dire_base';
  let at = null;
  for (const d of trace.deaths.filter((x) => x[1] === npc).sort((a, b) => a[0] - b[0])) {
    let i = Math.max(0, Math.ceil(d[0]) - trace.t0 + 1);
    // Only a respawn the samples show: dead one second, alive the next, with a position. A gap in the samples
    // (neither dead nor alive known) leaves this death out — the first alive sample after a gap may already be
    // in a lane (Codex P1 on #415) — and the next death is tried.
    while (i < trace.n && s.alive[i] === 0) i += 1;
    if (!(i < trace.n && i > 0 && s.alive[i] === 1 && s.alive[i - 1] === 0 && s.x[i] != null && s.y[i] != null)) continue;
    const back = { x: s.x[i], y: s.y[i] };
    // In the hero's own base, and not where they fell: the Aegis brings a hero back where they died (Codex P1 on
    // #415), and that is no fountain. Unknown death position: not established, the next death is tried.
    const fell = stateAt(trace, h, d[0] - 1);
    if (region(back.x, back.y) !== own || !fell || dist(fell, back) < IN_PLACE) continue;
    at = back; break;
  }
  byHero.set(h, at);
  return at;
}

/** Each side's observers within 1600 of the hero at a death, told as my_team / enemy; null when unknown. */
function wardsAt(trace, h, atDeath, t) {
  const near = observersNear(trace, atDeath?.me ? { x: atDeath.me.x, y: atDeath.me.y } : null, t);
  if (!near) return null;
  const team = trace.heroes[h].team;
  return { my_team: near[team], enemy: near[team === 2 ? 3 : 2] };
}

/** A death is traded when an enemy hero dies this close to it in time. */
export const TRADE_SECONDS = 15;
/**
 * The hero's allies not within 2200 at second t, as the replay shows them: dead and respawning in, or where,
 * doing what (only what the replay shows: in base, trading damage, at a building), how far, TP ready. Empty
 * when the hero's own position was not sampled (who was near is then unknown, and so who was not).
 */
function alliesElsewhere(trace, h, t, atDeath) {
  if (!atDeath?.me) return [];
  const near = new Set(atDeath.allies.map((a) => a.hero));
  const from = { x: atDeath.me.x, y: atDeath.me.y };
  return trace.heroes.map((o, i) => i).filter((i) => i !== h && trace.heroes[i].team === trace.heroes[h].team && !near.has(trace.heroes[i].key)).map((i) => {
    const s = heroStateAt(trace, i, t, { from });
    if (!s.known) return { hero: s.hero, known: false };
    if (!s.alive) return { hero: s.hero, doing: 'dead', respawn_in: s.respawn_in };
    return { hero: s.hero, ...(s.doing !== 'none_of_these' ? { doing: s.doing } : {}), place: s.place, distance: s.distance, ...(s.tp_ready != null ? { tp_ready: s.tp_ready } : {}) };
  });
}

/**
 * What the hero's deaths have in common, counted: each entry lists the deaths
 * (by game time) it is true of, so a habit shows as a count over the game and
 * not as one more anecdote. And where the damage in those windows came
 * from — one enemy's attacks, or many heroes' abilities — which is what an
 * item answer has to match. Facts only: unknown health or position leaves a
 * death out of a list, it does not put it in.
 */
function deathPatterns(trace, deaths, { allSources = false } = {}) {
  // By game time, which is how a death is named to a player (and what a sentence citing this summary will state).
  const of = (test) => deaths.filter(test).map((d) => d.clock);
  const by = new Map(); let total = 0;
  for (const d of deaths) {
    // Over every damage row of each window, not the ten largest a record lists.
    for (const [key, value] of d.damage_sources) { by.set(key, (by.get(key) ?? 0) + value); total += value; }
    delete d.damage_sources;
  }
  // The six largest for a reader; every source for a caller that adds them up (all_damage_sources).
  const sorted = [...by].sort((a, b) => b[1] - a[1]);
  const top = allSources ? sorted : sorted.slice(0, 6);
  return {
    deaths_where: {
      health_below_half_at_window_start: of((d) => d.below_half_health_at_window_start === true),
      // In every second of the window and at the death itself.
      no_ally_within_2200_throughout: of((d) => d.allies_within_2200.most_in_any_second === 0),
      no_ally_within_2200_at_death: of((d) => d.allies_within_2200.at_death === 0),
      three_or_more_enemy_heroes_dealing_damage: of((d) => d.enemy_heroes_dealing_damage >= 3),
      // In a fight (one of three or more hero deaths close together in time, with an ally within 2200 before it)
      // or not. Dying low or to several enemies in a fight is what fights are; outside one it is where the hero
      // chose to be. Hence the two lists after. A death whose position was not sampled is in neither list.
      in_a_fight: of((d) => d.in_a_fight === true),
      outside_fights: of((d) => d.in_a_fight === false),
      health_below_half_at_window_start_outside_fights: of((d) => d.below_half_health_at_window_start === true && d.in_a_fight === false),
      three_or_more_enemy_heroes_dealing_damage_outside_fights: of((d) => d.enemy_heroes_dealing_damage >= 3 && d.in_a_fight === false),
      nothing_cast_and_no_item_used: of((d) => d.my_casts.length === 0 && d.my_item_uses.length === 0),
      // What the hero was doing when the window began, and where they were heading over it (each death's
      // snapshots): the decisions deaths share, beside the conditions above. Unknown doing or heading leaves a
      // death out of these lists, never in one.
      farming_at_window_start: of((d) => d.snapshots[0]?.me?.doing === 'farming'),
      heading_home_1500_or_more: of((d) => d.moved_toward_own_fountain != null && d.moved_toward_own_fountain >= 1500),
      heading_away_1500_or_more: of((d) => d.moved_toward_own_fountain != null && d.moved_toward_own_fountain <= -1500),
      // Whether the team got an enemy hero back within 15 s. A death not traded bought nothing.
      traded_within_15s: of((d) => d.traded_within_15s),
      not_traded_within_15s: of((d) => !d.traded_within_15s),
      no_ally_within_2200_at_death_and_not_traded: of((d) => d.allies_within_2200.at_death === 0 && !d.traded_within_15s),
      // Only where the trace has wards (a death with no ward list is in neither).
      no_own_observer_within_1600: of((d) => d.observers_within_1600?.my_team === 0),
      enemy_observer_within_1600: of((d) => d.observers_within_1600?.enemy > 0),
      bought_back: of((d) => typeof d.bought_back === 'string'),
    },
    // Deaths a list above could not be decided for (health or position not sampled): a count over the game is only as sure as these are few.
    deaths_not_known: {
      health_at_window_start: deaths.filter((d) => d.below_half_health_at_window_start == null).length,
      allies_at_death: deaths.filter((d) => d.allies_within_2200.at_death == null).length,
      // Whether a death was in a fight is unknown where the hero's position was not sampled.
      in_a_fight: deaths.filter((d) => d.in_a_fight == null).length,
      // For each outside-fights list, the deaths it can neither include nor rule out: neither in a fight for sure
      // nor outside one with the condition for sure. A count over the next game is only as sure as these are few.
      health_below_half_at_window_start_outside_fights: deaths.filter((d) => d.in_a_fight !== true && d.below_half_health_at_window_start !== false && !(d.in_a_fight === false && d.below_half_health_at_window_start === true)).length,
      three_or_more_enemy_heroes_dealing_damage_outside_fights: deaths.filter((d) => d.in_a_fight == null && d.enemy_heroes_dealing_damage >= 3).length,
    },
    damage_in_death_windows_total: total,
    damage_in_death_windows: Object.fromEntries(top),
    damage_share_in_death_windows: Object.fromEntries(top.map(([k, v]) => [k, total ? Math.round((v / total) * 100) / 100 : null])),
  };
}

/**
 * The deaths in a fixed order of how much the hero still had when it began.
 * "Which death was the most avoidable" has no single right answer, but it
 * should not have a different one each time it is asked: the order is made
 * here, by a stated rule, from the facts of each record. It weighs only what
 * the hero had (not the state of the game, not what could be seen).
 */
/** The sampled states in which a hero cannot use what it has. */
const DISABLED = ['stunned', 'taunted', 'silenced', 'rooted'];
const LEFT_UNUSED_RULE = 'most own abilities ready at the start of the window and never cast in it; then highest share of health at the start; then longest time before the first disable landed; then the earlier death';
function leftUnused(deaths, heroKey) {
  const rows = deaths.map((d) => {
    return {
      death: d.n, clock: d.clock, killer: d.killer,
      // The hero's own abilities, by their key: map actions every hero has (capturing an outpost, a twin gate) are not something left unused in a fight.
      // The hero's own abilities: named after the internal slug ("queenofpain_…"), which is not always the replay's key for the hero.
      ready_not_cast: d.ready_not_cast.filter((a) => a.startsWith(`${heroKey}_`) || a.startsWith(`${heroByKey(heroKey)?.internalSlug ?? heroKey}_`)),
      health_share_at_window_start: d.health_share_at_window_start,
      seconds_before_first_disable: d.seconds_before_first_disable,
      enemy_heroes_dealing_damage: d.enemy_heroes_dealing_damage,
    };
  });
  const free = (r) => r.seconds_before_first_disable ?? Infinity;
  rows.sort((a, b) => b.ready_not_cast.length - a.ready_not_cast.length || (b.health_share_at_window_start ?? 0) - (a.health_share_at_window_start ?? 0) || free(b) - free(a) || a.death - b.death);
  return { most_left_unused_rule: LEFT_UNUSED_RULE, most_left_unused: rows };
}

/** The ability key of hero h that `name` means: exact, with the hero prefix, or a unique suffix. */
function resolveAbility(trace, h, name) {
  const keys = Object.keys(trace.abilities[h]);
  const k = String(name ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!k) return null;
  return keys.find((x) => x === k) ?? keys.find((x) => x === `${trace.heroes[h].key}_${k}`) ?? (keys.filter((x) => x.endsWith(`_${k}`)).length === 1 ? keys.find((x) => x.endsWith(`_${k}`)) : null) ?? null;
}

/**
 * Damage by an ability in this long after a cast (or until the second of its next cast) is counted to that cast: a wave
 * travels, a maze waits to be walked into, a plague ticks. What comes later is not seen, and the field says so.
 */
const HIT_WITHIN = 15;
/** A projectile takes time to arrive: a stun the caster applies up to this long after the cast is the cast's. */
const STUN_LANDS_WITHIN = 3;

/**
 * Seconds the target was stunned by THIS cast, or 0. A stun counts only when
 * the combat log shows the caster applying a stun to the target from the
 * cast until `until` (three seconds, or the caster's next cast of the same
 * ability if sooner): several abilities often land on one hero in the same
 * second, and another hero's stun must not be read as this ability working.
 * The length is the one measured from the state samples around the moment
 * the stun was applied (it can be cut short), else the duration the log gives.
 */
function stunnedByCast(trace, h, casterNpc, targetNpc, t, until) {
  const applied = trace.modifiers.find((m) => m[4] === 1 && m[6] === 't' && m[1] === targetNpc && m[3] === casterNpc && m[0] >= t - 0.2 && m[0] <= until);
  if (!applied) return 0;
  const iv = (trace.controls[h]?.stunned ?? []).find(([a]) => a >= applied[0] - 0.5 && a <= applied[0] + 0.5);
  return iv ? Math.round((iv[1] - iv[0]) * 10) / 10 : applied[5];
}

export function abilityAudit(trace, args = {}, ctx = {}) {
  const view = viewer(trace, ctx);
  const { h, npc, err } = needHero(trace, args.hero);
  if (err) return err;
  const can = [...castable(trace, h, npc)].filter((k) => trace.abilities[h][k]);
  const key = resolveAbility(trace, h, args.ability);
  if (!key) return fail('unknown_ability', { abilities: can });
  const entry = trace.abilities[h][key];
  const abilityId = nameId(trace, key);
  const immune = immunityIntervals(trace);
  const learned = entry.levels.find(([, lv]) => lv > 0)?.[0] ?? null;
  const rows = trace.casts.filter((c) => c[1] === npc && c[2] === abilityId).sort((a, b) => a[0] - b[0]);
  const byTarget = {};
  const short = key.startsWith(`${trace.heroes[h].key}_`) ? key.slice(trace.heroes[h].key.length + 1) : key;
  // Whether this ability shows in the damage log at all: only then does "damaged nobody" mean something.
  const damaging = trace.damage.some((r) => r[1] === npc && r[3] === abilityId);
  const real = realDeaths(trace);
  // What the casts have in common, by game time (like deaths_where): a habit is a count over the game.
  const intoImmunity = []; const targetLived = []; const cameToLittle = []; let nearNotKnown = 0;
  const casts = rows.map((c, ci) => {
    const t = c[0]; const target = heroOfName(trace, c[3]);
    // Damage is kept per whole second: the second a recast falls in is counted to the recast, never to both casts.
    const hitUntil = Math.min(t + HIT_WITHIN, Math.floor(rows[ci + 1]?.[0] ?? Infinity) - 1);
    const hit = new Set();
    if (damaging) for (const r of trace.damage) { if (r[1] !== npc || r[3] !== abilityId || r[0] < Math.floor(t) || r[0] > hitUntil) continue; const th = heroOfName(trace, r[2]); if (th >= 0 && trace.heroes[th].team !== trace.heroes[h].team) hit.add(trace.heroes[th].key); }
    const { me, allies, enemies } = nearby(trace, h, t, 1300);
    const ts = target >= 0 ? stateAt(trace, target, t) : null;
    const targetName = nameOf(trace, c[3]);
    if (targetName) byTarget[targetName] = (byTarget[targetName] ?? 0) + 1;
    const during = target >= 0 ? immune.find((w) => w.hero === target && w.from <= t && (w.to == null || t < w.to)) : null;
    const soonAfter = target >= 0 && !during ? immune.find((w) => w.hero === target && w.from > t && w.from <= t + 3) : null;
    const stunned = target >= 0 ? stunnedByCast(trace, target, npc, c[3], t, Math.min(t + STUN_LANDS_WITHIN, (rows[ci + 1]?.[0] ?? Infinity) - 0.2)) : null;
    if (during && !(stunned > 0)) intoImmunity.push(clock(t));
    // Aimed at an enemy hero (the hero itself, not an illusion of it) who did not die in the next 12 seconds.
    if (target >= 0 && trace.heroes[target].team !== trace.heroes[h].team && targetName === trace.heroes[target].key && !real.some((d) => d[1] === c[3] && d[0] >= t && d[0] - t <= 12)) targetLived.push(clock(t));
    // Not aimed at a hero, used where an enemy hero was, and it came to little: its damage reached one enemy hero
    // or none, and no hero it damaged died in the next 12 seconds. A cast with no enemy hero within 1300 that
    // damaged none is travel or farming, not a miss; one whose single target died is a pick-off. Over the
    // ultimates of 32 parsed games, "at most one damaged" alone was 2001 casts: 1010 with nobody near, 348
    // pick-offs, and 643 that are counted here.
    const diedOfIt = [...hit].some((k) => real.some((d) => d[0] >= t && d[0] - t <= 12 && trace.heroes[heroOfName(trace, d[1])]?.key === k));
    // Whether an enemy hero was near is known when a sampled one is within 1300 or the cast damaged one. With
    // neither it is "no" only when the caster and every enemy hero have a position at that second; with a sample
    // missing it is not known, and the cast is counted apart instead of being read as travel or farming.
    const near = enemies.length > 0 || hit.size > 0 ? true : me != null && trace.heroes.every((o, i) => o.team === trace.heroes[h].team || stateAt(trace, i, t) != null) ? false : null;
    if (damaging && target < 0 && hit.size <= 1 && !diedOfIt) { if (near) cameToLittle.push(clock(t)); else if (near == null) nearNotKnown += 1; }
    return {
      ref: `cast:${trace.heroes[h].key}:${short}:${ci + 1}`, t, clock: clock(t), row: c[4], target: targetName,
      target_hp: ts ? { hp: ts.hp, max_hp: ts.max_hp } : null,
      target_spell_immune: target >= 0 ? Boolean(during) : null,
      // What the replay shows this cast did (a stun the log attributes to the caster), whatever the ability is supposed to do.
      target_stunned_seconds: stunned,
      ...(soonAfter ? { target_became_immune_dt: Math.round((soonAfter.from - t) * 10) / 10 } : {}),
      me: me ? { hp: me.hp, max_hp: me.max_hp, ...where(me) } : null,
      allies_within_1300: allies.map((a) => a.hero), enemies_within_1300: enemies.map((e) => e.hero),
      ...(damaging ? { enemy_heroes_damaged_within_15s: [...hit] } : {}),
      deaths_within_12s: real.filter((d) => d[0] >= t && d[0] - t <= 12).map((d) => deathRow(trace, d, t, view)),
    };
  });
  let alive = 0; let idle = 0;
  if (learned != null) {
    // Up to the end of the game, not of the samples: post-game seconds are not time the ability sat unused.
    for (let t = Math.max(0, Math.ceil(learned)); t <= gameEnd(trace); t += 1) {
      const s = stateAt(trace, h, t);
      if (!s?.alive) continue;
      alive += 1;
      if (cooldownLeft(entry, t) === 0) idle += 1;
    }
  }
  const myDeaths = real.filter((d) => d[1] === npc).sort((a, b) => a[0] - b[0]);
  // Off cooldown with less mana in those 12 seconds than it costs is not "ready and not cast".
  const afford = (d) => { const cost = manaCost(entry, d[0] - 12, d[0]); const mana = mostMana(trace, h, d[0] - 12, d[0]); return cost == null || mana == null || mana >= cost; };
  const passiveOnDeath = DEATH_TRIGGERED_ABILITIES.has(key);
  const triggered = passiveOnDeath ? resurrections(trace).filter((r) => r.heroIndex === h && r.by === 'reincarnation').map((r) => clock(r.t)) : null;
  const unused = passiveOnDeath ? [] : myDeaths.filter((d) => abilityLevel(entry, d[0]) > 0 && cooldownLeft(entry, d[0] - 0.5) === 0 && !rows.some((c) => d[0] - c[0] >= 0 && d[0] - c[0] <= 12)).filter(afford);
  return {
    ref: `audit:${trace.heroes[h].key}:${short}`, ref_scope: 'summary',
    hero: trace.heroes[h].key, ability: key,
    learned_at: learned == null ? null : { t: learned, clock: clock(learned) },
    casts_total: casts.length, by_target: byTarget,
    ...(triggered ? { triggered_on_death_total: triggered.length, triggered_on_death: triggered } : {}),
    casts_on_spell_immune_target: casts.filter((c) => c.target_spell_immune).length,
    of_those_target_was_stunned: casts.filter((c) => c.target_spell_immune && c.target_stunned_seconds > 0).length,
    casts_where: {
      target_spell_immune_and_not_stunned: intoImmunity,
      enemy_hero_target_alive_12s_later: targetLived,
      // Only for an ability that shows in the damage log at all: otherwise "damaged nobody" says nothing.
      ...(damaging ? { no_hero_target_near_enemies_at_most_one_damaged_and_none_died: cameToLittle } : {}),
    },
    // Casts the list above could neither include nor rule out: no enemy hero damaged, and a position missing at
    // that second, so whether one was near is not known. The count is at least the list, at most the list plus these.
    ...(damaging ? { casts_not_known: { enemy_heroes_near: nearNotKnown } } : {}),
    seconds_alive_since_learned: alive, seconds_alive_and_ready: idle,
    deaths_with_it_ready_and_not_cast_total: unused.length,
    deaths_with_it_ready_and_not_cast: unused
      .map((d) => ({ ref: `death:${trace.heroes[h].key}:${myDeaths.indexOf(d) + 1}`, t: d[0], clock: clock(d[0]), killer: nameOf(trace, d[2]), row: d[3] })),
    casts,
    gaps: gapsFor(trace, ['ability_immunity', 'vision']),
  };
}

export function immunityWindows(trace, args = {}) {
  const team = args.team === 'radiant' ? 2 : args.team === 'dire' ? 3 : null;
  const only = args.hero == null ? -1 : heroIndex(trace, args.hero);
  if (args.hero != null && only < 0) return fail('unknown_hero', { heroes: heroKeys(trace) });
  let watch = null;
  if (args.watch_hero != null) {
    const w = needHero(trace, args.watch_hero);
    if (w.err) return w.err;
    const key = resolveAbility(trace, w.h, args.watch_ability);
    if (!key) return fail('unknown_ability', { abilities: Object.keys(trace.abilities[w.h]) });
    watch = { ...w, key, entry: trace.abilities[w.h][key], id: nameId(trace, key) };
  }
  const nth = new Map();
  const windows = immunityIntervals(trace).map((w) => { const n = (nth.get(w.hero) ?? 0) + 1; nth.set(w.hero, n); return { ...w, n }; }).filter((w) => (only < 0 || w.hero === only) && (team == null || trace.heroes[w.hero].team === team)).map((w) => {
    // A window looked at while watching an ability says so in its ref (the watched state is part of the record).
    const watched = watch ? `:${trace.heroes[watch.h].key}-${watch.key.startsWith(`${trace.heroes[watch.h].key}_`) ? watch.key.slice(trace.heroes[watch.h].key.length + 1) : watch.key}` : '';
    const row = { ref: `immune:${trace.heroes[w.hero].key}:${w.n}${watched}`, hero: trace.heroes[w.hero].key, team: TEAM[trace.heroes[w.hero].team], modifier: w.modifier.replace(/^modifier_/, ''), from: w.from, clock: clock(w.from), to: w.to, seconds: w.to == null ? null : Math.round((w.to - w.from) * 10) / 10 };
    if (!watch) return row;
    const s = stateAt(trace, watch.h, w.from);
    const left = cooldownLeft(watch.entry, w.from);
    // The window is [from, to): the same reading ability_audit uses, so a cast in the tenth of a second the
    // immunity was removed is after it in both. No logged removal: open until the game ends.
    const during = (t) => t >= w.from && (w.to == null ? t <= gameEnd(trace) : t < w.to);
    const target = nameId(trace, trace.heroes[w.hero].npc);
    const last = trace.casts.filter((c) => c[1] === watch.npc && c[2] === watch.id && c[0] <= w.from).at(-1);
    return {
      ...row,
      watched: {
        state: abilityLevel(watch.entry, w.from) === 0 ? 'not_learned' : !s ? 'unknown' : !s.alive ? 'dead' : left > 0 ? 'on_cooldown' : 'ready',
        ...(left > 0 ? { cooldown_left: left } : {}),
        ...(last ? { last_cast: { t: last[0], clock: clock(last[0]), target: nameOf(trace, last[3]), seconds_before: Math.round((w.from - last[0]) * 10) / 10 } } : {}),
        // During means during: a cast seconds before the window opened was spent before the immunity, not into it.
        cast_on_this_hero_during: trace.casts.filter((c) => c[1] === watch.npc && c[2] === watch.id && c[3] === target && during(c[0])).map((c) => ({ t: c[0], clock: clock(c[0]), row: c[4] })),
        cast_on_this_hero_in_the_3s_before: trace.casts.filter((c) => c[1] === watch.npc && c[2] === watch.id && c[3] === target && c[0] >= w.from - 3 && c[0] < w.from).map((c) => ({ t: c[0], clock: clock(c[0]), seconds_before: Math.round((w.from - c[0]) * 10) / 10, row: c[4] })),
        distance: s && stateAt(trace, w.hero, w.from) ? dist(s, stateAt(trace, w.hero, w.from)) : null,
      },
    };
  });
  const states = {};
  if (watch) for (const w of windows) states[w.watched.state] = (states[w.watched.state] ?? 0) + 1;
  return {
    ...(watch ? { watching: { hero: trace.heroes[watch.h].key, ability: watch.key }, watched_state_when_window_opened: states, windows_with_a_cast_on_the_immune_hero: windows.filter((w) => w.watched.cast_on_this_hero_during.length).length } : {}),
    // What was watched is part of what the totals say: it is in the ref, so the same answer can be shown again.
    ref: `immunity:${only >= 0 ? trace.heroes[only].key : team === 2 ? 'radiant' : team === 3 ? 'dire' : 'all'}${watch ? `:${trace.heroes[watch.h].key}:${watch.key.startsWith(`${trace.heroes[watch.h].key}_`) ? watch.key.slice(trace.heroes[watch.h].key.length + 1) : watch.key}` : ''}`, ref_scope: 'summary',
    windows_total: windows.length, windows, gaps: gapsFor(trace, ['ability_immunity']),
  };
}

export function fightTimeline(trace, args = {}, ctx = {}) {
  const view = viewer(trace, ctx);
  // Whole seconds, widened outward: the window the answer covers is exactly the one its ref names, so the
  // same answer can be made again from the ref.
  const f0 = seconds(args.from); const t0 = seconds(args.to);
  if (f0 == null || t0 == null || t0 <= f0) return fail('invalid_window');
  const from = Math.floor(f0); const to = Math.ceil(t0);
  if (to - from > MAX_FIGHT_WINDOW) return fail('window_too_long', { max_seconds: MAX_FIGHT_WINDOW });
  const inWindow = (t) => t >= from && t <= to;
  const positions = (t) => trace.heroes.map((h, i) => { const s = stateAt(trace, i, t); return { hero: h.key, ...(view ? sideOf(view, trace, i) : { team: TEAM[h.team] }), ...(s ? { alive: s.alive, hp: s.hp, max_hp: s.max_hp, ...where(s) } : { alive: null }) }; });
  const rows = [];
  for (const d of trace.deaths) {
    if (!inWindow(d[0])) continue;
    const c = classifyDeath(trace, d);
    rows.push({ p: 0, t: d[0], kind: c.real ? 'death' : c.by, hero: nameOf(trace, d[1]), ...sideOf(view, trace, heroOfName(trace, d[1])), killer: nameOf(trace, d[2]), row: d[3] });
  }
  for (const b of trace.buildings) if (inWindow(b[0])) rows.push({ p: 0, t: b[0], kind: 'building', building: unit(trace.names[b[1]]), ...(view ? { lost_by: buildingTeam(trace.names[b[1]]) === view.team ? 'my_team' : 'enemy' } : { taken_by: TEAM[b[2]] ?? null }), row: b[3] });
  for (const m of trace.modifiers) if (m[6] === 'i' && m[4] === 1 && inWindow(m[0])) rows.push({ p: 0, t: m[0], kind: 'spell_immune', hero: nameOf(trace, m[1]), ...sideOf(view, trace, heroOfName(trace, m[1])), modifier: trace.names[m[2]].replace(/^modifier_/, ''), ...(m[7] == null ? {} : { row: m[7] }) });
  for (const u of trace.item_uses) if (inWindow(u[0]) && !NOISE_ITEMS.test(trace.names[u[2]])) rows.push({ p: 1, t: u[0], kind: 'item', hero: nameOf(trace, u[1]), item: trace.names[u[2]].replace(/^item_/, ''), row: u[3] });
  for (const c of trace.casts) if (inWindow(c[0])) rows.push({ p: heroOfName(trace, c[3]) >= 0 ? 1 : 2, t: c[0], kind: 'cast', hero: nameOf(trace, c[1]), ability: trace.names[c[2]], ...(c[3] >= 0 ? { target: nameOf(trace, c[3]) } : {}), row: c[4] });
  let kept = rows; let truncated = false;
  for (const drop of [2, 1]) {
    if (kept.length <= MAX_TIMELINE_ROWS) break;
    truncated = true;
    kept = kept.filter((r) => r.p < drop);
  }
  if (kept.length > MAX_TIMELINE_ROWS) kept = kept.slice(0, MAX_TIMELINE_ROWS);
  const dealt = new Map(); const taken = new Map();
  for (const [sec, a, target, , value] of trace.damage) {
    if (sec < Math.floor(from) || sec > to) continue;
    const v = heroOfName(trace, target);
    if (v < 0) continue;
    const att = nameOf(trace, a);
    dealt.set(att, (dealt.get(att) ?? 0) + value);
    taken.set(trace.heroes[v].key, (taken.get(trace.heroes[v].key) ?? 0) + value);
  }
  const top = (m) => [...m].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([k, v]) => ({ unit: k, value: v }));
  const real = realDeaths(trace);
  const firstDeath = real.filter((d) => inWindow(d[0])).sort((a, b) => a[0] - b[0])[0];
  // How many heroes each side lost in the window (real deaths, not Reincarnation or Aegis revivals).
  const lost = { 2: 0, 3: 0 };
  for (const d of real) { const v = heroOfName(trace, d[1]); if (inWindow(d[0]) && v >= 0 && d[1] === nameId(trace, trace.heroes[v].npc)) lost[trace.heroes[v].team] += 1; }
  return {
    ref: `timeline:${Math.round(from)}-${Math.round(to)}`, from, to, clock: `${clock(from)}–${clock(to)}`,
    hero_deaths_in_window: view ? { my_team: lost[view.team], enemy: lost[view.team === 2 ? 3 : 2] } : { radiant: lost[2], dire: lost[3] },
    positions_at_start: positions(from),
    ...(firstDeath ? { positions_at_first_death: { t: firstDeath[0], clock: clock(firstDeath[0]), heroes: positions(firstDeath[0]) } } : {}),
    // Times are rounded to 0.1 s: within one, the combat log's own order decides.
    events: kept.sort((a, b) => a.t - b.t || (a.row ?? 0) - (b.row ?? 0)).map(({ p, ...r }) => ({ clock: clock(r.t), ...r })),
    ...(truncated ? { truncated: 'casts_without_a_hero_target_dropped_first' } : {}),
    damage_to_heroes_by_unit: top(dealt),
    damage_taken_by_hero: top(taken),
    gaps: gapsFor(trace, ['vision', 'ability_immunity']),
  };
}

/** Items that are bought to be used up, or are parts of nothing worth a line. */
const CONSUMABLE = /^item_(tango|clarity|flask|faerie_fire|branches|ward_|enchanted_mango|famango|great_famango|tpscroll|smoke_of_deceit|dust|blood_grenade|tome_of_knowledge|infused_raindrop|bottle|madstone|recipe_)/;

/** When a hero first held each item (in a usable slot), in order. Works for any hero of the match. */
export function itemTimeline(trace, args = {}) {
  const { h, err } = needHero(trace, args.hero);
  if (err) return err;
  const end = trace.t0 + trace.n - 1;
  const items = Object.entries(trace.items[h]).filter(([k, e]) => !CONSUMABLE.test(k) && e.held.length).map(([k, e]) => {
    const first = e.held[0][0]; const last = e.held.at(-1)[1];
    return { ref: `item:${trace.heroes[h].key}:${k.replace(/^item_/, '')}`, item: k.replace(/^item_/, ''), first_held: { t: first, clock: clock(first) }, held_at_end: last >= end - 2, ...(last >= end - 2 ? {} : { last_held: { t: last, clock: clock(last) } }) };
  }).sort((a, b) => a.first_held.t - b.first_held.t);
  return { hero: trace.heroes[h].key, items, note: 'first_held is when the item first sat in an inventory, TP or neutral slot; components appear until they are built into something else' };
}

/** Buildings that are objectives: towers, barracks, the Ancient. Not the filler buildings around a base. */
const OBJECTIVE = /_(tower\d|melee_rax|range_rax|fort)(_(top|mid|bot))?$/;
/** Buildings that share their name with another: each side's two towers beside its Ancient. */
const SHARED_NAME = /_tower4$/;
/** The game is read in stretches of this many seconds. */
const PHASE_SECONDS = 600;
/** A building taken this long after a fight (or during it) is counted as following from the fight. */
const FOLLOW_UP_SECONDS = 120;
/** "Near": the same distance death_context uses for allies and enemies around a hero. */
const NEAR = 2200;

/**
 * What a hero's team did with the game, stretch by stretch, and where the
 * hero was while it happened: buildings taken and lost, hero deaths, fights
 * and whether a building followed them, and for the hero the share of their
 * living time on each side of the map, alone or with allies, and their damage
 * to buildings.
 *
 * Told from the hero's own side whoever asks: `team` is the hero's team,
 * `opponents` the other. Numbers only — whether a stretch was "pushing" or
 * "farming" is the reader's judgment, and the trace has no creeps to settle
 * it: time in a lane is not time spent pushing it.
 */
export function tempoReport(trace, args = {}, ctx = {}) {
  const { h, err } = needHero(trace, args.hero);
  if (err) return err;
  const view = viewer(trace, ctx);
  const key = trace.heroes[h].key;
  const team = trace.heroes[h].team; const other = team === 2 ? 3 : 2;
  const own = team === 2 ? 'radiant' : 'dire';
  const end = Math.floor(gameEnd(trace));
  if (!(end > 0)) return fail('no_game_time');
  const adv = goldAdvantage(trace, ctx);
  const leadAt = (t) => { const v = adv ? adv[Math.floor(t / 60)] : null; return Number.isFinite(v) ? (team === 2 ? v : -v) : null; };
  const r2 = (n, d) => (d > 0 ? Math.round((n / d) * 100) / 100 : null);

  // A building its own side destroyed (a deny) is nobody's objective.
  const objectives = trace.buildings.filter((b) => OBJECTIVE.test(trace.names[b[1]]) && b[0] <= end + 1)
    .map((b) => ({ t: b[0], id: b[1], name: unit(trace.names[b[1]]), owner: buildingTeam(trace.names[b[1]]), by: b[2] }))
    .filter((b) => b.owner && b.by !== b.owner);
  // Damage heroes themselves dealt to the other side's buildings: [second, hero index, building name id, value].
  const hits = [];
  for (const [sec, a, target, , value] of trace.damage) {
    const name = trace.names[target];
    if (!name || !OBJECTIVE.test(name)) continue;
    const ah = heroOfName(trace, a);
    // Up to the second the Ancient fell, like the buildings themselves: the whole game's sums and the stretches' are over the same rows.
    if (ah >= 0 && trace.heroes[ah].team !== buildingTeam(name) && sec <= end + 1) hits.push([sec, ah, target, value]);
  }
  // Two buildings with one name (the towers beside the Ancient) cannot be told apart in the damage log: who
  // damaged which is then unknown (null), not "nobody" — also when only one of the two fell, or the other
  // was denied: the damage to the one still standing is logged under the same name.
  const twins = new Set(objectives.filter((b, i) => SHARED_NAME.test(b.name) || objectives.some((o, j) => j !== i && o.id === b.id)).map((b) => b.id));
  const damagedBy = (b) => (twins.has(b.id) ? null : [...new Set(hits.filter((x) => x[2] === b.id && x[0] <= b.t).map((x) => x[1]))]);
  const buildingRow = (b) => {
    const mine = b.owner !== team;
    const by = damagedBy(b);
    return {
      building: b.name, t: b.t, clock: clock(b.t), taken_by: mine ? 'team' : 'opponents',
      ...(mine && by ? { heroes_who_damaged_it: by.filter((i) => trace.heroes[i].team === team).map((i) => trace.heroes[i].key) } : {}),
      ...(mine ? { hero_damaged_it: by ? by.includes(h) : null } : {}),
    };
  };

  const all = fights(trace).map((f, fi) => {
    const lost = { 2: 0, 3: 0 };
    let died = false; let near = false; let compared = 0; let missing = 0;
    for (const d of f.deaths) {
      const v = heroOfName(trace, d[1]);
      if (v < 0) { missing += 1; continue; }
      lost[trace.heroes[v].team] += 1;
      if (v === h) { died = true; continue; }
      const at = stateAt(trace, v, d[0]); const me = stateAt(trace, h, d[0]);
      if (!at || !me) { missing += 1; continue; }
      compared += 1;
      if (me.alive && dist(at, me) <= NEAR) near = true;
    }
    const fewer = lost[team] === lost[other] ? 'even' : lost[team] < lost[other] ? 'team' : 'opponents';
    const followed = (side) => objectives.some((b) => b.owner !== side && b.t >= f.from && b.t <= f.to + FOLLOW_UP_SECONDS);
    return {
      ref: `fight:${fi + 1}`, from: f.from, to: f.to, clock: clock(f.from), fewer,
      team_deaths: lost[team], opponents_deaths: lost[other],
      // "Not there" needs every death of the fight compared: with a position missing at any of them the hero
      // may have been at that one. Null then: unknown, not absent.
      there: died || near ? true : compared > 0 && missing === 0 ? false : null,
      team_took_a_building: followed(team), opponents_took_a_building: followed(other),
    };
  });

  const phases = [];
  for (let from = 0, n = 1; from < end; from += PHASE_SECONDS, n += 1) {
    const to = Math.min(from + PHASE_SECONDS, end);
    // What happened before the horn belongs to the first stretch; the Ancient's fall to the last.
    const inPhase = (t) => (t >= from || from === 0) && (t < to || (to === end && t <= end + 1));
    let alive = 0; let dead = 0; const sides = { own: 0, river: 0, enemy: 0 }; const places = new Map();
    // Who was near is known for a second only when every hero of that side has a position then: one without a
    // sample may have been standing next to the hero. Counted apart, so a missing sample is not "nobody near".
    const company = [0, 0, 0]; let companyKnown = 0; let crowded = 0; let crowdKnown = 0;
    // Seconds of the stretch with no sample of the hero (none within two seconds either): where they were then,
    // and whether they were alive, is not known.
    let unsampled = 0;
    for (let sec = from; sec < to; sec += 1) {
      const me = stateAt(trace, h, sec);
      if (!me) { unsampled += 1; continue; }
      if (!me.alive) { dead += 1; continue; }
      alive += 1;
      const place = region(me.x, me.y);
      places.set(place, (places.get(place) ?? 0) + 1);
      const side = place.split('_')[0];
      sides[side === 'river' ? 'river' : side === own ? 'own' : 'enemy'] += 1;
      const near = { [team]: 0, [other]: 0 }; const unseen = { [team]: false, [other]: false };
      trace.heroes.forEach((o, j) => {
        if (j === h) return;
        const at = stateAt(trace, j, sec);
        if (!at) { unseen[o.team] = true; return; }
        if (at.alive && dist(me, at) <= NEAR) near[o.team] += 1;
      });
      if (!unseen[team]) { companyKnown += 1; company[Math.min(2, near[team])] += 1; }
      if (!unseen[other]) { crowdKnown += 1; if (near[other] >= 3) crowded += 1; }
    }
    // A share of the living time needs the whole of it: with seconds where it cannot be told — the hero's own
    // (they may have been alive and elsewhere), or for who was near, another hero's — none is stated.
    const whole = (n, known = alive) => (unsampled === 0 && known === alive ? r2(n, alive) : null);
    const taken = objectives.filter((b) => inPhase(b.t)).map(buildingRow);
    const real = realDeaths(trace);
    const lost = { [team]: 0, [other]: 0 };
    for (const d of real) { const v = heroOfName(trace, d[1]); if (v >= 0 && inPhase(d[0])) lost[trace.heroes[v].team] += 1; }
    const fought = all.filter((f) => inPhase(f.from));
    const dmg = { hero: 0, team: 0 };
    // By the same rule as buildings and deaths: the second the Ancient falls belongs to the last stretch.
    for (const [sec, ah, , value] of hits) { if (!inPhase(sec) || trace.heroes[ah].team !== team) continue; dmg.team += value; if (ah === h) dmg.hero += value; }
    phases.push({
      ref: `phase:${key}:${n}`, from, to, clock: `${clock(from)}–${clock(to)}`,
      buildings_team_took: taken.filter((b) => b.taken_by === 'team').length,
      buildings_opponents_took: taken.filter((b) => b.taken_by === 'opponents').length,
      buildings: taken,
      team_hero_deaths: lost[team], opponents_hero_deaths: lost[other],
      hero_deaths: real.filter((d) => heroOfName(trace, d[1]) === h && inPhase(d[0])).length,
      // Not records of their own: whether this hero was there is part of this stretch (cite the stretch's ref).
      // `overview_fight` names the same fight in match_overview, which holds its deaths and gold.
      fights: fought.map((f) => ({ overview_fight: f.ref, clock: f.clock, team_deaths: f.team_deaths, opponents_deaths: f.opponents_deaths, lost_fewer_heroes: f.fewer, hero_was_there: f.there })),
      ...(adv ? { team_gold_lead: { at_start: leadAt(from), at_end: leadAt(to) } } : {}),
      hero_alive_seconds: alive, hero_dead_seconds: dead, hero_seconds_not_sampled: unsampled,
      hero_share_of_alive_time: {
        on_own_side_of_the_map: whole(sides.own), around_the_river: whole(sides.river), on_the_opponents_side: whole(sides.enemy),
        with_no_ally_within_2200: whole(company[0], companyKnown), with_one_ally_within_2200: whole(company[1], companyKnown), with_two_or_more_allies_within_2200: whole(company[2], companyKnown),
        with_three_or_more_opponents_within_2200: whole(crowded, crowdKnown),
      },
      // Null (not an empty list) when the stretch was not sampled throughout: the place they spent most time in may be one never seen.
      hero_most_time_in: unsampled === 0 ? [...places].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([place, sec]) => ({ place, share_of_alive_time: r2(sec, alive) })) : null,
      hero_damage_to_buildings: dmg.hero, team_heroes_damage_to_buildings: dmg.team,
    });
  }

  const label = (list, f) => Object.fromEntries(list.map((p) => [p.clock, f(p)]));
  const mine = objectives.filter((b) => b.owner !== team); const theirs = objectives.filter((b) => b.owner === team);
  const clocks = (list) => list.map((f) => f.clock);
  const wonF = all.filter((f) => f.fewer === 'team'); const lostF = all.filter((f) => f.fewer === 'opponents');
  const byHero = {};
  for (const [, ah, , value] of hits) if (trace.heroes[ah].team === team) byHero[trace.heroes[ah].key] = (byHero[trace.heroes[ah].key] ?? 0) + value;
  return {
    ref: `tempo:${key}`, ref_scope: 'summary', hero: key, ...sideOf(view, trace, h),
    told_from: { hero: key, note: 'team is this hero\'s team, opponents the other; "hero" is this hero' },
    duration: { t: end, clock: clock(end) },
    phases_total: phases.length,
    buildings_total: { team_took: mine.length, opponents_took: theirs.length },
    first_building_taken: { by_team: mine[0] ? clock(mine[0].t) : null, by_opponents: theirs[0] ? clock(theirs[0].t) : null },
    // One map per count, keyed by the stretch of the game: the tool's own counts, which a sentence may quote.
    buildings_team_took_by_phase: label(phases, (p) => p.buildings_team_took),
    buildings_opponents_took_by_phase: label(phases, (p) => p.buildings_opponents_took),
    team_hero_deaths_by_phase: label(phases, (p) => p.team_hero_deaths),
    opponents_hero_deaths_by_phase: label(phases, (p) => p.opponents_hero_deaths),
    fights_total: all.length,
    // Fights by the game time they began, like death_context's deaths_where: a fight can be in several lists.
    fights_where: {
      team_lost_fewer_heroes: clocks(wonF),
      team_lost_fewer_heroes_and_took_a_building_within_120s: clocks(wonF.filter((f) => f.team_took_a_building)),
      opponents_lost_fewer_heroes: clocks(lostF),
      opponents_lost_fewer_heroes_and_took_a_building_within_120s: clocks(lostF.filter((f) => f.opponents_took_a_building)),
      hero_was_there: clocks(all.filter((f) => f.there === true)),
      hero_was_not_there: clocks(all.filter((f) => f.there === false)),
      // A position was not sampled at one of the fight's deaths, and nothing else places the hero there: in neither list above.
      hero_presence_not_known: clocks(all.filter((f) => f.there === null)),
    },
    fights_where_rule: 'a fight is three or more hero deaths within 15 seconds of each other; "there" means the hero died in it or was alive within 2200 units of a hero who died, at that moment; a building counts when it fell during the fight or within 120 seconds after it',
    buildings_team_took_where: {
      hero_damaged_it: mine.filter((b) => damagedBy(b)?.includes(h)).map((b) => clock(b.t)),
      hero_did_not_damage_it: mine.filter((b) => damagedBy(b)?.includes(h) === false).map((b) => clock(b.t)),
      // Two buildings share the name (the towers beside the Ancient): the log cannot say which one a hero hit.
      not_known: mine.filter((b) => damagedBy(b) == null).map((b) => clock(b.t)),
    },
    team_heroes_damage_to_buildings: byHero,
    phases,
    note: 'Buildings are towers, barracks and the Ancient. Shares are of the seconds the hero was alive in that stretch; a share is null when it could not be told for all of them (hero_seconds_not_sampled counts the seconds with no sample of the hero). What happened before 0:00 is counted in the first stretch. Where a hero stood says nothing about creep waves: time in a lane is not time spent pushing it.',
    gaps: [
      ...gapsFor(trace, ['creeps', 'roshan', 'vision']),
      { topic: 'building_damage_by_summoned_units_and_illusions', reason: 'only_damage_dealt_by_heroes_themselves_is_counted' },
      ...(adv ? [] : [{ topic: 'gold_advantage', reason: 'not_in_trace' }]),
    ],
  };
}

const HERO = { type: 'string', description: 'Hero as in match_overview.heroes[].hero, e.g. "beastmaster".' };
const TIME = { type: ['number', 'string'], description: 'Game time: seconds, or "mm:ss".' };

/** @type {{ name: string, description: string, input_schema: object, run: (trace: any, args?: any, ctx?: any) => any }[]} */
export const TRACE_TOOLS = [
  {
    name: 'match_overview',
    description: 'The whole game at a glance, from the replay: both line-ups with deaths and final level, every fight (three or more hero deaths close together) with who lost fewer heroes, and when each building fell. For a lost game, told from one hero: the fight it turned on, and whether it was lost from the lanes. Start here to find the fights and moments worth a closer look.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: matchOverview,
  },
  {
    name: 'death_context',
    description: "What led to a hero's real deaths: for the seconds before each one, where they were, which allies and enemies were within 2200 units, health and mana, which of their abilities and items were ready, who dealt the damage, the disables that landed, what they cast, and who else died around it. Without `index`, every real death. In-place revivals (Wraith King's Reincarnation, Aegis of the Immortal) are not counted as deaths; when the hero had any, they are listed apart under `resurrections` (`resurrection:<hero>:<n>`, with `died_for_real_within_20s` when the hero died again right after reviving), and for Wraith King each real death gives `reincarnation_at_death` (`not_learned`, `on_cooldown`, `insufficient_mana`). An ability off cooldown that the hero never had the mana for in the window is listed apart (`off_cooldown_without_the_mana`), not as ready. `deaths_where` lists, by game time, the deaths that have something in common (began below half health, no ally near, three or more enemies) and `damage_share_in_death_windows` says where the damage came from — use them for what to change, and for which item answers the damage. `most_left_unused` lists all the hero's deaths in a fixed order of how much they still had (rule in `most_left_unused_rule`): the first is the answer to \"which death was the most avoidable\".",
    input_schema: { type: 'object', properties: { hero: HERO, index: { type: 'integer', minimum: 1, description: 'Which death, counting from 1. Omit for all.' }, window: { type: 'number', minimum: 4, maximum: 30, description: 'Seconds before the death to look at (default 12).' } }, required: ['hero'], additionalProperties: false },
    run: deathContext,
  },
  {
    name: 'ability_audit',
    description: "Every cast of one ability by one hero: the target and its health, whether the target was spell immune at that moment, who was near, which enemy heroes it damaged in the 15 seconds after, or until its next cast (`enemy_heroes_damaged_within_15s`, for an ability that deals damage), and which heroes died in the next 12 seconds. Also how long the ability sat ready while the hero was alive, and the hero's real deaths with it ready and not cast (for passive death-triggered abilities such as `skeleton_king_reincarnation`, `triggered_on_death` lists when it triggered instead).",
    input_schema: { type: 'object', properties: { hero: HERO, ability: { type: 'string', description: 'Ability key, with or without the hero prefix, e.g. "primal_roar".' } }, required: ['hero', 'ability'], additionalProperties: false },
    run: abilityAudit,
  },
  {
    name: 'immunity_windows',
    description: "When heroes were spell immune from an item (Black King Bar): start, end, length. With watch_hero + watch_ability, each window also says what that ability was doing when the window opened — ready, on cooldown (and the cast that put it there), its owner dead — and whether it was cast on the immune hero during the window.",
    input_schema: { type: 'object', properties: { hero: { ...HERO, description: 'Only this hero\'s windows.' }, team: { type: 'string', enum: ['radiant', 'dire'] }, watch_hero: HERO, watch_ability: { type: 'string' } }, additionalProperties: false },
    run: immunityWindows,
  },
  {
    name: 'fight_timeline',
    description: 'A stretch of the game second by second (at most 180 s): where all ten heroes stood at the start and at the first death, then every cast, key item use, spell-immunity activation, death, in-place revival (`reincarnation`, `aegis`) and building kill in order, how many heroes each side lost in it (`hero_deaths_in_window`, real deaths only), and who dealt and took the damage.',
    input_schema: { type: 'object', properties: { from: TIME, to: TIME }, required: ['from', 'to'], additionalProperties: false },
    run: fightTimeline,
  },
  {
    name: 'item_timeline',
    description: "When a hero first held each item, in order, and whether they still had it at the end. Works for any hero of the match: use it for the player's build and for when an enemy finished a key item.",
    input_schema: { type: 'object', properties: { hero: HERO }, required: ['hero'], additionalProperties: false },
    run: itemTimeline,
  },
  {
    name: 'tempo_report',
    description: "What a hero's team did with the game, in stretches of ten minutes, and where the hero was meanwhile: buildings each side took, hero deaths, each fight with who lost fewer heroes, whether a building followed it within 120 seconds and whether the hero was there; and for the hero the share of their living time on each side of the map, alone or with allies near, and their damage to buildings next to their teammates'. `team` is that hero's team, `opponents` the other. Use it for how the game was played as a whole — who was taking the map and when, whether won fights turned into buildings, whether the hero was where their team was — not for one moment.",
    input_schema: { type: 'object', properties: { hero: HERO }, required: ['hero'], additionalProperties: false },
    run: tempoReport,
  },
];

/** Run a tool by name. Unknown names and thrown errors come back as `{ error }`, never an exception. */
export function runTraceTool(trace, name, args = {}, ctx = {}) {
  const tool = TRACE_TOOLS.find((t) => t.name === name);
  if (!tool) return fail('unknown_tool', { tools: TRACE_TOOLS.map((t) => t.name) });
  if (trace?.schema !== 'dota2.ai/match-trace@1') return fail('invalid_trace');
  try { return { tool: name, ...tool.run(trace, args ?? {}, ctx) }; } catch { return fail('tool_failed', { tool: name }); }
}
