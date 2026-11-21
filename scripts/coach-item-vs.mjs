#!/usr/bin/env node
/**
 * Regenerates lib/coach/data/item-vs.json: the finished items pro players on
 * hero h buy *more than usual* when hero v is on the enemy team — the
 * counter items pros actually reach for, measured, not curated.
 *
 * From OpenDota's SQL explorer over professional matches since the previous
 * patch began (same window as matchups.json). For each (h, v):
 *   rate  = games where h bought item k with v on the enemy team / those games
 *   base  = games where h bought k / all of h's games
 * kept only when the lift is real: 30+ games against v, rate at least 10
 * points above base, and at least two standard errors (of base) above it.
 * Top 4 per pair, biggest lift first:  item_vs[h][v] = [[key, rate, base, n], ...]
 *
 * Finished items only (built from a recipe and 2000+ gold, or a listed key
 * item such as Blink), so components never count as a choice. Available
 * items only: an item must have been bought in a pro match of the current
 * patch (same rule as coach-hero-items.mjs), so an item a patch removed —
 * still in names.json and in older games — is never suggested.
 *
 * About 130 queries. The coach engine is pure and never fetches; run this
 * after a patch:  node scripts/coach-item-vs.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { ALWAYS_KEY_ITEMS, KEY_ITEM_MIN_COST } from '../lib/coach/knowledge.js';

const NAMES = JSON.parse(readFileSync(new URL('../lib/coach/data/names.json', import.meta.url)));
const OUT = new URL('../lib/coach/data/item-vs.json', import.meta.url);
const get = async (url) => {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': 'dota2.ai data refresh' } });
    const body = await res.json().catch(() => null);
    if (res.ok && !body?.err) return body;
    if (body?.err && res.status !== 429 && !/timeout/i.test(body.err)) throw new Error(`${url.slice(0, 120)}: ${body.err}`);
    await new Promise((r) => setTimeout(r, res.status === 429 ? 30000 : 3000 * (attempt + 1)));
  }
  throw new Error(`${url.slice(0, 160)} failed`);
};
const sql = async (q) => (await get(`https://api.opendota.com/api/explorer?sql=${encodeURIComponent(q)}`)).rows;

const MIN_GAMES = 30;
const MIN_LIFT = 0.10;
const TOP = 4;

const patches = await get('https://api.opendota.com/api/constants/patch');
const current = patches.at(-1);
const previous = patches.at(-2);
const since = Math.floor(Date.parse(previous.date) / 1000);
const currentSince = Math.floor(Date.parse(current.date) / 1000);
const available = new Set((await sql(`select distinct e->>'key' k
  from player_matches pm join matches m using(match_id), unnest(pm.purchase_log) e
  where m.start_time >= ${currentSince}`)).map((r) => r.k));
if (available.size < 50) throw new Error(`only ${available.size} items seen in ${current.name} pro matches: too early to tell what exists`);
const finished = Object.entries(NAMES.items)
  .filter(([k, it]) => !k.startsWith('recipe_') && available.has(k) && (ALWAYS_KEY_ITEMS.includes(k) || (it.built === true && it.cost >= KEY_ITEM_MIN_COST)))
  .map(([k]) => k);
const inList = finished.map((k) => `'${k}'`).join(',');
const heroIds = Object.keys(NAMES.heroes).map(Number).sort((a, b) => a - b);

// h's own games with a purchase log, and how often h buys each finished item.
const games = {};
for (const r of await sql(`select pm.hero_id h, count(distinct pm.match_id) n
  from matches m join player_matches pm using(match_id)
  where m.start_time >= ${since} and pm.purchase_log is not null group by 1`)) games[r.h] = Number(r.n);
const base = {};
for (let i = 0; i < heroIds.length; i += 8) {
  const batch = heroIds.slice(i, i + 8).join(',');
  for (const r of await sql(`select pm.hero_id h, e->>'key' k, count(distinct pm.match_id) c
    from matches m join player_matches pm using(match_id), unnest(pm.purchase_log) e
    where m.start_time >= ${since} and pm.hero_id in (${batch}) and e->>'key' in (${inList})
    group by 1, 2`)) (base[r.h] ??= {})[r.k] = Number(r.c);
  process.stdout.write(`base ${Math.min(i + 8, heroIds.length)}/${heroIds.length}\r`);
}
process.stdout.write('\n');

const out = {};
let kept = 0;
for (let i = 0; i < heroIds.length; i += 2) {
  const batch = heroIds.slice(i, i + 2).join(',');
  const pairs = {};
  for (const r of await sql(`select pm.hero_id h, b.hero_id v, count(distinct pm.match_id) n
    from matches m join player_matches pm on pm.match_id = m.match_id
    join player_matches b on b.match_id = m.match_id and (pm.player_slot < 128) <> (b.player_slot < 128)
    where m.start_time >= ${since} and pm.hero_id in (${batch}) and pm.purchase_log is not null
    group by 1, 2 having count(distinct pm.match_id) >= ${MIN_GAMES}`)) pairs[`${r.h}:${r.v}`] = Number(r.n);
  if (Object.keys(pairs).length) {
    const rows = await sql(`select pm.hero_id h, b.hero_id v, e->>'key' k, count(distinct pm.match_id) c
      from matches m join player_matches pm on pm.match_id = m.match_id
      join player_matches b on b.match_id = m.match_id and (pm.player_slot < 128) <> (b.player_slot < 128),
      unnest(pm.purchase_log) e
      where m.start_time >= ${since} and pm.hero_id in (${batch}) and e->>'key' in (${inList})
      group by 1, 2, 3 having count(distinct pm.match_id) >= 5`);
    const lifts = {};
    for (const r of rows) {
      const n = pairs[`${r.h}:${r.v}`];
      const all = games[r.h];
      if (!n || !all) continue;
      const rate = Number(r.c) / n;
      const b = (base[r.h]?.[r.k] ?? 0) / all;
      const se = Math.sqrt((b * (1 - b)) / n);
      if (rate - b >= MIN_LIFT && rate - b >= 2 * se) {
        (lifts[`${r.h}:${r.v}`] ??= []).push([r.k, +rate.toFixed(3), +b.toFixed(3), n]);
      }
    }
    for (const [key, list] of Object.entries(lifts)) {
      const [h, v] = key.split(':');
      list.sort((a, b) => (b[1] - b[2]) - (a[1] - a[2]));
      (out[h] ??= {})[v] = list.slice(0, TOP);
      kept += Math.min(TOP, list.length);
    }
  }
  process.stdout.write(`pairs ${Math.min(i + 2, heroIds.length)}/${heroIds.length}\r`);
}
process.stdout.write('\n');

writeFileSync(OUT, `${JSON.stringify({
  source: `OpenDota SQL explorer, professional matches; finished items seen in ${current.name} pro matches`,
  fetched: new Date().toISOString().slice(0, 10),
  patch: NAMES.patch,
  since: previous.name,
  since_time: since,
  available_in: current.name,
  rule: { min_games: MIN_GAMES, min_lift: MIN_LIFT, se: 2, top: TOP },
  item_vs: out,
})}\n`);
console.log(`item-vs: ${kept} item lifts across ${Object.keys(out).length} heroes since ${previous.name}`);
