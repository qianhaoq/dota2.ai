#!/usr/bin/env node
/**
 * Regenerates lib/coach/data/patch-meta.json: every hero's games and wins in
 * public matches in the days before the current patch and in the days since,
 * overall and per rank bracket, from STRATZ (https://stratz.com — data credit
 * required on every surface that shows it).
 *
 * Source: heroStats.winDay — per hero and UTC day, matchCount and winCount.
 * The patch and the moment it went live are read from
 * lib/coach/data/patch-notes.json (Valve's own timestamp; run
 * scripts/coach-patch-notes.mjs first).
 *
 * - before: the BEFORE_DAYS whole UTC days before the day the patch landed;
 * - after:  every whole UTC day after that day which STRATZ has finished
 *           counting (a day is used only once it ended SETTLE_HOURS ago).
 * The day the patch landed holds games of both patches and is in neither.
 *
 * Per bracket b (all, hg, ca, la, di):
 *   heroes[b][h] = [games before, wins before, games after, wins after]
 *   games[b]     = [matches before, matches after]   (hero games / 10)
 * A hero's pick rate is its games over the matches of the same window.
 *
 * Checked on every run, and the run stops without writing otherwise: each
 * window has all its days for every bracket, and over all heroes the wins
 * are half the games (every match has five winners among its ten heroes).
 * Not filtered by game mode (the same games as the other STRATZ snapshots).
 *
 * One request. Needs STRATZ_API_TOKEN (never printed):
 *   STRATZ_API_TOKEN=... node scripts/coach-patch-meta.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const TOKEN = process.env.STRATZ_API_TOKEN?.trim();
if (!TOKEN) { console.error('STRATZ_API_TOKEN is not set'); process.exit(2); }
const NOTES = JSON.parse(readFileSync(new URL('../lib/coach/data/patch-notes.json', import.meta.url)));
const NAMES = JSON.parse(readFileSync(new URL('../lib/coach/data/names.json', import.meta.url)));
const OUT = new URL('../lib/coach/data/patch-meta.json', import.meta.url);

const DAY = 86400;
const BEFORE_DAYS = 7;
const MAX_AFTER_DAYS = 28;
/** A day is used once it has been over this long: STRATZ is still counting the latest games. */
const SETTLE_HOURS = 6;
const BRACKETS = { all: null, hg: ['HERALD', 'GUARDIAN'], ca: ['CRUSADER', 'ARCHON'], la: ['LEGEND', 'ANCIENT'], di: ['DIVINE', 'IMMORTAL'] };
const iso = (s) => new Date(s * 1000).toISOString().slice(0, 10);

const released = Math.floor(Date.parse(NOTES.released) / 1000);
if (!Number.isFinite(released)) throw new Error('patch-notes.json has no release time');
const patchDay = Math.floor(released / DAY) * DAY;
const now = Math.floor(Date.now() / 1000);
const beforeDays = Array.from({ length: BEFORE_DAYS }, (_, i) => patchDay - (i + 1) * DAY).reverse();
const afterDays = [];
for (let d = patchDay + DAY; d + DAY + SETTLE_HOURS * 3600 <= now && afterDays.length < MAX_AFTER_DAYS; d += DAY) afterDays.push(d);
if (!afterDays.length) throw new Error(`no whole day of ${NOTES.version} has been counted yet`);

const take = Math.ceil((now - beforeDays[0]) / DAY) + 2;
const query = `{ heroStats { ${Object.entries(BRACKETS).map(([k, ids]) => `${k}: winDay(take: ${take}${ids ? `, bracketIds: [${ids.join(', ')}]` : ''}) { day heroId matchCount winCount }`).join(' ')} } }`;
const res = await fetch('https://api.stratz.com/graphql', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'user-agent': 'STRATZ_API' },
  body: JSON.stringify({ query }),
});
if (res.status === 401 || res.status === 403) throw new Error(`STRATZ rejected the token (${res.status})`);
const body = await res.json().catch(() => null);
if (!res.ok || !body?.data?.heroStats || body.errors) throw new Error(`STRATZ: HTTP ${res.status} ${body?.errors?.map((e) => e.message).join(' | ') ?? ''}`);

