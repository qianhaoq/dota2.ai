/**
 * The state of the game at a second, and who took part in a fight — pure, no IO.
 *
 * The other tools list events (a death, a cast, a building). A coach reads a
 * moment differently: where was everyone, what were they doing, what did each
 * of them have ready. This module answers that for any second of the trace,
 * from the same samples the other tools read:
 *
 * - `doing` is what the replay shows, never a guess: dead, in their own base,
 *   trading damage with an enemy hero, hitting an enemy building, or none of
 *   these (then only the place is known: the trace has no creeps, so a hero
 *   in a jungle is not thereby farming it);
 * - an ability or item is ready when it is held/learned, off cooldown and,
 *   for an ability, its cost is within the hero's mana. Unknown stays null.
 *
 * A fight's participants are the heroes that dealt or took damage from an
 * enemy hero in it — measured, not inferred from distance (a hero standing
 * near a fight is not thereby in it, and the heroes who died in a fight are
 * by definition near it, which biases any distance rule toward the losers).
 */
import { abilityLevel, cooldownLeft, dist, heldAt, heroOfName, manaCost, region, stateAt } from './query.js';

/** Seconds around t in which damage counts as "now" for `doing`. */
export const STATE_NEAR = 3;
/** Seconds before a fight's first death that its hero damage is looked for. */
export const ENGAGE_LEAD = 15;
const TP_ITEMS = ['item_tpscroll', 'item_travel_boots', 'item_travel_boots_2'];
const BUILDING = /_(tower\d|fort|melee_rax|range_rax)/;
const teamOfBuilding = (name) => (/goodguys/.test(name) ? 2 : /badguys/.test(name) ? 3 : null);

const cache = new WeakMap();
/** Per second: the hero pairs that traded damage, and the heroes that hit an enemy building. Built once per trace. */
function index(trace) {
  let ix = cache.get(trace);
  if (ix) return ix;
  const heroes = new Map(); const buildings = new Map();
  const add = (m, sec, v) => { let l = m.get(sec); if (!l) m.set(sec, (l = [])); l.push(v); };
  for (const [sec, a, target] of trace.damage ?? []) {
    const ah = heroOfName(trace, a);
    if (ah < 0) continue;
    const th = heroOfName(trace, target);
    if (th >= 0) { if (trace.heroes[ah].team !== trace.heroes[th].team) add(heroes, sec, [ah, th]); continue; }
    const name = trace.names[target];
    if (name && BUILDING.test(name) && teamOfBuilding(name) && teamOfBuilding(name) !== trace.heroes[ah].team) add(buildings, sec, ah);
  }
  ix = { heroes, buildings };
  cache.set(trace, ix);
  return ix;
}

/** Seconds until hero h is alive again after t, or null when the trace does not show it. */
function respawnIn(trace, h, t) {
  const alive = trace.states[h].alive;
  for (let i = Math.max(0, Math.round(t) - trace.t0); i < trace.n; i += 1) if (alive[i] === 1) return i + trace.t0 - Math.round(t);
  return null;
}

/**
 * Whether an ability entry was ready at t: { ready, seconds_left?, why? }. `ready` is null when the trace
 * cannot say (no cost known while the hero's mana is below the highest one) or the ability has no cooldown.
 */
function abilityReady(entry, mana, t, { passive = false } = {}) {
  if (!entry) return { ready: null, why: 'not_in_trace' };
  if (abilityLevel(entry, t) <= 0) return { ready: false, why: 'not_learned' };
  if (passive) return { ready: null, why: 'no_cooldown' };
  const left = cooldownLeft(entry, t);
  if (left > 0) return { ready: false, why: 'cooldown', seconds_left: Math.round(left) };
  // A trace without the cost over time knows only the game's highest cost (`mana`): enough mana for that is enough.
  const cost = manaCost(entry, t) ?? (mana != null && typeof entry.mana === 'number' && mana >= entry.mana ? entry.mana : null);
  if (cost == null) return { ready: null, why: 'mana_cost_unknown' };
  if (mana != null && mana < cost) return { ready: false, why: 'mana', mana: Math.round(mana), cost };
  return { ready: true };
}

