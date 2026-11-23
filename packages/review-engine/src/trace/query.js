/**
 * Read helpers over a `dota2.ai/match-trace@1` object (./build.js). Pure.
 */

export const clock = (t) => {
  const s = Math.abs(Math.trunc(t));
  return `${t < 0 ? '-' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Seconds from a number, a numeric string, or "mm:ss" ("-1:30" before the horn). Null when unreadable. */
export function seconds(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(-)?(\d{1,3}):([0-5]\d)$/);
  if (m) return (m[1] ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  const n = Number(v);
  return v.trim() !== '' && Number.isFinite(n) ? n : null;
}

const norm = (s) => String(s).trim().toLowerCase().replace(/^npc_dota_hero_/, '').replace(/[\s-]+/g, '_');

/** Index of a hero in the trace by its key ("beastmaster", "Phantom Assassin", "npc_dota_hero_axe"), or -1. */
export function heroIndex(trace, hero) {
  if (hero == null) return -1;
  const k = norm(hero);
  return trace.heroes.findIndex((h) => h.key === k);
}

/** A unit's name without the engine prefixes: "npc_dota_hero_axe" → "axe". */
export const unit = (s) => (typeof s === 'string' ? s.replace(/^(illusion:)?npc_dota_hero_/, '$1').replace(/^npc_dota_/, '') : null);
export const nameOf = (trace, i) => (i >= 0 ? unit(trace.names[i]) : null);
/** Index of a hero from an index into `trace.names`, or -1 when that name is not a hero of this match. */
export function heroOfName(trace, i) {
  const s = i >= 0 ? trace.names[i] : null;
  return s ? trace.heroes.findIndex((h) => h.npc === s) : -1;
}
/** Index of `name` in the string table, or -1. */
export const nameId = (trace, name) => trace.names.indexOf(name);

/** A hero's state at the nearest whole second with a sample (within 2 s), or null. */
export function stateAt(trace, h, t) {
  const s = trace.states[h];
  const i0 = Math.round(t) - trace.t0;
  for (const d of [0, -1, 1, -2, 2]) {
    const i = i0 + d;
    if (i >= 0 && i < trace.n && s.x[i] != null) {
      return { t: i + trace.t0, x: s.x[i], y: s.y[i], hp: s.hp[i], max_hp: s.max_hp[i], mana: s.mana[i], level: s.level[i], alive: s.alive[i] === 1 };
    }
  }
  return null;
}

export const dist = (a, b) => Math.round(Math.hypot(a.x - b.x, a.y - b.y));
const within = (intervals, t) => (intervals ?? []).find(([a, b]) => a <= t && t < b) ?? null;

/** Level of an ability at t (0 when not learned or unknown to the trace). */
export function abilityLevel(entry, t) {
  let lv = 0;
  for (const [at, level] of entry?.levels ?? []) { if (at <= t) lv = level; else break; }
  return lv;
}

/**
 * Seconds until an ability/item entry is off cooldown at t: 0 = ready.
 * From the cooldown sampled when the interval began, counted down — not from
 * the interval's end, which can come early (the item left the inventory, the
 * trace ended, the cooldown was reset). Inside an interval it is never 0.
 */
export function cooldownLeft(entry, t) {
  const iv = within(entry?.cd, t);
  if (!iv) return 0;
  const left = typeof iv[2] === 'number' ? iv[2] - (t - iv[0]) : iv[1] - t;
  return Math.max(0.1, Math.round(left * 10) / 10);
}

/**
 * Mana an ability costs at t, or null when the trace cannot say: 0 for one
 * never seen with a cost; the cost sampled at its level then (`costs`); in a
 * trace without per-level costs, the highest cost seen — but only once the
 * ability is at the highest level it reached, where that is its cost.
 */
export function manaCost(entry, t) {
  if (!entry?.mana) return 0;
  const lv = abilityLevel(entry, t);
  const at = (entry.costs ?? []).find(([level]) => level === lv);
  if (at) return at[1];
  if (entry.costs) return null;
  return lv > 0 && lv === Math.max(...entry.levels.map(([, level]) => level)) ? entry.mana : null;
}

/**
 * The most mana hero h had in any second from `from` to `to`, over every
 * sample of each second (`mana_peak`). Null with no sample — and in a trace
 * that kept one sample a second only: a peak between those is not seen, so
 * such a trace cannot say the hero never had the mana.
 */
export function mostMana(trace, h, from, to) {
  const peak = trace.states[h].mana_peak;
  if (!peak) return null;
  let best = null;
  for (let sec = Math.floor(from); sec <= Math.ceil(to); sec += 1) {
    const i = sec - trace.t0;
    const m = i >= 0 && i < trace.n ? peak[i] : null;
    if (m != null && (best == null || m > best)) best = m;
  }
  return best;
}

export const heldAt = (entry, t) => within(entry?.held, t) != null;

/**
 * Where a point is, in words. World units; Radiant's base is bottom-left,
 * Dire's top-right, the river runs along x + y ≈ 0. A coarse label for
 * reading, not a measurement: the coordinates travel with it.
 */
export function region(x, y) {
  if (x > 4200 && y > 3800) return 'dire_base';
  if (x < -4600 && y < -4200) return 'radiant_base';
  const s = x + y; const d = y - x;
  const side = s > 1500 ? 'dire' : s < -1500 ? 'radiant' : 'river';
  let area;
  if (Math.abs(d) < 2200) area = 'mid';
  else if (d > 0) area = x < -4800 || y > 4800 ? 'top_lane' : 'top_jungle';
  else area = x > 4800 || y < -4800 ? 'bot_lane' : 'bot_jungle';
  return `${side}_${area}`;
}

/** Other living heroes within `radius` of hero h at t, split into allies and enemies, nearest first. */
export function nearby(trace, h, t, radius) {
  const me = stateAt(trace, h, t);
  const allies = []; const enemies = [];
  if (!me) return { me: null, allies, enemies };
  trace.heroes.forEach((o, i) => {
    if (i === h) return;
    const s = stateAt(trace, i, t);
    if (!s || !s.alive) return;
    const d = dist(me, s);
    if (d > radius) return;
    (o.team === trace.heroes[h].team ? allies : enemies).push({ hero: o.key, dist: d, hp: s.hp, max_hp: s.max_hp });
  });
  allies.sort((a, b) => a.dist - b.dist); enemies.sort((a, b) => a.dist - b.dist);
  return { me, allies, enemies };
}

/** Spell-immunity windows per hero from the modifier log: [{ hero, modifier, from, to }]. `to` is null when no removal was logged. */
export function immunityIntervals(trace) {
  const open = new Map(); const out = [];
  for (const [t, target, mod, , add, , kind] of trace.modifiers) {
    if (kind !== 'i') continue;
    const h = heroOfName(trace, target);
    if (h < 0) continue;
    const key = `${h}|${mod}`;
    if (add) { if (!open.has(key)) { const w = { hero: h, modifier: trace.names[mod], from: t, to: null }; open.set(key, w); out.push(w); } }
    else { const w = open.get(key); if (w) { w.to = t; open.delete(key); } }
  }
  return out.sort((a, b) => a.from - b.from);
}
