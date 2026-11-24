#!/usr/bin/env node
/**
 * Regenerates lib/coach/data/hero-timing.json: each hero's win rate by how
 * long the game lasted, in public matches, per rank bracket, from STRATZ
 * (https://stratz.com — data credit required on every surface that shows it).
 *
 * Source: heroStats.stats(groupByTime: true). Per hero and minute t it gives
 * `matchCount` and `winCount`. Read here as "games of this hero that reached
 * minute t, and the wins among them" — checked on every run, not assumed:
 * both counts never rise with t, and they are the same at minute 8 as at
 * minute 0 for every hero (no game ends that early). A run where that does
 * not hold stops without writing.
 *
 * So for the cuts 35 and 45: games that ended before minute 35 are
 * count(0) - count(35), games that ended from 35 to 45 are
 * count(35) - count(45), and count(45) is the games that lasted 45 minutes
 * or more. STRATZ stops at minute 75; nothing here needs more.
 *
 * Per bracket b (hg, ca, la, di as in matchups-rank.json):
 *   heroes[b][h] = [[games, wins] under 35, [games, wins] 35 to 45, [games, wins] 45 or more]
 *
 * Window: the last N completed STRATZ weeks that lie wholly inside one
 * patch. STRATZ numbers its weeks from the unix epoch (week = floor(seconds /
 * 604800), so a week runs Thursday 00:00 UTC to Wednesday); the `week`
 * argument takes any second inside the week wanted. An in-progress week
 * returns partial data, so it is never used. Not filtered by game mode.
 *
 * One request per week (four brackets as aliases, every hero at once).
 * Needs STRATZ_API_TOKEN (never printed):
 *   STRATZ_API_TOKEN=... node scripts/coach-hero-timing.mjs [--weeks 4]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const TOKEN = process.env.STRATZ_API_TOKEN?.trim();
if (!TOKEN) { console.error('STRATZ_API_TOKEN is not set'); process.exit(2); }
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const WEEKS = Number(arg('weeks', 4));
const NAMES = JSON.parse(readFileSync(new URL('../lib/coach/data/names.json', import.meta.url)));
const OUT = new URL('../lib/coach/data/hero-timing.json', import.meta.url);

const BRACKETS = { hg: 'HERALD_GUARDIAN', ca: 'CRUSADER_ARCHON', la: 'LEGEND_ANCIENT', di: 'DIVINE_IMMORTAL' };
/** Minutes that split a game's length into three groups. */
const CUTS = [35, 45];
/** No game is over by this minute: the counts there must equal the counts at minute 0. */
const NOBODY_DONE_BY = 8;
const WEEK = 7 * 86400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (s) => new Date(s * 1000).toISOString().slice(0, 10);

// Patch windows (OpenDota constants), to keep every week inside one patch.
const patches = await (await fetch('https://api.opendota.com/api/constants/patch')).json();
const starts = patches.map((p) => ({ name: p.name, at: Math.floor(Date.parse(p.date) / 1000) })).sort((a, b) => a.at - b.at);
const patchAt = (s) => starts.filter((p) => p.at <= s).at(-1);

const now = Math.floor(Date.now() / 1000);
const current = Math.floor(now / WEEK) * WEEK;
const weeks = [];
let patch = null;
for (let w = current - WEEK; weeks.length < WEEKS && w > current - 60 * WEEK; w -= WEEK) {
  const a = patchAt(w); const b = patchAt(w + WEEK - 1);
  if (a.name !== b.name) { if (weeks.length) break; continue; } // a patch landed inside this week
  if (patch && a.name !== patch) break;
  patch = a.name;
  weeks.push(w);
}
if (!weeks.length) throw new Error('no completed week inside one patch');
console.error(`patch ${patch}, weeks starting ${weeks.map(iso).join(', ')}`);

