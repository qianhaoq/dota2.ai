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
import {
  abilityLevel, clock, cooldownLeft, dist, heldAt, heroIndex, heroOfName, immunityIntervals, manaCost, mostMana, nameId, nameOf, nearby, region, seconds, stateAt, unit,
} from './query.js';

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
 * used"). A cooldown alone proves nothing: passives have them too (Counter
 * Helix). A never-cast ability that costs nothing cannot be told from a
 * passive in the replay: a stated gap, not a guess.
 */
function castable(trace, h, npc) {
  const set = new Set();
  for (const c of trace.casts) if (c[1] === npc) set.add(trace.names[c[2]]);
  for (const [k, e] of Object.entries(trace.abilities[h])) if (e.mana > 0) set.add(k);
  return set;
}

/** Hero deaths grouped into fights: [{ from, to, deaths: [[t, victimName, killerName, row]] }]. */
function fights(trace) {
  const out = [];
  for (const d of [...trace.deaths].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && d[0] - last.to <= FIGHT_GAP) { last.to = d[0]; last.deaths.push(d); } else out.push({ from: d[0], to: d[0], deaths: [d] });
  }
  return out.filter((f) => f.deaths.length >= FIGHT_MIN_DEATHS);
}

function deathRow(trace, d, t0 = null, view = null) {
  const v = heroOfName(trace, d[1]);
  return { t: d[0], clock: clock(d[0]), ...(t0 == null ? {} : { dt: Math.round((d[0] - t0) * 10) / 10 }), hero: nameOf(trace, d[1]), ...(view ? sideOf(view, trace, v) : { team: v >= 0 ? TEAM[trace.heroes[v].team] : null }), killer: nameOf(trace, d[2]), row: d[3] };
}

export function matchOverview(trace, _args = {}, ctx = {}) {
  // Deaths only: the log names the unit that landed the last hit (a summon,
  // a creep), which is not the scoreboard's kill credit.
  const died = trace.heroes.map(() => 0);
  for (const d of trace.deaths) { const v = heroOfName(trace, d[1]); if (v >= 0) died[v] += 1; }
  const view = viewer(trace, ctx);
  const adv = Array.isArray(ctx.match?.radiant_gold_adv) ? ctx.match.radiant_gold_adv : null;
  const advAt = (t) => (adv && Number.isFinite(adv[Math.floor(t / 60)]) ? adv[Math.floor(t / 60)] : null);
  const mine = (radiantAdv) => (radiantAdv == null ? null : view.team === 2 ? radiantAdv : -radiantAdv);
  const end = trace.buildings.find((b) => /_fort$/.test(trace.names[b[1]]));
  const tally = { my_team_lost_fewer: 0, enemy_lost_fewer: 0, even: 0 };
  const fightRows = fights(trace).map((f, fi) => {
    const lost = { 2: 0, 3: 0 };
    for (const d of f.deaths) { const v = heroOfName(trace, d[1]); if (v >= 0) lost[trace.heroes[v].team] += 1; }
    const base = { ref: `fight:${fi + 1}`, from: f.from, to: f.to, clock: `${clock(f.from)}–${clock(f.to)}` };
    if (!view) {
      return {
        ...base, deaths: { radiant: lost[2], dire: lost[3] },
        fewer_deaths: lost[2] === lost[3] ? 'even' : lost[2] < lost[3] ? 'radiant' : 'dire',
        victims: f.deaths.map((d) => nameOf(trace, d[1])),
        ...(adv ? { radiant_gold_adv_before: advAt(f.from), radiant_gold_adv_2min_after: advAt(f.to + 120) } : {}),
      };
    }
    const my = lost[view.team]; const their = lost[view.team === 2 ? 3 : 2];
    const fewer = my === their ? 'even' : my < their ? 'my_team' : 'enemy';
    tally[fewer === 'even' ? 'even' : fewer === 'my_team' ? 'my_team_lost_fewer' : 'enemy_lost_fewer'] += 1;
    return {
      ...base, my_team_deaths: my, enemy_deaths: their, lost_fewer_heroes: fewer,
      victims: f.deaths.map((d) => ({ hero: nameOf(trace, d[1]), ...sideOf(view, trace, heroOfName(trace, d[1])) })),
      ...(adv ? { my_team_gold_lead_before: mine(advAt(f.from)), my_team_gold_lead_2min_after: mine(advAt(f.to + 120)) } : {}),
    };
  });
  return {
    ref: 'overview', ref_scope: 'summary',
    match_id: trace.match_id,
    duration: end ? { t: end[0], clock: clock(end[0]) } : null,
    ...(view ? { told_from: { hero: view.key, note: 'my_team is this hero\'s team; a negative gold lead means my_team was behind' }, result: end ? (end[2] === view.team ? 'my_team_won' : 'my_team_lost') : null } : { winner: end ? TEAM[end[2]] ?? null : null }),
    heroes: trace.heroes.map((h, i) => ({ hero: h.key, ...(view ? sideOf(view, trace, i) : { team: TEAM[h.team] }), deaths: died[i], final_level: stateAt(trace, i, trace.t0 + trace.n - 1)?.level ?? null })),
    ...(view ? { fights_total: fightRows.length, fights_tally: tally } : {}),
    fights: fightRows,
    buildings: trace.buildings.map((b) => ({
      ref: `building:${unit(trace.names[b[1]])}`, t: b[0], clock: clock(b[0]), building: unit(trace.names[b[1]]),
      ...(view ? { lost_by: buildingTeam(trace.names[b[1]]) === view.team ? 'my_team' : 'enemy' } : { taken_by: TEAM[b[2]] ?? null }),
      row: b[3],
    })),
    gaps: [...gapsFor(trace, ['roshan', 'vision']), ...(adv ? [] : [{ topic: 'gold_advantage', reason: 'not_in_trace' }])],
  };
}

