/**
 * Match trace builder — pure, no IO, no clock.
 *
 * Turns the replay extractor's raw rows (`trace/states.jsonl`, 4 samples a
 * second per hero, and `trace/events.jsonl`, the full combat log; hundreds of
 * megabytes) into one compact `dota2.ai/match-trace@1` object the query tools
 * in ./tools.js read. Rows are fed one at a time, so the caller can stream
 * the files (scripts/build-trace.mjs).
 *
 * What is kept:
 * - hero state once a second (position, health, mana, level, alive);
 * - every ability/item cooldown as [from, to, seconds left at from] intervals
 *   (an interval can end before the cooldown would: the item left the
 *   inventory, the trace ended, the cooldown was reset — so the sampled value
 *   is kept, not inferred from `to`), ability levels as
 *   change points, held items and control states (stunned, silenced, …) as
 *   intervals — all from the 4 Hz samples, so times are within 0.25 s;
 * - the hero-relevant combat log: casts, item uses, hero deaths, purchases,
 *   building kills, control / spell-immunity modifiers, and damage to heroes
 *   and buildings summed per second by (attacker, target, inflictor);
 * - each hero's net worth once a game minute, from the replay's match metadata
 *   (`trace/metadata.jsonl`, `graph_net_worth`). The graph stores net worth
 *   divided by ten: it is multiplied back only when its first point is a
 *   starting purse (NET_WORTH_START), else left out. A point is read as one
 *   game minute only when the graph is not denser than that: some replays'
 *   graphs hold about two points a minute (9080127650: 63 for 31:47), and
 *   then nothing is kept and `gaps` says why. Net worth, not gold earned;
 *   which second of a minute a point was taken is not recorded;
 * - everything that is not a hero and that a hero (or its illusion) killed, by kind — lane creep, deny, neutral,
 *   enemy ward, enemy courier, anything else — with the hero's running last-hit count and net worth as the log
 *   gives them on that row (`creep_kills`). A kill made by a hero's summons is not a row of its own (the log
 *   keeps only rows with a hero in them), but it is in the running count: on 9100904020 the count on each
 *   hero's last row was the scoreboard's last hits for nine heroes and one short for the tenth;
 * - gold each hero received or lost, summed per game minute and per reason code of the log (`gold`): 13 lane
 *   creeps, 14 neutrals, 12 hero kills and assists, 11 buildings, 15 Roshan and the Tormentor, 17 bounty runes, 20 wards,
 *   16 and 21 couriers, 6 selling, 1 dying (a loss), 0 the starting purse and what the log does not name —
 *   read off 9100904020 and 9102822299, where each code was matched against the deaths in the same instant.
 *   A code not listed here is kept as it is (23 on 9102822299: 160 gold, 49 times). The income every hero
 *   gets over time has no rows, so these do not add up to net worth. Only when the extract has gold rows;
 * - Roshan: every kill a hero landed (`roshan_kills`) and the damage heroes dealt to Roshan per second
 *   (`roshan_damage`); and every Tormentor a hero killed (`tormentor_kills`). A kill whose last hit was not a
 *   hero's has no row in the log and is not seen. Its gold cannot stand in for it: reason 15 is paid for
 *   Roshan and for the Tormentor alike (9102345221: three of each, told apart only by their death rows).
 *
 * What the extractor does not have stays absent (see `gaps`): fog of war,
 * where the creeps stood. Nothing is estimated. (`gaps` still names creeps and Roshan as the tools tell them
 * to the model: the tools do not read the fields above yet.)
 */

export const TRACE_SCHEMA = 'dota2.ai/match-trace@1';