const query = `query ($w: Long) { heroStats { ${Object.entries(BRACKETS).map(([k, b]) => `${k}: stats(week: $w, bracketBasicIds: [${b}], groupByTime: true, maxTime: 75) { heroId week time matchCount winCount }`).join(' ')} } }`;
async function fetchWeek(w) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await fetch('https://api.stratz.com/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'user-agent': 'STRATZ_API' },
      body: JSON.stringify({ query, variables: { w } }),
    });
    if (res.status === 429) { console.error('429 — waiting 60s'); await sleep(60000); continue; }
    if (res.status === 401 || res.status === 403) throw new Error(`STRATZ rejected the token (${res.status})`);
    const body = await res.json().catch(() => null);
    if (res.ok && body?.data?.heroStats && !body.errors) return body.data.heroStats;
    console.error(`week ${iso(w)}: HTTP ${res.status} ${body?.errors?.map((e) => e.message).join(' | ') ?? ''}`);
    await sleep(3000 * (attempt + 1));
  }
  throw new Error(`week ${iso(w)} failed`);
}

const known = new Set(Object.keys(NAMES.heroes).map(Number));
/** heroes[b][h] = [[games, wins] × 3] summed over the weeks. */
const heroes = Object.fromEntries(Object.keys(BRACKETS).map((k) => [k, {}]));
const games = Object.fromEntries(Object.keys(BRACKETS).map((k) => [k, 0]));
for (const w of weeks) {
  const data = await fetchWeek(w);
  for (const k of Object.keys(BRACKETS)) {
    const rows = data[k] ?? [];
    // The answer must be for the week asked for: STRATZ answers an unknown week with the current, unfinished one.
    const wrong = rows.find((r) => r.week !== Math.floor(w / WEEK));
    if (wrong) throw new Error(`week ${iso(w)} ${k}: STRATZ answered for week ${wrong.week}, not ${Math.floor(w / WEEK)}`);
    const byHero = new Map();
    for (const r of rows) { if (!byHero.has(r.heroId)) byHero.set(r.heroId, new Map()); byHero.get(r.heroId).set(r.time, [r.matchCount, r.winCount]); }
    for (const [h, at] of byHero) {
      if (!known.has(h)) continue;
      const need = [0, NOBODY_DONE_BY, ...CUTS].map((t) => at.get(t));
      if (need.some((x) => !x)) throw new Error(`week ${iso(w)} ${k} hero ${h}: a minute this script reads is missing`);
      // The reading this file rests on: counts never rise with the minute, and nobody is done by minute 8.
      const series = [...at].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
      for (let i = 1; i < series.length; i += 1) if (series[i][0] > series[i - 1][0] || series[i][1] > series[i - 1][1]) throw new Error(`week ${iso(w)} ${k} hero ${h}: counts rise with the minute — not "games that reached it"`);
      if (need[1][0] !== need[0][0] || need[1][1] !== need[0][1]) throw new Error(`week ${iso(w)} ${k} hero ${h}: games already over by minute ${NOBODY_DONE_BY} — not "games that reached it"`);
      const [all, , at35, at45] = need;
      const groups = [[all[0] - at35[0], all[1] - at35[1]], [at35[0] - at45[0], at35[1] - at45[1]], [at45[0], at45[1]]];
      const sum = (heroes[k][h] ??= [[0, 0], [0, 0], [0, 0]]);
      groups.forEach((g, i) => { sum[i][0] += g[0]; sum[i][1] += g[1]; });
      games[k] += all[0];
    }
  }
  await sleep(500);
}
// Every game has ten heroes.
for (const k of Object.keys(games)) games[k] = Math.round(games[k] / 10);

const out = {
  source: 'STRATZ (https://stratz.com) heroStats.stats by minute, public matches by rank bracket; not filtered by game mode',
  attribution: { en: 'Data: STRATZ', url: 'https://stratz.com' },
  patch,
  weeks: { from: iso(weeks.at(-1)), to: iso(weeks[0] + WEEK - 1), count: weeks.length },
  fetched: new Date().toISOString().slice(0, 10),
  brackets: BRACKETS,
  // Game length in minutes: under the first cut, between the cuts, the second cut or more.
  cuts: CUTS,
  games,
  heroes,
};
writeFileSync(OUT, `${JSON.stringify(out)}\n`);
console.error(`wrote ${OUT.pathname}: ${Object.entries(heroes).map(([k, v]) => `${k} ${Object.keys(v).length} heroes / ${games[k]} games`).join(', ')}`);
