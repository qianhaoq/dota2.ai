#!/usr/bin/env node
/**
 * Writes lib/data/constants/patches/index.json: for each patch the site keeps
 * data for, its release time and the match ids on either side of it — the
 * last match that started before the release and the first that started
 * after. Match ids grow with time, so a game's patch is known from its id
 * alone, without the match data (OpenDota can be down; the replay trace has
 * no date).
 *
 *   STRATZ_API_TOKEN=… node scripts/patch-match-ids.mjs
 *
 * Release times: OpenDota's patch list (in OpenDota's constants repository).
 * Start times of matches: STRATZ (match(id).startDateTime). Ids are searched
 * by halving the range, twenty neighbouring ids per request (not every id is
 * a match). A game whose id falls between the two ids of a boundary is not
 * assigned a patch.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const TOKEN = process.env.STRATZ_API_TOKEN?.trim();
if (!TOKEN) { console.error('STRATZ_API_TOKEN is not set'); process.exit(2); }
const OUT = new URL('../lib/data/constants/patches/index.json', import.meta.url);
const CURRENT = JSON.parse(readFileSync(new URL('../lib/coach/data/abilities.json', import.meta.url))).patch;
const FIRST = '7.40';
/** A match known to have started after every release looked for (anchors the search). */
const ANCHOR = Number(process.argv[2] ?? 9100904020);
const PROBE = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let requests = 0;
async function startTimes(ids) {
  const body = { query: `{ ${ids.map((id) => `m${id}: match(id: ${id}) { id startDateTime }`).join(' ')} }` };
  for (let attempt = 0; attempt < 6; attempt += 1) {
    requests += 1;
    const res = await fetch('https://api.stratz.com/graphql', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'user-agent': 'STRATZ_API' }, body: JSON.stringify(body) });
    if (res.ok) {
      const json = await res.json();
      return ids.map((id) => ({ id, start: json.data?.[`m${id}`]?.startDateTime ?? null })).filter((x) => Number.isFinite(x.start));
    }
    await sleep(res.status === 429 ? 30_000 : 2000 * (attempt + 1));
  }
  throw new Error('STRATZ request failed');
}
/** A match at or just after `id`, with its start time. */
async function near(id) {
  // Around a release the servers are down for the update and few ids are real matches: look further out, then further.
  for (const offset of [0, 20, 40, 60, 80, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000, 200_000]) {
    const got = await startTimes(Array.from({ length: PROBE }, (_, i) => id + offset + i));
    if (got.length) return got[0];
  }
  throw new Error(`no match near ${id}`);
}

const patches = (await (await fetch('https://raw.githubusercontent.com/odota/dotaconstants/master/build/patch.json')).json())
  .map((p) => ({ name: p.name, id: p.id, released: Math.floor(Date.parse(p.date) / 1000) })).sort((a, b) => a.id - b.id);
const wanted = patches.filter((p) => p.id >= patches.find((x) => x.name === FIRST).id && p.id <= patches.find((x) => x.name === CURRENT).id);

const out = [];
for (const p of wanted) {
  // Bracket the release: hi started after it; step back by doubling until lo started before it.
  let hi = await near(ANCHOR);
  if (hi.start < p.released) throw new Error(`anchor ${ANCHOR} started before ${p.name}`);
  let step = 1_000_000; let lo = await near(hi.id - step);
  while (lo.start >= p.released) { hi = lo; step *= 2; lo = await near(Math.max(1, hi.id - step)); }
  // Halve until the two are neighbours among the ids that are matches.
  while (hi.id - lo.id > PROBE) {
    const mid = await near(Math.floor((lo.id + hi.id) / 2));
    // No match between the middle and hi: lo and hi are as close as the matches go.
    if (mid.id >= hi.id) break;
    if (mid.start < p.released) lo = mid; else hi = mid;
  }
  const between = hi.id - lo.id < 200 ? await startTimes(Array.from({ length: hi.id - lo.id + 1 }, (_, i) => lo.id + i)) : [lo, hi];
  const before = between.filter((x) => x.start < p.released).at(-1) ?? lo;
  const after = between.find((x) => x.start >= p.released && x.id > before.id) ?? hi;
  out.push({ id: p.id, name: p.name, released: new Date(p.released * 1000).toISOString(), last_match_id_before: before.id, first_match_id_after: after.id });
  console.log(`${p.name}: released ${new Date(p.released * 1000).toISOString()}, last match before ${before.id}, first after ${after.id}`);
}
writeFileSync(OUT, `${JSON.stringify({
  source: 'Release times: OpenDota patch list. Match start times: STRATZ. A game is in the latest patch whose first_match_id_after is at or below its id; an id between last_match_id_before and first_match_id_after is not assigned.',
  patches: out,
}, null, 2)}\n`);
console.log(`${requests} requests`);
