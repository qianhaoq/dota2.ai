#!/usr/bin/env node
/**
 * Refresh lib/coach/data/names.json after a Dota 2 patch.
 *
 *   node scripts/coach-names.mjs 7.42
 *
 * Names come from Valve's datafeed (schinese + English), ids/costs/roles from
 * OpenDota constants. Entries are merged, never dropped: matches from older
 * patches still reference items that a new patch removed.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../lib/coach/data/names.json', import.meta.url);
const patch = process.argv[2];
if (!/^\d+\.\d+[a-z]?$/.test(patch ?? '')) {
  console.error('usage: node scripts/coach-names.mjs <patch, e.g. 7.42>');
  process.exit(2);
}

const get = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': 'dota2.ai names refresh' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
};

const [vItems, vHeroes, odItems, odHeroes] = await Promise.all([
  get('https://www.dota2.com/datafeed/itemlist?language=schinese'),
  get('https://www.dota2.com/datafeed/herolist?language=schinese'),
  get('https://api.opendota.com/api/constants/items'),
  get('https://api.opendota.com/api/constants/heroes'),
]);

const names = JSON.parse(readFileSync(FILE, 'utf8'));
// Valve's own English and Chinese names win; OpenDota's display names can lag or differ.
const vItem = new Map(vItems.result.data.itemabilities.map((x) => [x.name.replace(/^item_/, ''), x]));
const vHero = new Map(vHeroes.result.data.heroes.map((h) => [h.id, h]));
const VALVE_ATTR = ['str', 'agi', 'int', 'all'];

let added = 0;
let changed = 0;
const note = (prev, next) => {
  if (!prev) added++;
  else if (JSON.stringify(prev) !== JSON.stringify(next)) changed++;
};

for (const [key, it] of Object.entries(odItems)) {
  // Only items Valve still lists and OpenDota can name.
  if (!it?.dname || !vItem.has(key)) continue;
  const v = vItem.get(key);
  const prev = names.items[key];
  const next = {
    id: it.id,
    en: v.name_english_loc || it.dname,
    // Valve leaves brand-new items untranslated for a while; fall back to English.
    zh: v.name_loc || v.name_english_loc || it.dname,
    cost: it.cost || prev?.cost || 0,
    // Built from a recipe (Blink is bought outright, so it is not): tells a
    // finished item from a component on a purchase timeline.
    ...(it.created ? { built: true } : {}),
  };
  note(prev, next);
  names.items[key] = next;
}

for (const h of Object.values(odHeroes)) {
  const id = String(h.id);
  const prev = names.heroes[id];
  const v = vHero.get(h.id);
  const next = {
    en: v?.name_english_loc || h.localized_name,
    zh: v?.name_loc || prev?.zh || h.localized_name,
    slug: h.name.replace(/^npc_dota_hero_/, ''),
    roles: h.roles ?? [],
    attr: VALVE_ATTR[v?.primary_attr] ?? prev?.attr,
    attack: h.attack_type,
  };
  note(prev, next);
  names.heroes[id] = next;
}

names.fetched = new Date().toISOString().slice(0, 10);
names.patch = patch;
writeFileSync(FILE, JSON.stringify(names));
console.log(`names.json → ${patch}: ${added} added, ${changed} changed`);