/** Item slots a hero can use from: inventory 0–5, TP 15, neutral 16–17. Backpack (6–8) is not held. */
const usableSlot = (slot) => (slot >= 0 && slot <= 5) || (slot >= 15 && slot <= 17);
/** Modifiers that make a hero spell immune. Items only: hero abilities are not covered (a stated gap). */
const IMMUNITY = /black_king_bar_immune|magic_immune|debuff_immune|spell_immun/;
const BUILDING = /_(tower\d|fort|melee_rax|range_rax)/;
const ROSHAN = 'npc_dota_roshan';
const LANE_CREEP = /^npc_dota_(?:creep_(?:goodguys|badguys)_|(?:goodguys|badguys)_siege)/;
const NEUTRAL_CREEP = /^npc_dota_neutral_/;
const TORMENTOR = 'npc_dota_miniboss';
const side = (team) => (team === 2 || team === 3 ? team : 0);
/**
 * What a hero killed, when it is one of the things the trace keeps: 'l' a lane creep of the other side, 'd' one
 * of its own side (a deny), 'u' a lane creep when the log does not give both teams, 'n' a neutral creep,
 * 'o' / 's' an observer / sentry ward of the other side, 'c' a courier of the other side, and 'x' anything
 * else that is not a hero (a summon, an illusion, a building, a ward or courier whose side is not known to be
 * the other one): kept for the running numbers on its row, not as a thing to count.
 */
function killKind(e) {
  const name = typeof e.target === 'string' ? e.target : '';
  const mine = side(e.attacker_team); const theirs = side(e.target_team);
  if (LANE_CREEP.test(name)) return !mine || !theirs ? 'u' : mine === theirs ? 'd' : 'l';
  if (NEUTRAL_CREEP.test(name)) return 'n';
  const other = mine && theirs && mine !== theirs;
  if (name === 'npc_dota_observer_wards') return other ? 'o' : 'x';
  if (name === 'npc_dota_sentry_wards') return other ? 's' : 'x';
  if (name === 'npc_dota_courier') return other ? 'c' : 'x';
  return 'x';
}
/** The log's visibility flag as written: 1, 0, or null when the row has none (not shown to mean "not seen"). */
const flag = (v) => (v === true ? 1 : v === false ? 0 : null);
const r1 = (n) => Math.round(n * 10) / 10;
/**
 * The metadata graph's unit is ten gold. Its first point (0:00) is the starting purse, 600 in recent patches:
 * a first point this far from 60 means the unit is not what this builder knows, and nothing is kept.
 */
const NET_WORTH_SCALE = 10;
const NET_WORTH_START = [40, 80];

/**
 * Open/close [from, to] intervals for a boolean that is sampled over time.
 * `value` (optional) is kept from the sample that opened the interval, as a
 * third element: for a cooldown, the seconds it had left at `from`.
 */
function track(list, state, on, t, value) {
  if (on && state.from == null) { state.from = t; state.value = value; } else if (!on && state.from != null) {
    list.push(state.value == null ? [r1(state.from), r1(t)] : [r1(state.from), r1(t), r1(state.value)]);
    state.from = null; state.value = undefined;
  }
}

/**
 * The combat log's name for each hero. The states name some heroes differently from the combat log
 * (`queen_of_pain` there, `npc_dota_hero_queenofpain` here; also anti_mage, vengeful_spirit), and a hero's
 * casts, deaths and damage are only found through its `npc`. A hero whose `npc` is not among the logged
 * names takes the one logged name that is the same once underscores go. Also for traces stored before this
 * (they are read through it), so the hero's events are found without a re-parse. Returns the same trace.
 * @param {any} trace
 */
export function linkHeroNames(trace) {
  if (!Array.isArray(trace?.heroes) || !Array.isArray(trace?.names)) return trace;
  const logged = new Set(trace.names);
  const PREFIX = 'npc_dota_hero_';
  for (const h of trace.heroes) {
    if (typeof h?.key !== 'string' || logged.has(h.npc)) continue;
    const want = h.key.replace(/_/g, '');
    const found = trace.names.filter((n) => typeof n === 'string' && n.startsWith(PREFIX) && n.slice(PREFIX.length).replace(/_/g, '') === want);
    if (found.length === 1) h.npc = found[0];
  }
  return trace;
}

