#!/usr/bin/env node
/**
 * Regenerates lib/coach/data/matchups-rank.json: hero-vs-hero win rates and
 * same-lane outcomes in public matches, per rank bracket, from STRATZ
 * (https://stratz.com — data credit required on every surface that shows it).
 *
 * Per bracket b (hg = Herald–Guardian, ca = Crusader–Archon,
 * la = Legend–Ancient, di = Divine–Immortal):
 * - `vs[b][h][v]`   = [games, wins] for h with v on the enemy team (n >= 100 kept).
 * - `base[b][h]`    = [games, wins] for h (from the same rows: every game has
 *                     five enemies, so the sums are divided by five).
 * - `lane[b][h][v]` = [won, even, lost, stomp won, stomp lost] lanes where h
 *                     laned against v (STRATZ laneOutcome). The five are
 *                     disjoint and add up to STRATZ's matchCount (checked
 *                     here: a stomp is not also counted as a win or loss);
 *                     total >= 50 kept.
 *
 * Window: the last N completed calendar weeks (Monday 00:00 UTC) that lie
 * wholly inside one patch. STRATZ keys these aggregates by week, not patch:
 * an in-progress week returns partial data, so it is never used.
 * Not filtered by game mode (STRATZ's matchUp/laneOutcome take no mode
 * argument): some unranked games are in the sample.
 *
 * One GraphQL request per 8 heroes per week (--batch; aliases cost nothing
 * extra): 4 weeks x 16 = 64 requests.
 * Needs STRATZ_API_TOKEN (never printed). Responses are cached per
 * hero/week, so a rerun after a 429 resumes:
 *   STRATZ_API_TOKEN=... node scripts/coach-matchups-rank.mjs [--weeks 4]
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = process.env.STRATZ_API_TOKEN?.trim();
if (!TOKEN) { console.error('STRATZ_API_TOKEN is not set'); process.exit(2); }
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const WEEKS = Number(arg('weeks', 4));
const CACHE = arg('cache', join(tmpdir(), 'dota2ai-stratz-cache-v2'));
const NAMES = JSON.parse(readFileSync(new URL('../lib/coach/data/names.json', import.meta.url)));
const OUT = new URL('../lib/coach/data/matchups-rank.json', import.meta.url);

const BRACKETS = { hg: 'HERALD_GUARDIAN', ca: 'CRUSADER_ARCHON', la: 'LEGEND_ANCIENT', di: 'DIVINE_IMMORTAL' };
// The engine's own floors (lib/coach/matchupsRank.js): smaller pairs could never carry a claim.
const VS_KEEP = 100;
const LANE_KEEP = 50;
const DAY = 86400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (s) => new Date(s * 1000).toISOString().slice(0, 10);

// Patch windows (OpenDota constants), to keep every week inside one patch.
const patches = await (await fetch('https://api.opendota.com/api/constants/patch')).json();
const starts = patches.map((p) => ({ name: p.name, at: Math.floor(Date.parse(p.date) / 1000) })).sort((a, b) => a.at - b.at);
const patchAt = (s) => starts.filter((p) => p.at <= s).at(-1);

const now = Math.floor(Date.now() / 1000);
const today = Math.floor(now / DAY) * DAY;
const thisMonday = today - ((new Date(today * 1000).getUTCDay() + 6) % 7) * DAY;
const weeks = [];
let patch = null;
for (let w = thisMonday - 7 * DAY; weeks.length < WEEKS && w > thisMonday - 60 * 7 * DAY; w -= 7 * DAY) {
  const a = patchAt(w); const b = patchAt(w + 7 * DAY - 1);
  if (a.name !== b.name) { if (weeks.length) break; continue; } // a patch landed inside this week
  if (patch && a.name !== patch) break;
  patch = a.name;
  weeks.push(w);
}
if (!weeks.length) throw new Error('no completed week inside one patch');
console.error(`patch ${patch}, weeks ${weeks.map(iso).join(', ')}`);

// Aliases cost nothing extra (one request = one quota unit), so one request
// carries BATCH heroes x 4 brackets x (matchUp + laneOutcome).
const BATCH = Number(arg('batch', 8));
const fields = (h) => Object.entries(BRACKETS).map(([k, b]) => `
  m_${k}_${h}: matchUp(heroId: ${h}, week: $w, bracketBasicIds: [${b}], take: 200) { vs { heroId2 matchCount winCount } }
  l_${k}_${h}: laneOutcome(heroId: ${h}, isWith: false, week: $w, bracketBasicIds: [${b}]) { heroId2 matchCount winCount drawCount lossCount stompWinCount stompLossCount }`).join('');
const cacheFile = (h, w) => join(CACHE, String(w), `${h}.json`);
let requests = 0;

/** Fetches every uncached hero of `hs` for week `w` in one request; cache stays one file per hero/week. */
async function fetchBatch(hs, w) {
  const todo = hs.filter((h) => !existsSync(cacheFile(h, w)));
  if (!todo.length) return;
  const query = `query ($w: Long) { heroStats { ${todo.map(fields).join('')} } }`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch('https://api.stratz.com/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'user-agent': 'STRATZ_API' },
      body: JSON.stringify({ query, variables: { w } }),
    });
    requests++;
    if (res.status === 429) { console.error('429 — waiting 60s'); await sleep(60000); continue; }
    if (res.status === 401 || res.status === 403) throw new Error(`STRATZ rejected the token (${res.status})`);
    const body = await res.json().catch(() => null);
    const d = body?.data?.heroStats;
    if (res.ok && d && !body.errors) {
      mkdirSync(join(CACHE, String(w)), { recursive: true });
      for (const h of todo) {
        const one = {};
        for (const k of Object.keys(BRACKETS)) { one[`m_${k}`] = d[`m_${k}_${h}`]; one[`l_${k}`] = d[`l_${k}_${h}`]; }
        writeFileSync(cacheFile(h, w), JSON.stringify(one));
      }
      await sleep(500);
      return;
    }
    console.error(`heroes ${todo.join(',')} week ${iso(w)}: HTTP ${res.status} ${body?.errors?.map((e) => e.message).join(' | ') ?? ''}`);
    await sleep(3000 * (attempt + 1));
  }
  throw new Error(`heroes ${todo.join(',')} week ${iso(w)} failed`);
}
const readHeroWeek = (h, w) => JSON.parse(readFileSync(cacheFile(h, w), 'utf8'));

