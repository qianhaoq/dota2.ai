/**
 * Power spikes: when each hero's game changed, from this match's own logs.
 *
 * Pure, parsed matches only. A spike is a finished key item (built from a
 * recipe and worth at least KEY_ITEM_MIN_COST, or one of ALWAYS_KEY_ITEMS)
 * from the purchase log, or an Aegis pickup from the objectives log. Nothing
 * here is a power-curve opinion: it is what this player bought and when.
 *
 * Used to anchor death and fight advice to the enemy's timeline ("after
 * Ursa's Blink Dagger at 16:56 you died to him 7 times") instead of generic
 * minimap rules.
 */
import { createRequire } from 'node:module';
import { ALWAYS_KEY_ITEMS, KEY_ITEM_MIN_COST } from './knowledge.js';

const NAMES = createRequire(import.meta.url)('./data/names.json');

/** Valve: the Aegis of the Immortal expires 5 minutes after it is picked up. */
export const AEGIS_SECONDS = 300;

/** Gap closers: after one of these, "out of vision" means "can reach you". */
export const INITIATION_ITEMS = new Set([
  'blink', 'overwhelming_blink', 'swift_blink', 'arcane_blink', 'force_staff', 'shadow_blade', 'invis_sword', 'silver_edge',
]);

/** A finished item worth calling a spike; components and consumables are not. */
export function isSpikeItem(key) {
  const it = NAMES.items[key];
  if (!it || key.startsWith('recipe_')) return false;
  return ALWAYS_KEY_ITEMS.includes(key) || (it.built === true && it.cost >= KEY_ITEM_MIN_COST);
}

const heroSlug = (key) => String(key ?? '').replace(/^npc_dota_hero_/, '');

/** Death times of one player: their own death log, else the killers' kill logs. */
function deathTimes(match, slot) {
  const me = match.players[slot];
  if (Array.isArray(me.deaths_log)) return me.deaths_log.map((d) => d.time).filter(Number.isFinite).sort((a, b) => a - b);
  const slug = NAMES.heroes[String(me.hero_id)]?.slug;
  if (!slug) return [];
  const times = [];
  for (const p of match.players) {
    if (!Array.isArray(p.kills_log)) continue;
    for (const k of p.kills_log) if (heroSlug(k.key) === slug && Number.isFinite(k.time)) times.push(k.time);
  }
  return times.sort((a, b) => a - b);
}

/**
 * Every player's spikes, indexed by slot (0..9).
 * `null` for a player when the replay has no purchase log for them.
 * @returns {Array<{ slot: number, hero_id: number, items: {key: string, time: number}[], aegis: {time: number, until: number}[] } | null>}
 */
export function powerSpikes(match) {
  const players = match?.players ?? [];
  const out = players.map((p, slot) => {
    if (!Array.isArray(p.purchase_log)) return null;
    const seen = new Set();
    const items = [];
    for (const x of p.purchase_log) {
      if (!Number.isFinite(x?.time) || seen.has(x.key) || !isSpikeItem(x.key)) continue;
      seen.add(x.key);
      items.push({ key: x.key, time: x.time });
    }
    items.sort((a, b) => a.time - b.time);
    return { slot, hero_id: p.hero_id, items, aegis: [] };
  });
  // Aegis: held from pickup until it expires, or until the holder's next
  // death (the Aegis revives them once, so that death ends the window).
  for (const o of match?.objectives ?? []) {
    if (o?.type !== 'CHAT_MESSAGE_AEGIS' || !Number.isFinite(o.time)) continue;
    const slot = Number.isInteger(o.slot) ? o.slot : Number.isInteger(o.player_slot) ? (o.player_slot >= 128 ? o.player_slot - 123 : o.player_slot) : null;
    if (slot == null || !out[slot]) {
      if (slot != null && players[slot]) out[slot] = { slot, hero_id: players[slot].hero_id, items: [], aegis: [] };
      else continue;
    }
    const nextDeath = deathTimes(match, slot).find((t) => t > o.time);
    const until = Math.min(o.time + AEGIS_SECONDS, nextDeath ?? Infinity);
    out[slot].aegis.push({ time: o.time, until });
  }
  return out;
}

/** What a player had at `time`: finished key items so far, the latest one, and whether they held an Aegis. */
export function spikeStateAt(spikes, slot, time) {
  const s = spikes?.[slot];
  if (!s) return null;
  const items = s.items.filter((x) => x.time <= time);
  return {
    items,
    latest: items[items.length - 1] ?? null,
    aegis: s.aegis.some((a) => time >= a.time && time <= a.until),
  };
}

/** Slot of the player on `hero_id`, or null. */
export function slotOfHero(match, heroId) {
  const i = (match?.players ?? []).findIndex((p) => p.hero_id === heroId);
  return i >= 0 ? i : null;
}

/**
 * The deaths to one killer, split by that killer's spikes.
 * `anchor` is the spike that best explains the deaths: their first gap closer
 * when they bought one (after it, out of vision means they can reach you),
 * else their first key item. `after` counts deaths at or after it.
 * @param {number[]} times  death times to this killer
 */
export function deathsAroundSpikes(spikes, killerSlot, times) {
  const s = spikes?.[killerSlot];
  if (!s || !s.items.length || !times.length) return null;
  const anchor = s.items.find((x) => INITIATION_ITEMS.has(x.key)) ?? s.items[0];
  const after = times.filter((t) => t >= anchor.time).length;
  const withAegis = times.filter((t) => s.aegis.some((a) => t >= a.time && t <= a.until)).length;
  return { anchor, before: times.length - after, after, with_aegis: withAegis, initiation: INITIATION_ITEMS.has(anchor.key) };
}