export function createTraceBuilder() {
  /** @type {Map<string, any>} */
  const heroes = new Map();
  const names = []; const nameIndex = new Map();
  const id = (s) => {
    const key = typeof s === 'string' && s && s !== 'dota_unknown' ? s : null;
    if (key == null) return -1;
    let i = nameIndex.get(key);
    if (i == null) { i = names.length; names.push(key); nameIndex.set(key, i); }
    return i;
  };
  const casts = []; const itemUses = []; const deaths = []; const purchases = []; const buildings = []; const modifiers = [];
  /** Buybacks as the log has them: [t, player slot]. The slot is the states' player_index, matched to a hero at finish. */
  const buybackRows = [];
  /** @type {Map<string, { from: number | null, to: number | null, team: number, kind: string, x: number, y: number }>} by entity id */
  const wards = new Map();
  let wardRows = 0;
  /** @type {Map<string, number>} */
  const damage = new Map();
  const creepKills = []; const roshanDeaths = []; const tormentorDeaths = [];
  /** @type {Map<string, number>} `minute|receiver|reason` → gold */
  const gold = new Map();
  /** @type {Map<string, number>} `second|attacker` → damage to Roshan */
  const roshanDamage = new Map();
  let goldRows = 0;
  let stateRows = 0; let eventRows = 0; let lastT = -Infinity; let firstT = Infinity;
  /** @type {Map<string, number[]>} hero key without underscores → net worth per game minute */
  const netWorth = new Map();
  // The states name a hero `queen_of_pain`, the metadata `npc_dota_hero_queenofpain`: the same hero once the underscores go.
  const squash = (key) => key.replace(/_/g, '');
  /** @type {Map<string, number[]>} `team:player id` → graph, for a metadata player with no hero name (seen in 9016476539) */
  const netWorthBySlot = new Map();

  function hero(key, row) {
    let h = heroes.get(key);
    if (!h) {
      h = { key, team: row.team, player_index: row.player_index ?? null, samples: new Map(), peaks: new Map(), abilities: new Map(), items: new Map(), controls: new Map() };
      heroes.set(key, h);
    }
    return h;
  }

  function cooldown(entry, cd, t) {
    const cooling = cd > 0;
    // While a cooldown runs, the next sample should be the last one minus the time between them. One that
    // is clearly higher is a new cast (refresh, charges); one clearly lower was cut by an effect. Either
    // way the countdown starts over from this sample, so the interval is closed and a new one opened.
    if (cooling && entry.cdState.from != null) {
      const expected = entry.lastCd - (t - (entry.lastT ?? t));
      if (cd > entry.lastCd + 1 || cd < expected - 1) track(entry.cd, entry.cdState, false, t);
    }
    track(entry.cd, entry.cdState, cooling, t, cd);
    entry.lastCd = cd; entry.lastT = t;
  }

  return {
    /** One row of states.jsonl. Rows without a game time or that are not a real hero are ignored. */
    addState(row) {
      stateRows += 1;
      if (!row || row.entity_kind !== 'real_hero' || !Number.isFinite(row.t) || typeof row.hero !== 'string') return;
      const t = row.t;
      const h = hero(row.hero, row);
      if (t > lastT) lastT = t;
      if (t < firstT) firstT = t;
      const sec = Math.round(t);
      // The most mana seen in this second over every sample, not only the one kept: a peak between kept samples is mana the hero had.
      if (Number.isFinite(row.mana) && !(h.peaks.get(sec) >= row.mana)) h.peaks.set(sec, row.mana);
      const prev = h.samples.get(sec);
      const off = Math.abs(t - sec);
      if (!prev || off < prev.off) {
        h.samples.set(sec, { off, x: Math.round(row.x), y: Math.round(row.y), hp: row.hp, max_hp: row.max_hp, mana: Math.round(row.mana), level: row.level, alive: row.life_state === 0 ? 1 : 0 });
      }
      for (const a of row.abilities ?? []) {
        if (typeof a?.name !== 'string' || a.name.startsWith('special_bonus')) continue;
        let e = h.abilities.get(a.name);
        if (!e) { e = { levels: [], cd: [], cdState: { from: null }, lastCd: 0, level: 0, mana: 0, cost: null, costs: [] }; h.abilities.set(a.name, e); }
        if (a.mana_cost > e.mana) e.mana = a.mana_cost;
        // What it cost and from when, each time the sampled cost changed (a level, a talent, a facet): "ready" is not "could be cast" without the mana.
        if (a.level > 0 && Number.isFinite(a.mana_cost) && a.mana_cost !== e.cost) { e.cost = a.mana_cost; e.costs.push([r1(t), Math.round(a.mana_cost)]); }
        if (a.level !== e.level) { e.level = a.level; e.levels.push([r1(t), a.level]); }
        cooldown(e, Number(a.cooldown) || 0, t);
      }
      // An ability gone from the samples (a stolen spell lost, a form ended) is no longer available:
      // close it at level 0 rather than leave its last level standing.
      const present = new Set((row.abilities ?? []).map((a) => a?.name));
      for (const [name, e] of h.abilities) {
        if (present.has(name) || e.level === 0) continue;
        e.level = 0; e.levels.push([r1(t), 0]);
        track(e.cd, e.cdState, false, t);
      }
      const seen = new Set();
      for (const i of row.items ?? []) {
        if (typeof i?.name !== 'string' || !usableSlot(i.slot)) continue;
        seen.add(i.name);
        let e = h.items.get(i.name);
        if (!e) { e = { held: [], heldState: { from: null }, cd: [], cdState: { from: null }, lastCd: 0 }; h.items.set(i.name, e); }
        track(e.held, e.heldState, true, t);
        cooldown(e, Number(i.cooldown) || 0, t);
      }
      for (const [name, e] of h.items) {
        if (seen.has(name)) continue;
        track(e.held, e.heldState, false, t);
        track(e.cd, e.cdState, false, t);
      }
      for (const [flag, on] of Object.entries(row.controls ?? {})) {
        let e = h.controls.get(flag);
        if (!e) { if (!on) continue; e = { list: [], state: { from: null } }; h.controls.set(flag, e); }
        track(e.list, e.state, on === true, t);
      }
    },

    /** One row of events.jsonl; `row` is its line index (the evidence reference). */
    addEvent(e, row = eventRows) {
      eventRows += 1;
      if (!e || !Number.isFinite(e.t) || typeof e.type !== 'string') return;
      const t = r1(e.t);
      const realHero = (isHero, isIllusion) => isHero === true && isIllusion !== true;
      switch (e.type) {
        case 'DOTA_COMBATLOG_ABILITY':
          // A cast at an illusion keeps that: its target is not the real hero (no health, no immunity of theirs).
          if (realHero(e.attacker_hero, e.attacker_illusion)) {
            const target = e.target_illusion === true && typeof e.target === 'string' ? `illusion:${e.target}` : e.target;
            casts.push([t, id(e.attacker), id(e.inflictor), id(target), row]);
          }
          break;
        case 'DOTA_COMBATLOG_ITEM':
          if (realHero(e.attacker_hero, e.attacker_illusion)) itemUses.push([t, id(e.attacker), id(e.inflictor), row]);
          break;
        case 'DOTA_COMBATLOG_DEATH':
          if (realHero(e.target_hero, e.target_illusion)) deaths.push([t, id(e.target), id(e.attacker), row]);
          else if (e.target_hero !== true && e.attacker_hero === true && typeof e.attacker === 'string') {
            // A kill by a hero or by its illusion: the gold and the last hit are the hero's either way.
            if (e.target === ROSHAN) roshanDeaths.push([t, id(e.attacker), side(e.attacker_team), row, flag(e.visible_radiant), flag(e.visible_dire)]);
            else if (e.target === TORMENTOR) tormentorDeaths.push([t, id(e.attacker), side(e.attacker_team), row]);
            else creepKills.push([t, id(e.attacker), killKind(e), Number.isInteger(e.last_hits) && e.last_hits >= 0 ? e.last_hits : null, Number.isFinite(e.networth) && e.networth >= 0 ? Math.round(e.networth) : null]);
          }
          break;
        case 'DOTA_COMBATLOG_GOLD': {
          if (typeof e.target !== 'string' || !e.target.startsWith('npc_dota_hero_') || !Number.isInteger(e.gold_reason) || !Number.isFinite(e.value)) break;
          goldRows += 1;
          // A loss is written as an unsigned 32-bit number: dying for 19 gold is 4294967277.
          const value = e.value > 0x7fffffff ? e.value - 0x100000000 : e.value;
          const key = `${Math.floor(e.t / 60)}|${id(e.target)}|${e.gold_reason}`;
          gold.set(key, (gold.get(key) ?? 0) + value);
          break;
        }
        case 'DOTA_COMBATLOG_PURCHASE':
          purchases.push([t, id(e.target), id(e.value_name || e.inflictor), row]);
          break;
        case 'DOTA_COMBATLOG_BUYBACK':
          // The log names no unit: `value` is the player slot (checked on 9102822299: slot 8 Legion Commander was
          // alive again at 51:28, the second of the buyback; slot 1 Queen of Pain at 53:08).
          if (Number.isInteger(e.value) && e.value >= 0 && e.value <= 23) buybackRows.push([t, e.value]);
          break;
        case 'DOTA_COMBATLOG_TEAM_BUILDING_KILL':
          // The log names the team that took the building, not a unit.
          buildings.push([t, id(e.target), e.attacker_team === 2 || e.attacker_team === 3 ? e.attacker_team : 0, row]);
          break;
        case 'DOTA_COMBATLOG_MODIFIER_ADD':
        case 'DOTA_COMBATLOG_MODIFIER_REMOVE': {
          if (!realHero(e.target_hero, e.target_illusion) || typeof e.inflictor !== 'string') break;
          const add = e.type.endsWith('ADD');
          const immune = IMMUNITY.test(e.inflictor);
          const stun = Number(e.stun_duration) > 0 ? r1(Number(e.stun_duration)) : 0;
          const control = add && (stun > 0 || e.silence === true || e.root === true);
          if (!immune && !control) break;
          modifiers.push([t, id(e.target), id(e.inflictor), id(e.attacker), add ? 1 : 0, stun, immune ? 'i' : e.root === true ? 'r' : e.silence === true ? 's' : 't', row]);
          break;
        }
        case 'DOTA_COMBATLOG_DAMAGE': {
          const toHero = realHero(e.target_hero, e.target_illusion);
          if (e.target === ROSHAN) {
            // Who was hitting Roshan, second by second (a hero's illusions count as the hero).
            if (e.attacker_hero === true && typeof e.attacker === 'string' && e.value > 0) { const k = `${Math.floor(e.t)}|${id(e.attacker)}`; roshanDamage.set(k, (roshanDamage.get(k) ?? 0) + e.value); }
            break;
          }
          if (!toHero && !(typeof e.target === 'string' && BUILDING.test(e.target))) break;
          if (!(e.value > 0)) break;
          // An illusion's damage is its own line, not the real hero's.
          const attacker = e.attacker_illusion === true && typeof e.attacker === 'string' ? `illusion:${e.attacker}` : e.attacker;
          const key = `${Math.floor(e.t)}|${id(attacker)}|${id(e.target)}|${id(e.inflictor)}`;
          damage.set(key, (damage.get(key) ?? 0) + e.value);
          break;
        }
        default:
      }
    },

    /**
     * One row of the extractor's wards-native.jsonl: { entity_id, event: created | present | deleted, kind: observer |
     * sentry, team, t, x, y }. "present" is a ward already standing when the replay began (its placing is not seen).
     * A deletion is the ward's end: it expired or was destroyed, the file does not say which.
     */
    addWard(row) {
      wardRows += 1;
      if (!row || typeof row.entity_id !== 'string' || !Number.isFinite(row.t)) return;
      const t = r1(row.t);
      if (row.event === 'created' || row.event === 'present') {
        if (!(row.team === 2 || row.team === 3) || !(row.kind === 'observer' || row.kind === 'sentry') || !Number.isFinite(row.x) || !Number.isFinite(row.y)) return;
        wards.set(row.entity_id, { from: row.event === 'created' ? t : null, to: null, team: row.team, kind: row.kind, x: Math.round(row.x), y: Math.round(row.y) });
      } else if (row.event === 'deleted') {
        const w = wards.get(row.entity_id);
        if (w && w.to == null) w.to = t;
      }
    },

    /**
     * One row of metadata.jsonl (the replay's match metadata). A later row replaces an earlier one's graph:
     * the file can hold one row per metadata callback, and the last is the whole game.
     */
    addMetadata(row) {
      for (const p of Array.isArray(row?.players) ? row.players : []) {
        const key = typeof p?.hero_key === 'string' && p.hero_key ? p.hero_key.replace(/^npc_dota_hero_/, '') : null;
        // Without a hero name, the player's id and team: the same numbers as the states' player_index and team (checked on 9100904020).
        const slot = key == null && Number.isInteger(p?.game_player_id) && (p?.dota_team === 2 || p?.dota_team === 3) ? `${p.dota_team}:${p.game_player_id}` : null;
        const graph = Array.isArray(p?.graph_net_worth) ? p.graph_net_worth : null;
        if ((!key && !slot) || !graph?.length || !graph.every(Number.isFinite)) continue;
        if (!(graph[0] >= NET_WORTH_START[0] && graph[0] <= NET_WORTH_START[1])) continue;
        const gold = graph.map((v) => Math.round(v * NET_WORTH_SCALE));
        if (key) netWorth.set(squash(key), gold); else netWorthBySlot.set(slot, gold);
      }
    },

    /** @param {{ match_id?: number | null, extractor?: object | null }} [meta] */
    finish(meta = {}) {
      const list = [...heroes.values()].sort((a, b) => a.team - b.team || (a.player_index ?? 0) - (b.player_index ?? 0));
      const t0 = Number.isFinite(firstT) ? Math.round(firstT) : 0;
      const n = Number.isFinite(lastT) ? Math.round(lastT) - t0 + 1 : 0;
      const closeAll = (entries, t) => { for (const e of entries) { if (e.cdState) track(e.cd, e.cdState, false, t); if (e.heldState) track(e.held, e.heldState, false, t); if (e.state) track(e.list, e.state, false, t); } };
      const cols = ['x', 'y', 'hp', 'max_hp', 'mana', 'level', 'alive'];
      // One point a game minute at most (0:00 … the last full minute): a denser graph's points are not minutes.
      const minutes = Number.isFinite(lastT) && lastT > 0 ? Math.floor(lastT / 60) + 1 : 0;
      const graphs = [...netWorth.values(), ...netWorthBySlot.values()];
      const perMinute = graphs.length > 0 && graphs.every((g) => g.length <= minutes);
      const graphOf = (h) => netWorth.get(squash(h.key)) ?? (h.player_index == null ? null : netWorthBySlot.get(`${h.team}:${h.player_index}`)) ?? null;
      const out = {
        schema: TRACE_SCHEMA,
        match_id: meta.match_id ?? null,
        t0,
        n,
        heroes: list.map((h) => ({ key: h.key, npc: `npc_dota_hero_${h.key}`, team: h.team, player_index: h.player_index })),
        states: list.map((h) => {
          const s = Object.fromEntries(cols.map((c) => [c, new Array(n).fill(null)]));
          for (const [sec, v] of h.samples) { const i = sec - t0; if (i >= 0 && i < n) for (const c of cols) s[c][i] = v[c]; }
          s.mana_peak = new Array(n).fill(null);
          for (const [sec, v] of h.peaks) { const i = sec - t0; if (i >= 0 && i < n) s.mana_peak[i] = Math.round(v); }
          return s;
        }),
        abilities: list.map((h) => { closeAll(h.abilities.values(), lastT); return Object.fromEntries([...h.abilities].filter(([, e]) => e.levels.some(([, lv]) => lv > 0)).map(([k, e]) => [k, { levels: e.levels, cd: e.cd, ...(e.mana > 0 ? { mana: Math.round(e.mana) } : {}), ...(e.mana > 0 && e.costs.length ? { costs: e.costs } : {}) }])); }),
        items: list.map((h) => { closeAll(h.items.values(), lastT); return Object.fromEntries([...h.items].map(([k, e]) => [k, { held: e.held, cd: e.cd }])); }),
        controls: list.map((h) => { closeAll(h.controls.values(), lastT); return Object.fromEntries([...h.controls].filter(([, e]) => e.list.length).map(([k, e]) => [k, e.list])); }),
        names,
        casts,
        item_uses: itemUses,
        deaths,
        purchases,
        buildings,
        modifiers,
        damage: [...damage].map(([k, v]) => [...k.split('|').map(Number), Math.round(v)]),
        // [t, hero (index into names), kind, the hero's last hits after this kill, its net worth then]; the kinds are
        // killKind's. The last two are the log's own running numbers, null when the row has none. A trace without
        // this field was built before it was kept: it does not know.
        creep_kills: creepKills,
        // [game minute (negative before the horn), hero, the log's reason code, gold] — a loss is negative.
        ...(goldRows ? { gold: [...gold].map(([k, v]) => [...k.split('|').map(Number), Math.round(v)]) } : {}),
        // [t, killer, the side that took it (0: the row does not say), event row, visible to Radiant, visible to
        // Dire (the log's flags on the kill row: 1, 0 or null)]. Only kills a hero landed: see the header.
        roshan_kills: roshanDeaths,
        // [t, killer, the side that took it (0: the row does not say), event row].
        tormentor_kills: tormentorDeaths,
        // [second, hero, damage dealt to Roshan in that second].
        roshan_damage: [...roshanDamage].map(([k, v]) => [...k.split('|').map(Number), Math.round(v)]),
        // Per hero, in hero order: net worth at 0:00, 1:00, 2:00 … (null for a hero the metadata did not name).
        ...(perMinute ? { net_worth: list.map(graphOf) } : {}),
        // [t, hero index] for each buyback whose slot is a hero of this match. An empty list is "none" only when the
        // extract was read with this builder: a trace without the field does not know.
        buybacks: buybackRows.map(([bt, slot]) => [bt, list.findIndex((h) => h.player_index === slot)]).filter(([, i]) => i >= 0),
        // Every ward seen: [placed (null: standing when the replay began), ended (null: still up at the end), team,
        // 'o' observer / 's' sentry, x, y]. Only when the extract had a ward file.
        ...(wardRows ? { wards: [...wards.values()].map((w) => [w.from, w.to, w.team, w.kind === 'observer' ? 'o' : 's', w.x, w.y]).sort((a, b) => (a[0] ?? -1e9) - (b[0] ?? -1e9)) } : {}),
        source: { state_rows: stateRows, event_rows: eventRows, sample_hz: 1, extractor: meta.extractor ?? null },
        gaps: [
          { topic: 'vision', reason: wardRows ? 'ward_placements_only_not_what_each_side_saw' : 'no_fog_of_war_in_trace' },
          { topic: 'creeps', reason: 'no_creep_entities_in_trace' },
          { topic: 'roshan', reason: 'no_reliable_roshan_event' },
          { topic: 'ability_immunity', reason: 'only_item_spell_immunity_modifiers_tracked' },
          { topic: 'unused_free_abilities', reason: 'an_ability_never_cast_with_no_mana_cost_cannot_be_told_from_a_passive' },
          ...(graphs.length && !perMinute ? [{ topic: 'net_worth', reason: 'metadata_graph_denser_than_one_point_a_minute' }] : []),
        ],
      };
      return linkHeroNames(out);
    },
  };
}
