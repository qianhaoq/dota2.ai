#!/usr/bin/env node
/**
 * Regenerates lib/coach/data/matchups.json: hero-vs-hero numbers from
 * professional matches since the previous patch began (OpenDota SQL
 * explorer), so the coach can say whether a lane or a matchup was hard
 * *before* the game, not only that it was lost.
 *
 * - `base[h]`  = [games, wins] for hero h.
 * - `vs[h][v]` = [games, wins] for h with v on the enemy team (n >= 15 kept).
 * - `lane[h][v]` = h's lane core against v's lane core in the same lane:
 *   [games, mean gold diff at 10:00, 25th percentile, 75th percentile,
 *    games h was ahead, standard deviation]  (n >= 10 kept).
 *   A lane's core is the player with the most last hits at 10:00 on that
 *   team in that lane (supports and roamers are not compared).
 *
 * `start_time` is a literal: the explorer cannot use its index on an
 * expression and the query times out. Matches are scoped first to the
 * batch's heroes so the window function stays small.
 *
 * About 60 queries. The coach engine is pure and never fetches; run this
 * after a patch:  node scripts/coach-matchups.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const NAMES = JSON.parse(readFileSync(new URL('../lib/coach/data/names.json', import.meta.url)));
const OUT = new URL('../lib/coach/data/matchups.json', import.meta.url);
const get = async (url) => {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': 'dota2.ai data refresh' } });
    const body = await res.json().catch(() => null);
    if (res.ok && !body?.err) return body;
    // A timeout is worth one more try; a syntax error is not.
    if (body?.err && res.status !== 429 && !/timeout/i.test(body.err)) throw new Error(`${url.slice(0, 120)}: ${body.err}`);
    await new Promise((r) => setTimeout(r, res.status === 429 ? 30000 : 3000 * (attempt + 1)));
  }
  throw new Error(`${url.slice(0, 160)} failed`);
};
const sql = async (q) => (await get(`https://api.opendota.com/api/explorer?sql=${encodeURIComponent(q)}`)).rows;

const patches = await get('https://api.opendota.com/api/constants/patch');
const previous = patches.at(-2);
const since = Math.floor(Date.parse(previous.date) / 1000);
const heroIds = Object.keys(NAMES.heroes).map(Number).sort((a, b) => a - b);
const WIN = '(case when (p.player_slot < 128) = m.radiant_win then 1 else 0 end)';

const [{ games }] = await sql(`select count(*) games from matches m where m.start_time >= ${since}`);

const base = {};
for (const r of await sql(`select p.hero_id h, count(*) n, sum(${WIN}) w
  from matches m join player_matches p using(match_id) where m.start_time >= ${since} group by 1`)) {
  base[r.h] = [Number(r.n), Number(r.w)];
}

const vs = {};
for (let i = 0; i < heroIds.length; i += 8) {
  const batch = heroIds.slice(i, i + 8).join(',');
  const rows = await sql(`select p.hero_id h, b.hero_id v, count(*) n, sum(${WIN}) w
    from matches m join player_matches p on p.match_id = m.match_id
    join player_matches b on b.match_id = m.match_id and (p.player_slot < 128) <> (b.player_slot < 128)
    where m.start_time >= ${since} and p.hero_id in (${batch})
    group by 1, 2 having count(*) >= 15`);
  for (const r of rows) (vs[r.h] ??= {})[r.v] = [Number(r.n), Number(r.w)];
  process.stdout.write(`vs ${Math.min(i + 8, heroIds.length)}/${heroIds.length}\r`);
}
process.stdout.write('\n');

const lane = {};
for (let i = 0; i < heroIds.length; i += 3) {
  const batch = heroIds.slice(i, i + 3).join(',');
  const rows = await sql(`with ms as (
      select m.match_id from matches m join player_matches p using(match_id)
      where m.start_time >= ${since} and p.hero_id in (${batch})
    ), c as (
      select pm.match_id, pm.hero_id, pm.player_slot < 128 rad, pm.lane, pm.gold_t[11] g,
        row_number() over (partition by pm.match_id, pm.player_slot < 128, pm.lane order by pm.lh_t[11] desc nulls last) r
      from player_matches pm
      where pm.match_id in (select match_id from ms) and pm.lane_role in (1, 2, 3) and array_length(pm.gold_t, 1) > 10
    )
    select a.hero_id h, b.hero_id v, count(*) n, round(avg(a.g - b.g)) mean,
      round(percentile_cont(0.25) within group (order by a.g - b.g)) p25,
      round(percentile_cont(0.75) within group (order by a.g - b.g)) p75,
      sum(case when a.g > b.g then 1 else 0 end) ahead, round(stddev_samp(a.g - b.g)) sd
    from c a join c b on b.match_id = a.match_id and b.lane = a.lane and b.rad <> a.rad
    where a.r = 1 and b.r = 1 and a.hero_id in (${batch})
    group by 1, 2 having count(*) >= 10`);
  for (const r of rows) {
    (lane[r.h] ??= {})[r.v] = [r.n, r.mean, r.p25, r.p75, r.ahead, r.sd].map(Number);
  }
  process.stdout.write(`lane ${Math.min(i + 3, heroIds.length)}/${heroIds.length}\r`);
}
process.stdout.write('\n');

writeFileSync(OUT, `${JSON.stringify({
  source: 'OpenDota SQL explorer, professional matches',
  fetched: new Date().toISOString().slice(0, 10),
  patch: NAMES.patch,
  since: previous.name,
  since_time: since,
  games: Number(games),
  base, vs, lane,
})}\n`);
console.log(`matchups: ${games} games since ${previous.name}; vs for ${Object.keys(vs).length} heroes, lane for ${Object.keys(lane).length}`);
