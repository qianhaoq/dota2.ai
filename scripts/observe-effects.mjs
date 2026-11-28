#!/usr/bin/env node
/**
 * What abilities and items did in real games, observed in raw replay extracts (dota-extract's events.jsonl and
 * states.jsonl), never inferred from their text or flags (#508):
 * - where each one's modifiers landed: on the caster (`self`), an allied hero, an enemy hero, or another unit —
 *   a modifier belongs to the cast it followed (same caster, within LINK_SECONDS), named after it or the only cast
 *   in that time;
 * - the engine's state of a hero while a modifier was on it: the share of its state samples with each control flag
 *   (`controls`) and each `unit_state` bit named in STATE_BITS (stunned, disarmed, invulnerable…) — samples where the
 *   hero was debuff immune are counted apart (`samples_while_debuff_immune`), as what the immunity did;
 * - what was removed from a hero as an item's effect landed on it (`removals`): the other modifiers removed from that
 *   hero at that instant or within DISPEL_SECONDS after, with on whom the item's effect was put. A removal at that
 *   moment can still be an expiry or another effect's doing: a reader takes it as a dispel only together with Valve's
 *   own word that the ability can be dispelled that way (lib/agent/situationTools.js removedBy).
 *
 *   node scripts/observe-effects.mjs <extract dir> [<extract dir>…] --out lib/coach/data/observed-effects.json [--add]
 *
 * An extract dir holds events.jsonl and states.jsonl (dota-extract <replay> <out> writes them under <out>/trace).
 * --add merges into an existing --out (a game already in it is skipped), so a corpus can be done one replay at a
 * time and each raw extract deleted after (they are hundreds of MB). Prints how often the decoded unit_state bits
 * agree with the controls flags, as a check of STATE_BITS.
 */
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

const args = process.argv.slice(2);
const out = args[args.indexOf('--out') + 1];
const add = args.includes('--add');
const dirs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
if (!out || !dirs.length) { console.error('usage: observe-effects.mjs <extract dir>... --out <file> [--add]'); process.exit(2); }

/** A modifier removed from a hero this close to an item's effect landing on it was taken off by that effect. */
const DISPEL_SECONDS = 0.05;
/** A modifier added this soon after a cast by the same caster may be that cast's. */
const LINK_SECONDS = 0.6;
/** State samples this close to a modifier's start or end are not counted (the sample may predate it). */
const EDGE = 0.15;
/**
 * Bits of a hero's `unit_state` (the engine's modifier states, in their enum order). Checked against the extractor's
 * `controls` flags on every sample (printed at the end): rooted, silenced, muted, stunned and hexed.
 */
const STATE_BITS = ['rooted', 'disarmed', 'attack_immune', 'silenced', 'muted', 'stunned', 'hexed', 'invisible', 'invulnerable', 'magic_immune'];
const CHECKED = ['rooted', 'silenced', 'muted', 'stunned', 'hexed'];

const prev = add && existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
const db = prev ?? { schema: 'dota2.ai/observed-effects@1', source: 'dota-extract events.jsonl (DOTA_COMBATLOG_MODIFIER_ADD/REMOVE, ABILITY, ITEM) and states.jsonl (controls, unit_state) of the replays in agent/golden/replays/ (scripts/observe-effects.mjs)', state_bits: STATE_BITS, games: [], sources: {} };
const agree = Object.fromEntries(CHECKED.map((k) => [k, { both: 0, only_bit: 0, only_flag: 0 }]));

const lines = async function* (file) { const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity }); for await (const l of rl) if (l) yield JSON.parse(l); };
const heroKey = (name) => (typeof name === 'string' && name.startsWith('npc_dota_hero_') ? name.slice('npc_dota_hero_'.length) : null);
const norm = (k) => String(k ?? '').replace(/_/g, '').toLowerCase();

