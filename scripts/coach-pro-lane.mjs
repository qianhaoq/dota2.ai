#!/usr/bin/env node
/**
 * Regenerates lib/coach/data/hero-pro-lane.json: how professional players
 * open the game on each hero, by OpenDota's lane role (1 safe lane, 2 mid,
 * 3 off lane, 4 jungle) — from OpenDota's SQL explorer over professional
 * matches since the previous patch began (same window as hero-items.json).
 *
 * - skills: the hero's first ten skill points (ability_upgrades_arr), as the
 *   share of games taking each ability at each level 1–10, the three most
 *   common orders, and the level of the first ultimate point;
 * - early_items: items bought before 10:00, as the share of games buying
 *   each at least once, with the median minute of those purchases.
 *
 * Professional matches only, and not the player's bracket: the tools that
 * read this say so. Ability ids are OpenDota's (constants/ability_ids).
 * About 35 queries. The engine never fetches; run after a patch:
 *   node scripts/coach-pro-lane.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const NAMES = JSON.parse(readFileSync(new URL('../lib/coach/data/names.json', import.meta.url)));
const ULTIMATES = JSON.parse(readFileSync(new URL('../lib/coach/data/abilities.json', import.meta.url))).ultimates;
const OUT = new URL('../lib/coach/data/hero-pro-lane.json', import.meta.url);
const get = async (url) => {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': 'dota2.ai data refresh' } });
    const body = await res.json().catch(() => null);
    if (res.ok && !body?.err) return body;
    if (body?.err && res.status !== 429) throw new Error(`${url.slice(0, 120)}: ${body.err}`);
    await new Promise((r) => setTimeout(r, res.status === 429 ? 30000 : 2000 * (attempt + 1)));
  }
  throw new Error(`${url} failed`);
};
const sql = async (q) => (await get(`https://api.opendota.com/api/explorer?sql=${encodeURIComponent(q)}`)).rows;

const [abilityIds, patches] = [await get('https://api.opendota.com/api/constants/ability_ids'), await get('https://api.opendota.com/api/constants/patch')];
const previous = patches.at(-2); const current = patches.at(-1);
const epoch = (p) => Math.floor(Date.parse(p.date) / 1000);
const since = epoch(previous);
const LEVELS = 10;
const ids = Object.keys(NAMES.heroes);

const games = await sql(`select pm.hero_id h, pm.lane_role r, count(*) g, count(*) filter (where m.start_time >= ${epoch(current)}) gc
  from player_matches pm join matches m using(match_id)
  where m.start_time >= ${since} and pm.ability_upgrades_arr is not null and pm.lane_role between 1 and 4 group by 1, 2`);
const seqs = []; const buys = [];
for (let i = 0; i < ids.length; i += 10) {
  const chunk = ids.slice(i, i + 10).join(',');
  seqs.push(...await sql(`select pm.hero_id h, pm.lane_role r, array_to_string(pm.ability_upgrades_arr[1:${LEVELS}], ',') s, count(*) n
    from player_matches pm join matches m using(match_id)
    where m.start_time >= ${since} and pm.hero_id in (${chunk}) and pm.ability_upgrades_arr is not null and pm.lane_role between 1 and 4 group by 1, 2, 3`));
  await new Promise((r) => setTimeout(r, 1500));
  buys.push(...await sql(`select pm.hero_id h, pm.lane_role r, e->>'key' k, count(distinct pm.match_id) n,
      percentile_cont(0.5) within group (order by (e->>'time')::int) t
    from player_matches pm join matches m using(match_id), unnest(pm.purchase_log) e
    where m.start_time >= ${since} and pm.hero_id in (${chunk}) and pm.lane_role between 1 and 4 and pm.purchase_log is not null
      and (e->>'time')::int < 600 group by 1, 2, 3`));
  await new Promise((r) => setTimeout(r, 1500));
}

const key = (id) => abilityIds[String(id)] ?? null;
const r3 = (x) => Math.round(x * 1000) / 1000;
const heroes = {};
for (const row of games) {
  const h = String(row.h); const r = String(row.r); const g = Number(row.g);
  if (g < 1) continue;
  const mine = seqs.filter((x) => String(x.h) === h && String(x.r) === r);
  const byLevel = Array.from({ length: LEVELS }, () => new Map());
  const firstUlt = new Map(); let counted = 0;
  const orders = new Map();
  for (const x of mine) {
    const n = Number(x.n); const order = String(x.s).split(',').map(Number).map(key);
    if (order.length < LEVELS || order.some((k) => !k)) continue;
    counted += n;
    order.forEach((k, i) => byLevel[i].set(k, (byLevel[i].get(k) ?? 0) + n));
    orders.set(order.join(','), (orders.get(order.join(',')) ?? 0) + n);
    // The hero's ultimate as the site's ability table names it; the level of its first point, or none by level 10.
    const at = order.indexOf(ULTIMATES[h]?.key);
    const ult = at >= 0 ? at + 1 : null;
    firstUlt.set(String(ult ?? 'not_by_10'), (firstUlt.get(String(ult ?? 'not_by_10')) ?? 0) + n);
  }
  if (!counted) continue;
  const items = buys.filter((x) => String(x.h) === h && String(x.r) === r)
    .map((x) => ({ key: x.k, share: r3(Number(x.n) / g), median_minute: Math.round(Number(x.t) / 6) / 10 }))
    .filter((x) => x.share >= 0.1).sort((a, b) => b.share - a.share).slice(0, 15);
  (heroes[h] ??= {})[r] = {
    games: counted, games_current_patch: Number(row.gc),
    by_level: byLevel.map((m) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, r3(n / counted)]))),
    top_orders: [...orders].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([o, n]) => ({ order: o.split(','), games: n })),
    // Share of games by the level of the first ultimate point ('not_by_10': none in the first ten).
    ultimate_first_at: Object.fromEntries([...firstUlt].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, r3(n / counted)])),
    early_items: items,
  };
}
writeFileSync(OUT, `${JSON.stringify({
  source: `OpenDota explorer, professional matches since ${previous.name} (${previous.date.slice(0, 10)}); lane_role is OpenDota's (1 safe, 2 mid, 3 off, 4 jungle); skills = ability_upgrades_arr[1:${LEVELS}]; early items = purchase_log before 10:00`,
  since: previous.name, current_patch: current.name, fetched: new Date().toISOString().slice(0, 10), heroes,
})}\n`);
console.log(`heroes ${Object.keys(heroes).length}, hero-roles ${Object.values(heroes).reduce((a, x) => a + Object.keys(x).length, 0)}`);