const known = new Set(Object.keys(NAMES.heroes).map(Number));
const heroes = {}; const games = {};
for (const k of Object.keys(BRACKETS)) {
  const rows = body.data.heroStats[k] ?? [];
  const seen = new Set(rows.map((r) => r.day));
  // The last day wanted may simply not be counted yet: the window ends at the last day STRATZ has.
  const after = afterDays.filter((d) => seen.has(d));
  if (after.length !== afterDays.length) {
    const missing = afterDays.filter((d) => !seen.has(d));
    if (missing.some((d) => d < after.at(-1)) || !after.length) throw new Error(`${k}: STRATZ has no data for ${missing.map(iso).join(', ')}`);
  }
  for (const d of beforeDays) if (!seen.has(d)) throw new Error(`${k}: STRATZ has no data for ${iso(d)}`);
  heroes[k] = { after };
  const acc = new Map();
  for (const r of rows) {
    if (!known.has(r.heroId)) continue;
    const i = beforeDays.includes(r.day) ? 0 : after.includes(r.day) ? 2 : -1;
    if (i < 0) continue;
    const a = acc.get(r.heroId) ?? [0, 0, 0, 0];
    a[i] += r.matchCount; a[i + 1] += r.winCount;
    acc.set(r.heroId, a);
  }
  heroes[k].rows = acc;
}
// Every bracket must cover the same days: the windows are stated once for the whole file.
const lastAfter = Math.min(...Object.values(heroes).map((h) => h.after.at(-1)));
const after = afterDays.filter((d) => d <= lastAfter);
if (Object.values(heroes).some((h) => h.after.length !== after.length)) {
  // A bracket ahead of another by a day: count again over the days all of them have.
  for (const k of Object.keys(BRACKETS)) {
    const acc = new Map();
    for (const r of body.data.heroStats[k]) {
      if (!known.has(r.heroId)) continue;
      const i = beforeDays.includes(r.day) ? 0 : after.includes(r.day) ? 2 : -1;
      if (i < 0) continue;
      const a = acc.get(r.heroId) ?? [0, 0, 0, 0];
      a[i] += r.matchCount; a[i + 1] += r.winCount;
      acc.set(r.heroId, a);
    }
    heroes[k].rows = acc;
  }
}
const out = {
  source: 'STRATZ (https://stratz.com) heroStats.winDay, public matches by day and rank bracket; not filtered by game mode',
  attribution: { en: 'Data: STRATZ', url: 'https://stratz.com' },
  patch: NOTES.version,
  released: NOTES.released,
  before: { from: iso(beforeDays[0]), to: iso(beforeDays.at(-1)), days: beforeDays.length },
  after: { from: iso(after[0]), to: iso(after.at(-1)), days: after.length },
  fetched: new Date().toISOString().slice(0, 10),
  brackets: Object.keys(BRACKETS),
  games: {},
  heroes: {},
};
for (const k of Object.keys(BRACKETS)) {
  const rows = [...heroes[k].rows].sort((a, b) => a[0] - b[0]);
  const sum = (i) => rows.reduce((a, [, r]) => a + r[i], 0);
  for (const [w, g, n] of [['before', 0, 1], ['after', 2, 3]]) {
    const share = sum(n) / sum(g);
    if (!(Math.abs(share - 0.5) < 0.01)) throw new Error(`${k} ${w}: wins are ${(share * 100).toFixed(1)}% of hero games, not half — not what this file takes the counts to be`);
  }
  games[k] = [Math.round(sum(0) / 10), Math.round(sum(2) / 10)];
  out.heroes[k] = Object.fromEntries(rows);
}
out.games = games;
writeFileSync(OUT, `${JSON.stringify(out)}\n`);
console.error(`wrote ${OUT.pathname}: ${out.patch}, before ${out.before.from}..${out.before.to}, after ${out.after.from}..${out.after.to}; ${Object.entries(games).map(([k, g]) => `${k} ${g[0]}/${g[1]} matches`).join(', ')}`);
