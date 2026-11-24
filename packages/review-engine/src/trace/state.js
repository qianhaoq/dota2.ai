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
/** A damage exchange belongs to a fight only with both heroes this close to where one of its heroes died. */
export const ENGAGE_RADIUS = 3000;
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
  // Boots of Travel upgrade the Town Portal Scroll (Valve's item text): with the scroll held, its cooldown is the
  // teleport's. The boots' own cooldown is read only when no scroll is held.
  const scroll = heldAt(items.item_tpscroll, t);
  const tp = scroll ? ['item_tpscroll'] : TP_ITEMS.filter((k) => heldAt(items[k], t));
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
 * Who took part in a fight (a match_overview fight: { from, to, deaths }). From ENGAGE_LEAD seconds before its
 * first death to its last, the heroes that died in it, and every hero joined to them by damage between enemy
 * heroes — dealt to or taken from one already in it, directly or through others — with both heroes of that
 * exchange within ENGAGE_RADIUS of where one of the fight's heroes died. Damage traded elsewhere on the map at
 * the same time is another encounter, not this fight. `engaged_at` is the second of the first exchange in it;
 * `at` the middle of where the dead were, a second before.
 */
export function fightParticipation(trace, fight) {
  const ix = index(trace);
  const victims = fight.deaths.map((d) => heroOfName(trace, d[1])).filter((v) => v >= 0);
  const spots = fight.deaths.map((d) => { const v = heroOfName(trace, d[1]); return v >= 0 ? stateAt(trace, v, d[0] - 1) : null; }).filter(Boolean);
  const near = (h, sec) => { const s = stateAt(trace, h, sec); return !!s && spots.some((p) => dist(s, p) <= ENGAGE_RADIUS); };
  const edges = [];
  for (let sec = Math.floor(fight.from - ENGAGE_LEAD); sec <= Math.ceil(fight.to); sec += 1) {
    for (const [a, b] of ix.heroes.get(sec) ?? []) if (near(a, sec) && near(b, sec)) edges.push([sec, a, b]);
  }
  const took = new Set(victims); let engagedAt = null;
  for (let grew = true; grew;) {
    grew = false;
    for (const [sec, a, b] of edges) {
      if (!took.has(a) && !took.has(b)) continue;
      if (engagedAt == null || sec < engagedAt) engagedAt = sec;
      for (const x of [a, b]) if (!took.has(x)) { took.add(x); grew = true; }
    }
  }
  const at = spots.length ? { x: Math.round(spots.reduce((n, p) => n + p.x, 0) / spots.length), y: Math.round(spots.reduce((n, p) => n + p.y, 0) / spots.length) } : null;
  return { took_part: took, engaged_at: engagedAt ?? Math.floor(fight.from), at, victims };
}

/** Observer wards this close count as "near" a spot (an observer's day vision is 1600: near is a distance, not a claim of sight). */
export const WARD_NEAR = 1600;

/**
 * Observer wards standing at second t within WARD_NEAR of a spot, per team: { 2: n, 3: n }. Null when the trace has
 * no ward list (built before wards were read, or from an extract without them): unknown, not none.
 */
export function observersNear(trace, at, t) {
  if (!Array.isArray(trace?.wards) || !at) return null;
  const out = { 2: 0, 3: 0 };
  for (const [from, to, team, kind, x, y] of trace.wards) {
    if (kind !== 'o' || (from != null && from > t) || (to != null && to <= t)) continue;
    if (Math.hypot(x - at.x, y - at.y) <= WARD_NEAR) out[team] += 1;
  }
  return out;
}

/**
 * Whether hero h bought back while dead after a death at second t: the buyback's clock, false, or null when the trace
 * does not record buybacks (built before they were read).
 */
export function boughtBackAfter(trace, h, t) {
  if (!Array.isArray(trace?.buybacks)) return null;
  const alive = trace.states[h].alive;
  let back = null;
  for (let i = Math.max(0, Math.ceil(t) - trace.t0 + 1); i < trace.n; i += 1) if (alive[i] === 1) { back = i + trace.t0; break; }
  const b = trace.buybacks.find(([bt, i]) => i === h && bt >= t && (back == null || bt <= back + 1));
  return b ? b[0] : false;
}

