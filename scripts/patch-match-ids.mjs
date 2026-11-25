#!/usr/bin/env node
/**
 * Adds to lib/data/constants/patches/index.json, for each release, the match
 * ids on either side of its rollout: the last match that started before
 * `rollout_from` and the first that started at or after `rollout_by`
 * (scripts/coach-patch-snapshots.mjs writes those two times). Match ids grow
 * with time, so a game's release (and the hotfix within it: each of a release's
 * `hotfixes` gets the same two ids) is then known from its id alone — without
 * the match data (OpenDota can be down; the replay trace has no date).
 *
 *   STRATZ_API_TOKEN=… node scripts/patch-match-ids.mjs
 *
 * Start times of matches: STRATZ (match(id).startDateTime). Ids are searched by
 * halving the range, twenty neighbouring ids per request (not every id is a
 * match). A release whose ids are already in the index is skipped.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const TOKEN = process.env.STRATZ_API_TOKEN?.trim();
if (!TOKEN) { console.error('STRATZ_API_TOKEN is not set'); process.exit(2); }
const FILE = new URL('../lib/data/constants/patches/index.json', import.meta.url);
const index = JSON.parse(readFileSync(FILE, 'utf8'));
/** A match known to have started after every rollout looked for (anchors the search). */
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
/** A match at or just after `id`, with its start time. Around a rollout few ids are real matches: look further out. */
async function near(id) {
  for (const offset of [0, 20, 40, 60, 80, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000, 200_000]) {
    const got = await startTimes(Array.from({ length: PROBE }, (_, i) => id + offset + i));
    if (got.length) return got[0];
  }
  throw new Error(`no match near ${id}`);
}
/**
 * The last match started before `t` and the first started at or after it, as neighbours among the ids that are
 * matches. `start`: a match known to have started after `t`, to search back from (the newest found so far).
 */
async function around(t, start) {
  let hi = start;
  if (hi.start < t) throw new Error(`match ${hi.id} started before ${new Date(t * 1000).toISOString()}`);
  let step = 200_000; let lo = await near(Math.max(1, hi.id - step));
  while (lo.start >= t) { hi = lo; step *= 2; lo = await near(Math.max(1, hi.id - step)); }
  while (hi.id - lo.id > PROBE) {
    const mid = await near(Math.floor((lo.id + hi.id) / 2));
    if (mid.id >= hi.id) break;
    if (mid.start < t) lo = mid; else hi = mid;
  }
  const between = hi.id - lo.id < 200 ? await startTimes(Array.from({ length: hi.id - lo.id + 1 }, (_, i) => lo.id + i)) : [lo, hi];
  const before = between.filter((x) => x.start < t).at(-1) ?? lo;
  const after = between.find((x) => x.start >= t && x.id > before.id) ?? hi;
  return { before, after };
}

// Newest first: each search starts from the ids the newer one found, a few million back instead of from the anchor.
let from = await near(ANCHOR);
// A release's hotfixes have rollouts too: a game's hotfix is then known from its id as well.
const labels = new Map();
const rollouts = [...index.releases];
for (const r of index.releases) for (const h of r.hotfixes ?? []) { labels.set(h, `${r.name} hotfix ${h.rollout_by.slice(0, 16)}`); rollouts.push(h); }
for (const r of rollouts.sort((a, b) => Date.parse(b.rollout_by) - Date.parse(a.rollout_by))) {
  // Already found: the next search starts from this release's last match before its rollout.
  if (r.first_match_id_after) { from = await near(r.last_match_id_before); continue; }
  const by = await around(Math.floor(Date.parse(r.rollout_by) / 1000), from);
  const before = await around(Math.floor(Date.parse(r.rollout_from) / 1000), by.after);
  r.last_match_id_before = before.before.id;
  r.first_match_id_after = by.after.id;
  // It started before this rollout and after every older one: where the next, older search starts.
  from = before.before;
  console.log(`${labels.get(r) ?? r.name}: last match before ${r.rollout_from} ${r.last_match_id_before}, first at or after ${r.rollout_by} ${r.first_match_id_after}`);
}
writeFileSync(FILE, `${JSON.stringify(index, null, 2)}\n`);
console.log(`${requests} requests`);