for (const dir0 of dirs) {
  const dir = existsSync(path.join(dir0, 'trace', 'events.jsonl')) ? path.join(dir0, 'trace') : dir0;
  let matchId = null;
  try { const meta = readFileSync(path.join(dir, 'metadata.jsonl'), 'utf8').split('\n').find(Boolean); matchId = JSON.parse(meta)?.match_id ?? null; } catch { /* none */ }
  if (matchId == null) matchId = Number(path.basename(dir0).match(/\d{8,}/)?.[0]) || path.basename(dir0);
  if (db.games.includes(matchId)) { console.error(`skip ${matchId}: already in ${out}`); continue; }

  // A hero's state samples, by hero key: [t, set of states on].
  const states = new Map();
  for await (const s of lines(path.join(dir, 'states.jsonl'))) {
    if (s.entity_kind !== 'real_hero' || !Number.isFinite(s.t) || !s.hero) continue;
    const on = new Set();
    const bits = Number(s.unit_state);
    if (Number.isFinite(bits)) STATE_BITS.forEach((name, i) => { if (bits & (2 ** i)) on.add(name); });
    for (const k of CHECKED) {
      const flag = s.controls?.[k] === true; const bit = on.has(k);
      if (flag && bit) agree[k].both += 1; else if (bit) agree[k].only_bit += 1; else if (flag) agree[k].only_flag += 1;
      if (flag) on.add(k);
    }
    for (const [k, v] of Object.entries(s.controls ?? {})) if (v === true) on.add(k);
    const key = norm(s.hero);
    if (!states.has(key)) states.set(key, []);
    states.get(key).push([s.t, on]);
  }
  for (const list of states.values()) list.sort((a, b) => a[0] - b[0]);

  const casts = new Map(); // caster → [t, source]
  const adds = []; const open = new Map(); const intervals = []; const removes = new Map(); // target → [t, modifier]
  for await (const e of lines(path.join(dir, 'events.jsonl'))) {
    const caster = e.attacker_hero === true && e.attacker_illusion !== true ? heroKey(e.attacker) : null;
    if ((e.type === 'DOTA_COMBATLOG_ABILITY' || e.type === 'DOTA_COMBATLOG_ITEM') && caster && typeof e.inflictor === 'string') {
      const source = e.type === 'DOTA_COMBATLOG_ITEM' ? `item:${e.inflictor.replace(/^item_/, '')}` : `ability:${e.inflictor}`;
      if (!casts.has(caster)) casts.set(caster, []);
      casts.get(caster).push([e.t, source]);
    } else if (e.type === 'DOTA_COMBATLOG_MODIFIER_ADD' && caster && typeof e.inflictor === 'string') {
      const target = e.target_hero === true && e.target_illusion !== true ? heroKey(e.target) : null;
      const side = target === caster ? 'self' : target ? (e.target_team === e.attacker_team ? 'ally_hero' : 'enemy_hero') : 'other';
      const a = { t: e.t, caster, target, side, modifier: e.inflictor };
      adds.push(a);
      if (target) open.set(`${e.inflictor}|${target}`, a);
    } else if (e.type === 'DOTA_COMBATLOG_MODIFIER_REMOVE' && typeof e.inflictor === 'string') {
      const target = e.target_hero === true && e.target_illusion !== true ? heroKey(e.target) : null;
      const a = target ? open.get(`${e.inflictor}|${target}`) : null;
      if (a) { intervals.push([a, e.t]); open.delete(`${e.inflictor}|${target}`); }
      if (target) { if (!removes.has(target)) removes.set(target, []); removes.get(target).push([e.t, e.inflictor]); }
    }
  }

  // Each modifier to the cast it followed: named after the cast, or the only cast of that caster in LINK_SECONDS.
  const sourceOf = (a) => {
    const near = (casts.get(a.caster) ?? []).filter(([t]) => a.t - t >= -0.05 && a.t - t <= LINK_SECONDS);
    if (!near.length) return null;
    // Named after it only: a cast that merely came first is not the cause (Eul's at the moment an aura ticked).
    const named = near.filter(([, s]) => a.modifier.includes(s.split(':')[1]));
    return named.length ? named[named.length - 1][1] : null;
  };
  const entry = (source, modifier) => {
    db.sources[source] ??= { modifiers: {} };
    const m = (db.sources[source].modifiers[modifier] ??= { self: 0, ally_hero: 0, enemy_hero: 0, other: 0, games: 0, target_state: { samples: 0 } });
    return m;
  };
  const seenHere = new Set();
  const linked = new Map();
  for (const a of adds) {
    const source = sourceOf(a);
    if (!source) continue;
    linked.set(a, source);
    const m = entry(source, a.modifier);
    m[a.side] += 1;
    const k = `${source}|${a.modifier}`;
    if (!seenHere.has(k)) { seenHere.add(k); m.games += 1; }
  }
  for (const [a, end] of intervals) {
    const source = linked.get(a);
    if (!source || !a.target) continue;
    const list = states.get(norm(a.target)) ?? [];
    const ts = entry(source, a.modifier).target_state;
    for (const [t, on] of list) {
      if (t < a.t + EDGE) continue;
      if (t > end - EDGE) break;
      // A target that was debuff immune at that moment shows what the immunity did, not the modifier (Heaven's Halberd's
      // disarm on a hero under Black King Bar is added and does nothing): counted apart.
      if (on.has('debuff_immune') || on.has('magic_immune')) { ts.samples_while_debuff_immune = (ts.samples_while_debuff_immune ?? 0) + 1; continue; }
      ts.samples += 1;
      for (const k of on) ts[k] = (ts[k] ?? 0) + 1;
    }
  }
  // What an item's effect took off the hero it landed on: every other modifier on that hero removed at that instant
  // (within DISPEL_SECONDS). That is the dispel seen, per removed modifier — not inferred from an ability's flag (#510
  // review: Heavenly Jump's leap on Zeus is not the effect its dispel flag is about).
  const removedHere = new Set();
  for (const [a, source] of linked) {
    if (!source.startsWith('item:') || !a.target) continue;
    for (const [t, mod] of removes.get(a.target) ?? []) {
      // At the instant it landed or just after, never before (#510 review: a removal that came first is not its doing).
      if (t < a.t || t - a.t > DISPEL_SECONDS || mod === a.modifier || mod.includes(source.split(':')[1])) continue;
      db.removals ??= {};
      const r = ((db.removals[source] ??= {})[mod] ??= { removed: 0, games: 0, on: { self: 0, ally_hero: 0, enemy_hero: 0 } });
      r.removed += 1;
      if (a.side in r.on) r.on[a.side] += 1;
      const k = `${source}|${mod}`;
      if (!removedHere.has(k)) { removedHere.add(k); r.games += 1; }
    }
  }
  db.games.push(matchId);
  console.error(`${matchId}: ${adds.length} modifier adds, ${linked.size} linked to a cast, ${intervals.length} with an end`);
}

db.games.sort((a, b) => Number(a) - Number(b));
db.sources = Object.fromEntries(Object.entries(db.sources).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(out, `${JSON.stringify(db, null, 0)}\n`);
console.error('unit_state bits vs controls flags (samples):', JSON.stringify(agree));