/** Hits on one building more than this many seconds apart are two pushes. */
export const SIEGE_GAP = 30;
/** A push is at least this many hero-seconds of damage to the building. */
export const SIEGE_MIN_HITS = 3;
/** The owners' heroes this close to where the hitters stood are counted as near the building. */
export const SIEGE_NEAR = 1800;
const OBJECTIVE = /_(tower\d|melee_rax|range_rax|fort)(_(top|mid|bot))?$/;

/**
 * Every push on a building: enemy heroes damaging it, hits no more than SIEGE_GAP seconds apart, at least
 * SIEGE_MIN_HITS hero-seconds (a hero's attack and spell in one second are one). For each: { building (name id),
 * owner team, from, to, hitters (hero indexes), near (owners' heroes alive within SIEGE_NEAR of a hitter at a second
 * that hitter hit), spot (the middle of where the hitters stood), fell_at }.
 * `fell_at` is the building's death when it came during the push or within 15 s after; null when it stood.
 * Two towers beside each Ancient share one name: their damage cannot be told apart (`same_name`).
 */
export function sieges(trace) {
  const by = new Map();
  for (const [sec, a, target] of trace.damage ?? []) {
    const name = trace.names[target];
    if (!name || !OBJECTIVE.test(name)) continue;
    const owner = teamOfBuilding(name); const ah = heroOfName(trace, a);
    if (!owner || ah < 0 || trace.heroes[ah].team === owner) continue;
    // Keyed by (second, hero): the damage log has a row per inflictor, and a hero's attack and spell in one second are one hero-second.
    let l = by.get(target); if (!l) by.set(target, (l = new Map())); l.set(`${sec}|${ah}`, [sec, ah]);
  }
  const out = [];
  for (const [target, seen] of by) {
    const hits = [...seen.values()];
    const name = trace.names[target]; const owner = teamOfBuilding(name);
    const deaths = (trace.buildings ?? []).filter((b) => b[1] === target).map((b) => b[0]);
    hits.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const runs = [];
    for (const h of hits) { const l = runs.at(-1); if (l && h[0] - l.to <= SIEGE_GAP) { l.to = h[0]; l.hits.push(h); } else runs.push({ from: h[0], to: h[0], hits: [h] }); }
    for (const r of runs) {
      if (r.hits.length < SIEGE_MIN_HITS) continue;
      const placed = r.hits.map(([sec, h]) => ({ sec, at: stateAt(trace, h, sec) })).filter((x) => x.at);
      if (!placed.length) continue;
      // The middle of where the hitters stood: what the others' distances are measured from.
      const spot = { x: Math.round(placed.reduce((n, p) => n + p.at.x, 0) / placed.length), y: Math.round(placed.reduce((n, p) => n + p.at.y, 0) / placed.length) };
      // An owner is near when alive within SIEGE_NEAR of a hitter, both at the second that hitter hit.
      const near = new Set();
      for (const { sec, at } of placed) {
        trace.heroes.forEach((h, i) => { if (h.team !== owner || near.has(i)) return; const st = stateAt(trace, i, sec); if (st?.alive && dist(st, at) <= SIEGE_NEAR) near.add(i); });
      }
      const fell = deaths.find((d) => d >= r.from - 1 && d <= r.to + 15);
      // Dead when it began, whatever they did later (one who respawned and came near is also in `near`). Unknown position: not counted.
      const deadAtStart = trace.heroes.filter((h, i) => h.team === owner && stateAt(trace, i, r.from)?.alive === false).length;
      out.push({ building: target, name, owner, from: r.from, to: r.to, hitters: [...new Set(r.hits.map((h) => h[1]))], near: [...near], dead_owners_at_start: deadAtStart, spot, fell_at: fell ?? null, same_name: /_tower4$/.test(name) });
    }
  }
  return out.sort((x, y) => x.from - y.from);
}