const heroes = Object.keys(NAMES.heroes).map(Number);
for (const w of weeks) for (let i = 0; i < heroes.length; i += BATCH) await fetchBatch(heroes.slice(i, i + BATCH), w);
console.error(`${requests} requests`);
let laneRows = 0; let laneMismatch = 0;
const vs = {}; const lane = {}; const base = {};
for (const k of Object.keys(BRACKETS)) { vs[k] = {}; lane[k] = {}; base[k] = {}; }
let done = 0;
for (const h of heroes) {
  const acc = {};
  for (const k of Object.keys(BRACKETS)) acc[k] = { vs: new Map(), lane: new Map() };
  for (const w of weeks) {
    const d = readHeroWeek(h, w);
    for (const k of Object.keys(BRACKETS)) {
      for (const r of d[`m_${k}`]?.[0]?.vs ?? []) {
        if (!r.heroId2) continue;
        const a = acc[k].vs.get(r.heroId2) ?? [0, 0];
        acc[k].vs.set(r.heroId2, [a[0] + r.matchCount, a[1] + r.winCount]);
      }
      for (const r of d[`l_${k}`] ?? []) {
        if (!r.heroId2) continue;
        laneRows++;
        if (r.winCount + r.drawCount + r.lossCount + r.stompWinCount + r.stompLossCount !== r.matchCount) laneMismatch++;
        const a = acc[k].lane.get(r.heroId2) ?? [0, 0, 0, 0, 0];
        acc[k].lane.set(r.heroId2, [a[0] + r.winCount, a[1] + r.drawCount, a[2] + r.lossCount, a[3] + r.stompWinCount, a[4] + r.stompLossCount]);
      }
    }
  }
  for (const k of Object.keys(BRACKETS)) {
    let n = 0; let wins = 0;
    const v = {}; const l = {};
    for (const [id, [g, wn]] of acc[k].vs) { n += g; wins += wn; if (g >= VS_KEEP) v[id] = [g, wn]; }
    for (const [id, row] of acc[k].lane) if (row.reduce((x, y) => x + y, 0) >= LANE_KEEP) l[id] = row;
    if (n) base[k][h] = [Math.round(n / 5), Math.round(wins / 5)];
    if (Object.keys(v).length) vs[k][h] = v;
    if (Object.keys(l).length) lane[k][h] = l;
  }
  done++;
  if (done % 10 === 0) console.error(`${done}/${heroes.length} heroes`);
}

// The five outcomes must partition matchCount, or the shares below mean something else.
if (laneMismatch > laneRows * 0.001) throw new Error(`laneOutcome: ${laneMismatch}/${laneRows} rows do not add up to matchCount`);
const games = Object.fromEntries(Object.keys(BRACKETS).map((k) => [k, Object.values(base[k]).reduce((s, [g]) => s + g, 0) / 10 | 0]));
writeFileSync(OUT, JSON.stringify({
  source: 'STRATZ (https://stratz.com) heroStats.matchUp and heroStats.laneOutcome, public matches by rank bracket; not filtered by game mode',
  attribution: { en: 'Data: STRATZ', url: 'https://stratz.com' },
  patch,
  weeks: { from: iso(weeks.at(-1)), to: iso(weeks[0] + 6 * DAY), count: weeks.length },
  fetched: iso(now),
  brackets: BRACKETS,
  games,
  base, vs, lane,
}));
console.error(`wrote ${OUT.pathname}; games per bracket ${JSON.stringify(games)}`);
