#!/usr/bin/env node
/**
 * Regenerates lib/coach/data/abilities.json: each hero's ultimate (key,
 * English + Chinese name, cooldown per level) from Valve's public datafeed,
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

const ultimates = {};
for (const id of Object.keys(NAMES.heroes)) {
  const [en, zh] = [await feed(id, 'english'), await feed(id, 'schinese')];
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
writeFileSync(OUT, `${JSON.stringify({ source: 'Valve datafeed herodata + OpenDota constants', patch: NAMES.patch, ultimates, dmg_types }, null, 0)}\n`);
console.log(`wrote ${Object.keys(ultimates).length} ultimates, ${Object.keys(dmg_types).length} damage types`);