export function deathContext(trace, args = {}, ctx = {}) {
  const view = viewer(trace, ctx);
  const { h, npc, err } = needHero(trace, args.hero);
  if (err) return err;
  // Whole seconds: the window is part of the records' refs, and a ref has to resolve to the same window.
  const window = Math.round(Math.min(30, Math.max(4, Number(args.window) || 12)));
  const all = trace.deaths.filter((d) => d[1] === npc).sort((a, b) => a[0] - b[0]);
  if (args.index != null && !all[args.index - 1]) return fail('no_such_death', { deaths: all.length });
  // Every death is worked out, also when one is asked for: the order below is over all of them.
  const pick = all.map((d, i) => [d, i + 1]);
  const can = castable(trace, h, npc);
  const out = pick.map(([d, n]) => {
    const t = d[0]; const from = t - window;
    const snapshots = [...new Set([window, 8, 4, 1].filter((x) => x <= window))].map((back) => {
      const { me, allies, enemies } = nearby(trace, h, t - back, 2200);
      return { dt: -back, me: me ? { hp: me.hp, max_hp: me.max_hp, mana: me.mana, ...where(me) } : null, allies, enemies };
    });
    const atDeath = nearby(trace, h, t, 2200);
    // Every second of the window and the death itself, not only the snapshots: an ally who came and went between two of them was there.
    let mostAllies = atDeath.me ? atDeath.allies.length : null;
    for (let sec = Math.ceil(from); mostAllies != null && sec < t; sec += 1) { const at = nearby(trace, h, sec, 2200); mostAllies = at.me ? Math.max(mostAllies, at.allies.length) : null; }
    const abilities = Object.entries(trace.abilities[h]).filter(([k, e]) => can.has(k) && abilityLevel(e, from) > 0)
      .map(([k, e]) => ({ ability: k, level: abilityLevel(e, from), cooldown_left: cooldownLeft(e, from), mana_cost: manaCost(e, from) }));
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
      // From the health itself, not the rounded share: 495 of 1000 is below half.
      below_half_health_at_window_start: snapshots[0]?.me?.max_hp ? snapshots[0].me.hp * 2 < snapshots[0].me.max_hp : null,
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
      other_deaths: trace.deaths.filter((o) => o !== d && Math.abs(o[0] - t) <= 20).map((o) => deathRow(trace, o, t, view)),
      damage_sources: sources,
    };
  });
  const killers = {};
  for (const d of all) { const k = nameOf(trace, d[2]) ?? 'unknown'; killers[k] = (killers[k] ?? 0) + 1; }
  // The counts below are over this window: a non-default one is in the summary's ref, as in each death's.
  return { ref: `deaths:${trace.heroes[h].key}${window === 12 ? '' : `:w${window}`}`, ref_scope: 'summary', hero: trace.heroes[h].key, team: TEAM[trace.heroes[h].team], window, deaths_total: all.length, killed_by: killers, ...deathPatterns(trace, out), ...leftUnused(out, trace.heroes[h].key), deaths: args.index == null ? out : [out[args.index - 1]], gaps: gapsFor(trace, ['vision', 'creeps', 'unused_free_abilities']) };
}

