#!/usr/bin/env node
/**
 * Regenerates lib/coach/data/pro-items-by-release.json: for each letter
 * release the site has data for (lib/data/constants/patches/index.json) and
 * each hero, the professional games played on that release and how many of
 * them bought each finished item in the mid game (10:00–24:59).
 *
 * - A game counts for a release only when it started after that release had
 *   surely rolled out (rollout_by) and before the next one might have
 *   (rollout_from): the twenty minutes in between are not told.
 * - "Finished" is judged with that release's own item data (built from a
 *   recipe and 2000+ gold, plus Blink Dagger), so an item that was cheaper or
 *   had no recipe then is judged as it was.
 * - Every finished item bought is kept, not a top few: the review agent sums
 *   neighbouring releases of a patch when one alone has too few games, and a
 *   cut list would not add up.
 *
 * From OpenDota's SQL explorer (its `matches` are professional matches),
 * about 70 queries. The coach engine is pure and never fetches; run this
 * after a release:  node scripts/coach-pro-items-by-release.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PATCHES = new URL('../lib/data/constants/patches/', import.meta.url);
const INDEX = JSON.parse(readFileSync(new URL('index.json', PATCHES)));
const NAMES = JSON.parse(readFileSync(new URL('../lib/coach/data/names.json', import.meta.url)));
const OUT = new URL('../lib/coach/data/pro-items-by-release.json', import.meta.url);
const MID_GAME = [600, 1499];
const HEROES_PER_QUERY = 4;

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

const epoch = (iso) => Math.floor(Date.parse(iso) / 1000);
const releases = [...INDEX.releases].sort((a, b) => epoch(a.rollout_by) - epoch(b.rollout_by)).map((r, i, all) => ({
  name: r.name, major: r.major,
  from: epoch(r.rollout_by),
  // The newest release runs until now.
  to: all[i + 1] ? epoch(all[i + 1].rollout_from) : null,
  items: JSON.parse(readFileSync(new URL(r.data, PATCHES))).items,
}));
const finishedIn = (items, k) => k === 'blink' || (Array.isArray(items[k]?.components) && items[k].components.length > 0 && (items[k].cost ?? 0) >= 2000);
const anyFinished = [...new Set(releases.flatMap((r) => Object.keys(r.items).filter((k) => finishedIn(r.items, k))))].sort();
if (!/^[a-z0-9_]+$/.test(anyFinished.join(''))) throw new Error('unexpected item key');

// Which release a pro game belongs to, in SQL; null in a rollout window or before the first release.
const releaseOf = `case ${releases.map((r) => `when m.start_time >= ${r.from}${r.to ? ` and m.start_time < ${r.to}` : ''} then '${r.name}'`).join(' ')} end`;
const first = releases[0].from;

const games = {}; // release -> hero -> games
const bought = {}; // release -> hero -> item -> games
const heroIds = Object.keys(NAMES.heroes).map(Number).sort((a, b) => a - b);
for (const r of await sql(`select ${releaseOf} r, pm.hero_id h, count(distinct pm.match_id) n
  from matches m join player_matches pm using(match_id)
  where m.start_time >= ${first} and pm.purchase_log is not null group by 1, 2`)) {
  if (r.r) (games[r.r] ??= {})[r.h] = Number(r.n);
}
for (let i = 0; i < heroIds.length; i += HEROES_PER_QUERY) {
  const batch = heroIds.slice(i, i + HEROES_PER_QUERY).join(',');
  for (const r of await sql(`select ${releaseOf} r, pm.hero_id h, e->>'key' k, count(distinct pm.match_id) c
    from matches m join player_matches pm using(match_id), unnest(pm.purchase_log) e
    where m.start_time >= ${first} and pm.hero_id in (${batch})
      and (e->>'time')::int between ${MID_GAME[0]} and ${MID_GAME[1]}
      and e->>'key' in (${anyFinished.map((k) => `'${k}'`).join(',')})
    group by 1, 2, 3`)) {
    if (r.r) ((bought[r.r] ??= {})[r.h] ??= {})[r.k] = Number(r.c);
  }
  process.stdout.write(`items ${Math.min(i + HEROES_PER_QUERY, heroIds.length)}/${heroIds.length}\r`);
  await new Promise((r) => setTimeout(r, 1200));
}
process.stdout.write('\n');

const out = releases.map((r) => {
  const heroes = {};
  for (const [h, n] of Object.entries(games[r.name] ?? {})) {
    const items = Object.entries(bought[r.name]?.[h] ?? {}).filter(([k]) => finishedIn(r.items, k)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    heroes[h] = { games: n, items };
  }
  return { name: r.name, major: r.major, from: new Date(r.from * 1000).toISOString(), to: r.to ? new Date(r.to * 1000).toISOString() : null, // Ten heroes a game: the hero games over ten (a game without purchase logs for all ten counts as less).
    pro_games: Math.round(Object.values(games[r.name] ?? {}).reduce((a, n) => a + n, 0) / 10), heroes };
});

writeFileSync(OUT, `${JSON.stringify({
  source: 'OpenDota SQL explorer, professional matches, each counted in the letter release it was played on (lib/data/constants/patches/index.json)',
  fetched: new Date().toISOString().slice(0, 10),
  window: 'bought between 10:00 and 24:59',
  finished_rule: 'built from a recipe and 2000+ gold in that release, or Blink Dagger',
  releases: out,
})}\n`);
console.log(out.map((r) => `${r.name}: ~${r.pro_games} games, ${Object.keys(r.heroes).length} heroes`).join('\n'));
