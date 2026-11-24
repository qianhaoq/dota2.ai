#!/usr/bin/env node
/**
 * Refresh every build-time data snapshot after a Dota 2 patch, so the server
 * makes no constants requests at runtime:
 *
 *   node scripts/refresh-data.mjs            # OpenDota constants only
 *   node scripts/refresh-data.mjs --all      # + coach names, abilities, pro items
 *
 * Writes lib/data/constants/{heroes,items,abilities}.json (OpenDota
 * /constants/*; abilities trimmed to the fields the server reads) and
 * meta.json (patch + date). `--all` also runs
 * scripts/coach-names.mjs <patch>, coach-abilities.mjs and coach-hero-items.mjs,
 * and coach-patch-snapshots.mjs (the item and ability data of each finished
 * patch, so an older game is told its own prices: needs github.com).
 * Uses OPENDOTA_API_KEY when set (higher limits); the key is never written.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('../lib/data/constants/', import.meta.url);
const key = process.env.OPENDOTA_API_KEY || '';
const get = async (name) => {
  const url = `https://api.opendota.com/api/constants/${name}${key ? `?api_key=${encodeURIComponent(key)}` : ''}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': 'dota2.ai data refresh' } });
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, res.status === 429 ? 30000 : 2000 * (attempt + 1)));
  }
  throw new Error(`constants/${name} failed`);
};

mkdirSync(OUT, { recursive: true });
const patches = await get('patch');
const patch = patches.at(-1)?.name;
// Abilities: only the fields the server reads (/api/meta/abilities and hero
// detail). The rest (attrib tables etc.) is 1MB+ the server never uses.
const ABILITY_FIELDS = ['dname', 'desc', 'lore', 'img', 'behavior', 'dmg_type', 'bkbpierce', 'dispellable', 'cd', 'mc'];
const prune = {
  abilities: (all) => Object.fromEntries(Object.entries(all).map(([k, a]) => [k,
    Object.fromEntries(ABILITY_FIELDS.filter((f) => a?.[f] !== undefined).map((f) => [f, a[f]]))])),
};
for (const name of ['heroes', 'items', 'abilities']) {
  const data = prune[name] ? prune[name](await get(name)) : await get(name);
  if (!data || typeof data !== 'object' || Object.keys(data).length < 100) throw new Error(`constants/${name}: suspiciously small`);
  writeFileSync(new URL(`${name}.json`, OUT), `${JSON.stringify(data)}\n`);
  console.log(`constants/${name}: ${Object.keys(data).length} entries`);
}
writeFileSync(new URL('meta.json', OUT), `${JSON.stringify({ source: 'OpenDota /constants', patch, fetched: new Date().toISOString().slice(0, 10) }, null, 2)}\n`);

if (process.argv.includes('--all')) {
  const run = (script, ...args) => execFileSync(process.execPath, [new URL(script, import.meta.url).pathname, ...args], { stdio: 'inherit' });
  run('./coach-names.mjs', patch);
  run('./coach-abilities.mjs');
  run('./coach-hero-items.mjs');
  run('./coach-patch-snapshots.mjs');
}
console.log(`snapshot for ${patch} written`);
