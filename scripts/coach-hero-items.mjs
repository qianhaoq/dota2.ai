#!/usr/bin/env node
/**
 * Regenerates lib/coach/data/hero-items.json: for each hero, the finished
 * items pro players buy most often in the mid game (OpenDota
 * /heroes/:id/itemPopularity, built from recent professional matches;
 * mid_game = purchased between 10:00 and 25:00).
 *
 * Only finished items count — a recipe-built item costing 2000+, plus Blink
 * Dagger — because the raw list is dominated by components (Staff of Wizardry,
 * Ogre Axe) that say nothing on their own.
 * The coach engine is pure and never fetches; run this after a patch:
 *   node scripts/coach-hero-items.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const NAMES = JSON.parse(readFileSync(new URL('../lib/coach/data/names.json', import.meta.url)));
const OUT = new URL('../lib/coach/data/hero-items.json', import.meta.url);
const get = async (url) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': 'dota2.ai data refresh' } });
    if (res.ok) return res.json();
    // 429: the per-minute budget is spent; wait for the next minute.
    await new Promise((r) => setTimeout(r, res.status === 429 ? 30000 : 2000 * (attempt + 1)));
  }
  throw new Error(`${url} failed`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const items = await get('https://api.opendota.com/api/constants/items');
const keyById = new Map(Object.entries(items).map(([k, v]) => [String(v.id), k]));
const finished = (k) => k === 'blink'
  || (Array.isArray(items[k]?.components) && items[k].components.length > 0 && (items[k].cost ?? 0) >= 2000);

const heroes = {};
for (const id of Object.keys(NAMES.heroes)) {
  const pop = await get(`https://api.opendota.com/api/heroes/${id}/itemPopularity`);
  const mid = Object.entries(pop.mid_game_items ?? {})
    .map(([itemId, n]) => ({ key: keyById.get(itemId), n: Number(n) }))
    .filter((x) => x.key && finished(x.key) && x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);
  if (mid.length) heroes[id] = mid;
  await sleep(1500); // OpenDota's free tier: 60 requests a minute, with headroom
}
writeFileSync(OUT, `${JSON.stringify({
  source: 'OpenDota /heroes/:id/itemPopularity (professional matches), mid_game = 10:00-25:00, finished items only',
  fetched: new Date().toISOString().slice(0, 10),
  patch: NAMES.patch,
  // Every finished item (same rule), so the engine can tell a finished item
  // from a component in a player's purchase log.
  finished: Object.keys(items).filter(finished).sort(),
  heroes,
}, null, 0)}\n`);
console.log(`wrote mid-game items for ${Object.keys(heroes).length} heroes`);
