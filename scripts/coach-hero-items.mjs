#!/usr/bin/env node
/**
 * Regenerates lib/coach/data/hero-items.json: for each hero, the finished
 * items pro players buy in the mid game (purchased 10:00–24:59), as a share
 * of that hero's pro games — from OpenDota's SQL explorer over professional
 * matches since the previous patch began (enough games per hero; the
 * current patch alone is days old after a release).
 *
 * - Finished items only: built from a recipe and costing 2000+, plus Blink
 *   Dagger. The raw purchase list is dominated by components.
 * - Available items only: an item must have been bought in a pro match of the
 *   current patch, so an item a patch removed (still in the constants and in
 *   older games) is never recommended.
 * - `parts`: each listed item's recursive components, so the engine never
 *   calls progress toward an item (Helm of the Dominator → Overlord) an
 *   alternative to it.
 *
 * About 20 queries in all. The coach engine is pure and never fetches; run
 * this after a patch:  node scripts/coach-hero-items.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const NAMES = JSON.parse(readFileSync(new URL('../lib/coach/data/names.json', import.meta.url)));
const OUT = new URL('../lib/coach/data/hero-items.json', import.meta.url);
const get = async (url) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': 'dota2.ai data refresh' } });
    const body = await res.json().catch(() => null);
    if (res.ok && !body?.err) return body;
    // The explorer answers a query it cannot run (timeout, syntax) with an error body.
    if (body?.err && res.status !== 429) throw new Error(`${url.slice(0, 120)}: ${body.err}`);
    // 429: the per-minute budget is spent; wait for the next minute.
    await new Promise((r) => setTimeout(r, res.status === 429 ? 30000 : 2000 * (attempt + 1)));
  }
  throw new Error(`${url} failed`);
};
const sql = async (q) => (await get(`https://api.opendota.com/api/explorer?sql=${encodeURIComponent(q)}`)).rows;

const [items, patches] = [await get('https://api.opendota.com/api/constants/items'), await get('https://api.opendota.com/api/constants/patch')];
const current = patches.at(-1);
const previous = patches.at(-2);
const epoch = (p) => Math.floor(Date.parse(p.date) / 1000);
const since = epoch(previous);
const currentSince = epoch(current);

const finished = (k) => k === 'blink'
  || (Array.isArray(items[k]?.components) && items[k].components.length > 0 && (items[k].cost ?? 0) >= 2000);
const partsOf = (k, seen = new Set()) => {
  for (const c of items[k]?.components ?? []) {
    if (!seen.has(c)) { seen.add(c); partsOf(c, seen); }
  }
  return seen;
};

const games = new Map((await sql(`select pm.hero_id h, count(distinct pm.match_id) g
  from player_matches pm join matches m using(match_id)
  where m.start_time >= ${since} and pm.purchase_log is not null group by 1`)).map((r) => [String(r.h), Number(r.g)]));
// One query for every hero times out on the explorer: a few heroes at a time.
const bought = [];
const ids = [...games.keys()];
for (let i = 0; i < ids.length; i += 8) {
  bought.push(...await sql(`select pm.hero_id h, e->>'key' k, count(distinct pm.match_id) c
    from player_matches pm join matches m using(match_id), unnest(pm.purchase_log) e
    where m.start_time >= ${since} and pm.hero_id in (${ids.slice(i, i + 8).join(',')})
      and (e->>'time')::int between 600 and 1499 group by 1, 2`));
  await new Promise((r) => setTimeout(r, 1500));
}
const available = new Set((await sql(`select distinct e->>'key' k
  from player_matches pm join matches m using(match_id), unnest(pm.purchase_log) e
  where m.start_time >= ${currentSince}`)).map((r) => r.k));
if (available.size < 50) throw new Error(`only ${available.size} items seen in ${current.name} pro matches: too early to tell what exists`);

const heroes = {};
const parts = {};
for (const id of Object.keys(NAMES.heroes)) {
  const g = games.get(id) ?? 0;
  if (!g) continue;
  const list = bought.filter((r) => String(r.h) === id && finished(r.k) && available.has(r.k))
    .map((r) => ({ key: r.k, n: Number(r.c) }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);
  if (!list.length) continue;
  heroes[id] = { games: g, items: list };
  for (const x of list) parts[x.key] = [...partsOf(x.key)].sort();
}
writeFileSync(OUT, `${JSON.stringify({
  source: `OpenDota explorer, professional matches since ${previous.name} (${previous.date.slice(0, 10)}); mid game = bought 10:00-24:59; finished items seen in ${current.name} pro matches`,
  fetched: new Date().toISOString().slice(0, 10),
  patch: NAMES.patch,
  finished: Object.keys(items).filter(finished).sort(),
  parts,
  heroes,
}, null, 0)}\n`);
console.log(`wrote mid-game items for ${Object.keys(heroes).length} heroes; ${available.size} items seen in ${current.name}`);