const share = (me) => (me?.max_hp ? Math.round((me.hp / me.max_hp) * 100) / 100 : null);

/**
 * What the hero's deaths have in common, counted: each entry lists the deaths
 * (by number) it is true of, so a habit shows as a count over the game and
 * not as one more anecdote. And where the damage in those windows came
 * from — one enemy's attacks, or many heroes' abilities — which is what an
 * item answer has to match. Facts only: unknown health or position leaves a
 * death out of a list, it does not put it in.
 */
function deathPatterns(trace, deaths) {
  const of = (test) => deaths.filter(test).map((d) => d.n);
  const by = new Map(); let total = 0;
  for (const d of deaths) {
    // Over every damage row of each window, not the ten largest a record lists.
    for (const [key, value] of d.damage_sources) { by.set(key, (by.get(key) ?? 0) + value); total += value; }
    delete d.damage_sources;
  }
  const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 6);
  return {
    deaths_where: {
      health_below_half_at_window_start: of((d) => d.below_half_health_at_window_start === true),
      // In every second of the window and at the death itself.
      no_ally_within_2200_throughout: of((d) => d.allies_within_2200.most_in_any_second === 0),
      no_ally_within_2200_at_death: of((d) => d.allies_within_2200.at_death === 0),
      three_or_more_enemy_heroes_dealing_damage: of((d) => d.enemy_heroes_dealing_damage >= 3),
      nothing_cast_and_no_item_used: of((d) => d.my_casts.length === 0 && d.my_item_uses.length === 0),
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
      ready_not_cast: d.ready_not_cast.filter((a) => a.startsWith(`${heroKey}_`)),
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
    return {
      ref: `cast:${trace.heroes[h].key}:${short}:${ci + 1}`, t, clock: clock(t), row: c[4], target: targetName,
      target_hp: ts ? { hp: ts.hp, max_hp: ts.max_hp } : null,
      target_spell_immune: target >= 0 ? Boolean(during) : null,
      // What the replay shows this cast did (a stun the log attributes to the caster), whatever the ability is supposed to do.
      target_stunned_seconds: target >= 0 ? stunnedByCast(trace, target, npc, c[3], t, Math.min(t + STUN_LANDS_WITHIN, (rows[ci + 1]?.[0] ?? Infinity) - 0.2)) : null,
      ...(soonAfter ? { target_became_immune_dt: Math.round((soonAfter.from - t) * 10) / 10 } : {}),
      me: me ? { hp: me.hp, max_hp: me.max_hp, ...where(me) } : null,
      allies_within_1300: allies.map((a) => a.hero), enemies_within_1300: enemies.map((e) => e.hero),
      ...(damaging ? { enemy_heroes_damaged_within_15s: [...hit] } : {}),
      deaths_within_12s: trace.deaths.filter((d) => d[0] >= t && d[0] - t <= 12).map((d) => deathRow(trace, d, t, view)),
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
  const myDeaths = trace.deaths.filter((d) => d[1] === npc).sort((a, b) => a[0] - b[0]);
  // Off cooldown with less mana in those 12 seconds than it costs is not "ready and not cast".
  const afford = (d) => { const cost = manaCost(entry, d[0] - 12); const mana = mostMana(trace, h, d[0] - 12, d[0]); return cost == null || mana == null || mana >= cost; };
  const unused = myDeaths.filter((d) => abilityLevel(entry, d[0]) > 0 && cooldownLeft(entry, d[0] - 0.5) === 0 && !rows.some((c) => d[0] - c[0] >= 0 && d[0] - c[0] <= 12)).filter(afford);
  return {
    ref: `audit:${trace.heroes[h].key}:${short}`, ref_scope: 'summary',
    hero: trace.heroes[h].key, ability: key,
    learned_at: learned == null ? null : { t: learned, clock: clock(learned) },
    casts_total: casts.length, by_target: byTarget,
    casts_on_spell_immune_target: casts.filter((c) => c.target_spell_immune).length,
    of_those_target_was_stunned: casts.filter((c) => c.target_spell_immune && c.target_stunned_seconds > 0).length,
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
  for (const d of trace.deaths) if (inWindow(d[0])) rows.push({ p: 0, t: d[0], kind: 'death', hero: nameOf(trace, d[1]), ...sideOf(view, trace, heroOfName(trace, d[1])), killer: nameOf(trace, d[2]), row: d[3] });
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
  const firstDeath = trace.deaths.filter((d) => inWindow(d[0])).sort((a, b) => a[0] - b[0])[0];
  return {
    ref: `timeline:${Math.round(from)}-${Math.round(to)}`, from, to, clock: `${clock(from)}–${clock(to)}`,
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

const HERO = { type: 'string', description: 'Hero as in match_overview.heroes[].hero, e.g. "beastmaster".' };
const TIME = { type: ['number', 'string'], description: 'Game time: seconds, or "mm:ss".' };

/** @type {{ name: string, description: string, input_schema: object, run: (trace: any, args?: any, ctx?: any) => any }[]} */
export const TRACE_TOOLS = [
  {
    name: 'match_overview',
    description: 'The whole game at a glance, from the replay: both line-ups with deaths and final level, every fight (three or more hero deaths close together) with who lost fewer heroes, and when each building fell. Start here to find the fights and moments worth a closer look.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: matchOverview,
  },
  {
    name: 'death_context',
    description: "What led to a hero's deaths: for the seconds before each one, where they were, which allies and enemies were within 2200 units, health and mana, which of their abilities and items were ready, who dealt the damage, the disables that landed, what they cast, and who else died around it. Without `index`, every death. An ability off cooldown that the hero never had the mana for in the window is listed apart (`off_cooldown_without_the_mana`), not as ready. `deaths_where` counts what the deaths have in common (began below half health, no ally near, three or more enemies) and `damage_share_in_death_windows` says where the damage came from — use them for what to change, and for which item answers the damage. `most_left_unused` lists all the hero's deaths in a fixed order of how much they still had (rule in `most_left_unused_rule`): the first is the answer to \"which death was the most avoidable\".",
    input_schema: { type: 'object', properties: { hero: HERO, index: { type: 'integer', minimum: 1, description: 'Which death, counting from 1. Omit for all.' }, window: { type: 'number', minimum: 4, maximum: 30, description: 'Seconds before the death to look at (default 12).' } }, required: ['hero'], additionalProperties: false },
    run: deathContext,
  },
  {
    name: 'ability_audit',
    description: "Every cast of one ability by one hero: the target and its health, whether the target was spell immune at that moment, who was near, which enemy heroes it damaged in the 15 seconds after, or until its next cast (`enemy_heroes_damaged_within_15s`, for an ability that deals damage), and which heroes died in the next 12 seconds. Also how long the ability sat ready while the hero was alive, and the hero's deaths with it ready and not cast.",
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
    description: 'A stretch of the game second by second (at most 180 s): where all ten heroes stood at the start and at the first death, then every cast, key item use, spell-immunity activation, death and building kill in order, and who dealt and took the damage.',
    input_schema: { type: 'object', properties: { from: TIME, to: TIME }, required: ['from', 'to'], additionalProperties: false },
    run: fightTimeline,
  },
  {
    name: 'item_timeline',
    description: "When a hero first held each item, in order, and whether they still had it at the end. Works for any hero of the match: use it for the player's build and for when an enemy finished a key item.",
    input_schema: { type: 'object', properties: { hero: HERO }, required: ['hero'], additionalProperties: false },
    run: itemTimeline,
  },
];

/** Run a tool by name. Unknown names and thrown errors come back as `{ error }`, never an exception. */
export function runTraceTool(trace, name, args = {}, ctx = {}) {
  const tool = TRACE_TOOLS.find((t) => t.name === name);
  if (!tool) return fail('unknown_tool', { tools: TRACE_TOOLS.map((t) => t.name) });
  if (trace?.schema !== 'dota2.ai/match-trace@1') return fail('invalid_trace');
  try { return { tool: name, ...tool.run(trace, args ?? {}, ctx) }; } catch { return fail('tool_failed', { tool: name }); }
}
