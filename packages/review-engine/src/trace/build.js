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
 *   and buildings summed per second by (attacker, target, inflictor).
 *
 * What the extractor does not have stays absent (see `gaps`): fog of war,
 * creeps, Roshan. Nothing is estimated.
 */

export const TRACE_SCHEMA = 'dota2.ai/match-trace@1';

/** Item slots a hero can use from: inventory 0–5, TP 15, neutral 16–17. Backpack (6–8) is not held. */
const usableSlot = (slot) => (slot >= 0 && slot <= 5) || (slot >= 15 && slot <= 17);
/** Modifiers that make a hero spell immune. Items only: hero abilities are not covered (a stated gap). */
const IMMUNITY = /black_king_bar_immune|magic_immune|debuff_immune|spell_immun/;
const BUILDING = /_(tower\d|fort|melee_rax|range_rax)/;
const r1 = (n) => Math.round(n * 10) / 10;

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
  /** @type {Map<string, number>} */
  const damage = new Map();
  let stateRows = 0; let eventRows = 0; let lastT = -Infinity; let firstT = Infinity;

  function hero(key, row) {
    let h = heroes.get(key);
    if (!h) {
      h = { key, team: row.team, player_index: row.player_index ?? null, samples: new Map(), abilities: new Map(), items: new Map(), controls: new Map() };
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
      const prev = h.samples.get(sec);
      const off = Math.abs(t - sec);
      if (!prev || off < prev.off) {
        h.samples.set(sec, { off, x: Math.round(row.x), y: Math.round(row.y), hp: row.hp, max_hp: row.max_hp, mana: Math.round(row.mana), level: row.level, alive: row.life_state === 0 ? 1 : 0 });
      }
      for (const a of row.abilities ?? []) {
        if (typeof a?.name !== 'string' || a.name.startsWith('special_bonus')) continue;
        let e = h.abilities.get(a.name);
        if (!e) { e = { levels: [], cd: [], cdState: { from: null }, lastCd: 0, level: 0, mana: 0 }; h.abilities.set(a.name, e); }
        if (a.mana_cost > e.mana) e.mana = a.mana_cost;
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
          break;
        case 'DOTA_COMBATLOG_PURCHASE':
          purchases.push([t, id(e.target), id(e.value_name || e.inflictor), row]);
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

    /** @param {{ match_id?: number | null, extractor?: object | null }} [meta] */
    finish(meta = {}) {
      const list = [...heroes.values()].sort((a, b) => a.team - b.team || (a.player_index ?? 0) - (b.player_index ?? 0));
      const t0 = Number.isFinite(firstT) ? Math.round(firstT) : 0;
      const n = Number.isFinite(lastT) ? Math.round(lastT) - t0 + 1 : 0;
      const closeAll = (entries, t) => { for (const e of entries) { if (e.cdState) track(e.cd, e.cdState, false, t); if (e.heldState) track(e.held, e.heldState, false, t); if (e.state) track(e.list, e.state, false, t); } };
      const cols = ['x', 'y', 'hp', 'max_hp', 'mana', 'level', 'alive'];
      const out = {
        schema: TRACE_SCHEMA,
        match_id: meta.match_id ?? null,
        t0,
        n,
        heroes: list.map((h) => ({ key: h.key, npc: `npc_dota_hero_${h.key}`, team: h.team, player_index: h.player_index })),
        states: list.map((h) => {
          const s = Object.fromEntries(cols.map((c) => [c, new Array(n).fill(null)]));
          for (const [sec, v] of h.samples) { const i = sec - t0; if (i >= 0 && i < n) for (const c of cols) s[c][i] = v[c]; }
          return s;
        }),
        abilities: list.map((h) => { closeAll(h.abilities.values(), lastT); return Object.fromEntries([...h.abilities].filter(([, e]) => e.levels.some(([, lv]) => lv > 0)).map(([k, e]) => [k, { levels: e.levels, cd: e.cd, ...(e.mana > 0 ? { mana: Math.round(e.mana) } : {}) }])); }),
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
        source: { state_rows: stateRows, event_rows: eventRows, sample_hz: 1, extractor: meta.extractor ?? null },
        gaps: [
          { topic: 'vision', reason: 'no_fog_of_war_in_trace' },
          { topic: 'creeps', reason: 'no_creep_entities_in_trace' },
          { topic: 'roshan', reason: 'no_reliable_roshan_event' },
          { topic: 'ability_immunity', reason: 'only_item_spell_immunity_modifiers_tracked' },
          { topic: 'unused_free_abilities', reason: 'an_ability_never_cast_with_no_mana_cost_cannot_be_told_from_a_passive' },
        ],
      };
      return out;
    },
  };
}