/**
 * Hero h at second t: where, doing what, and what they had ready.
 * @param {any} trace
 * @param {number} h hero index
 * @param {number} t game second
 * @param {{ ultimate?: string | null, passiveUltimate?: boolean, from?: { x: number, y: number } }} [o]
 *   `ultimate` is the hero's ultimate key (the caller's data); `from` a point to measure the distance to.
 */
export function heroStateAt(trace, h, t, o = {}) {
  const s = stateAt(trace, h, t);
  const hero = trace.heroes[h];
  if (!s) return { hero: hero.key, known: false };
  const ix = index(trace);
  let trading = false; let hitting = false;
  for (let sec = Math.floor(t) - STATE_NEAR; sec <= Math.floor(t) + STATE_NEAR; sec += 1) {
    if ((ix.heroes.get(sec) ?? []).some(([a, b]) => a === h || b === h)) trading = true;
    if ((ix.buildings.get(sec) ?? []).includes(h)) hitting = true;
  }
  const place = region(s.x, s.y);
  const own = hero.team === 2 ? 'radiant_base' : 'dire_base';
  const doing = !s.alive ? 'dead' : trading ? 'trading_damage_with_enemy_heroes' : hitting ? 'hitting_enemy_buildings' : place === own ? 'in_own_base' : 'none_of_these';
  const items = trace.items?.[h] ?? {};
  const tp = TP_ITEMS.filter((k) => heldAt(items[k], t));
  const bkb = items.item_black_king_bar && heldAt(items.item_black_king_bar, t) ? (cooldownLeft(items.item_black_king_bar, t) === 0) : null;
  const ult = o.ultimate ? abilityReady(trace.abilities?.[h]?.[o.ultimate], s.mana, t, { passive: o.passiveUltimate }) : null;
  return {
    hero: hero.key,
    known: true,
    alive: s.alive,
    // A dead hero's position is where the body or the fountain is: no place, no distance.
    ...(s.alive ? { place } : { respawn_in: respawnIn(trace, h, t) }),
    doing,
    ...(o.from && s.alive ? { distance: dist(s, o.from) } : {}),
    level: s.level,
    hp_pct: s.max_hp > 0 ? Math.round((s.hp / s.max_hp) * 100) : null,
    mana: s.mana == null ? null : Math.round(s.mana),
    ...(ult ? { ultimate: { ability: o.ultimate, ...ult } } : {}),
    // Null: not holding one. A TP's own cooldown counts; mana is not checked (it has no mana cost).
    tp_ready: tp.length ? tp.some((k) => cooldownLeft(items[k], t) === 0) : null,
    black_king_bar_ready: bkb,
  };
}

/**
 * Who took part in a fight (a match_overview fight: { from, to, deaths }): every hero that dealt damage to an
 * enemy hero, or took it, from ENGAGE_LEAD seconds before its first death to its last, plus the heroes that died
 * in it. `engaged_at` is the second of the first such damage. The place is where the dead were, a second before.
 */
export function fightParticipation(trace, fight) {
  const ix = index(trace);
  const took = new Set(); let engagedAt = null;
  for (let sec = Math.floor(fight.from - ENGAGE_LEAD); sec <= Math.ceil(fight.to); sec += 1) {
    for (const [a, b] of ix.heroes.get(sec) ?? []) { took.add(a); took.add(b); if (engagedAt == null) engagedAt = sec; }
  }
  const victims = fight.deaths.map((d) => heroOfName(trace, d[1])).filter((v) => v >= 0);
  for (const v of victims) took.add(v);
  const pts = fight.deaths.map((d) => { const v = heroOfName(trace, d[1]); return v >= 0 ? stateAt(trace, v, d[0] - 1) : null; }).filter(Boolean);
  const at = pts.length ? { x: Math.round(pts.reduce((n, p) => n + p.x, 0) / pts.length), y: Math.round(pts.reduce((n, p) => n + p.y, 0) / pts.length) } : null;
  return { took_part: took, engaged_at: engagedAt ?? Math.floor(fight.from), at, victims };
}
