#!/usr/bin/env node
/**
 * Regenerates lib/coach/data/abilities.json: each hero's ultimate (key,
 * English + Chinese name, cooldown per level) from Valve's public datafeed,
 * each hero's castable abilities with Valve's own flags (damage type, whether
 * they pierce spell immunity, how they can be dispelled) for the "why"
 * explanations,
 * and every hero ability's damage type (P/M/U = physical/magical/pure) from
 * OpenDota constants — used to split the damage a player took by type.
 * The coach engine is pure and never fetches; run this when a patch lands:
 *   node scripts/coach-abilities.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const NAMES = JSON.parse(readFileSync(new URL('../lib/coach/data/names.json', import.meta.url)));
const OUT = new URL('../lib/coach/data/abilities.json', import.meta.url);
const feed = async (id, language) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://www.dota2.com/datafeed/herodata?language=${language}&hero_id=${id}`);
    if (res.ok) return (await res.json()).result.data.heroes[0];
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error(`datafeed ${id}/${language} failed`);
};

// Valve's enums (datafeed herodata): damage 1/2/4 = physical/magical/pure;
// immunity 3 = ENEMIES_YES (pierces spell immunity), 4 = ENEMIES_NO;
// dispellable 1 = strong dispels only, 2 = any dispel, 3 = cannot be dispelled
// (per modifier, not per ability: stored, never shown as a whole-ability fact).
const DMG = { 1: 'P', 2: 'M', 4: 'U' };
const PIERCE = { 3: true, 4: false };
const DISPEL = { 1: 'strong', 2: 'basic', 3: 'no' };
const ultimates = {};
const heroes = {};
for (const id of Object.keys(NAMES.heroes)) {
  const [en, zh] = [await feed(id, 'english'), await feed(id, 'schinese')];
  heroes[id] = en.abilities
    .filter((a) => a.name_loc && !a.name.startsWith('generic') && !a.ability_is_innate
      && !a.ability_is_granted_by_scepter && !a.ability_is_granted_by_shard)
    .map((a) => {
      const z = zh.abilities.find((x) => x.name === a.name);
      return {
        id: a.name, en: a.name_loc, zh: z?.name_loc || a.name_loc,
        ...(a.type === 1 ? { ult: true } : {}),
        ...(DMG[a.damage] ? { dmg: DMG[a.damage] } : {}),
        ...(a.immunity in PIERCE ? { pierces: PIERCE[a.immunity] } : {}),
        ...(DISPEL[a.dispellable] ? { dispel: DISPEL[a.dispellable] } : {}),
      };
    });
  const ult = en.abilities.find((a) => a.type === 1);
  if (!ult) continue;
  const zhUlt = zh.abilities.find((a) => a.name === ult.name);
  ultimates[id] = { key: ult.name, en: ult.name_loc, zh: zhUlt?.name_loc ?? ult.name_loc, cd: ult.cooldowns };
}
const od = async (name) => (await fetch(`https://api.opendota.com/api/constants/${name}`)).json();
const [heroAbilities, abilities] = [await od('hero_abilities'), await od('abilities')];
// Passive ultimates are never "cast": the fight audit must skip them.
for (const u of Object.values(ultimates)) {
  const b = abilities[u.key]?.behavior;
  if ((Array.isArray(b) ? b : [b]).includes('Passive')) u.passive = true;
}
const DT = { Physical: 'P', Magical: 'M', Pure: 'U' };
const dmg_types = {};
for (const { abilities: list } of Object.values(heroAbilities)) {
  for (const key of list) {
    const code = DT[abilities[key]?.dmg_type];
    if (code) dmg_types[key] = code;
  }
}
// Merge, never drop: matches from older patches still reference abilities a
// later patch removed (e.g. juggernaut_swift_slash), and their damage must
// keep its type.
let previous = {};
try { previous = JSON.parse(readFileSync(OUT, 'utf8')); } catch { previous = {}; }
const merged = {
  ultimates: { ...(previous.ultimates ?? {}), ...ultimates },
  dmg_types: { ...(previous.dmg_types ?? {}), ...dmg_types },
  heroes: { ...(previous.heroes ?? {}), ...heroes },
};
writeFileSync(OUT, `${JSON.stringify({ source: 'Valve datafeed herodata + OpenDota constants', patch: NAMES.patch, ...merged }, null, 0)}\n`);
console.log(`wrote ${Object.keys(merged.ultimates).length} ultimates, ${Object.keys(merged.dmg_types).length} damage types (${Object.keys(dmg_types).length} current), ${Object.keys(merged.heroes).length} heroes' abilities`);
