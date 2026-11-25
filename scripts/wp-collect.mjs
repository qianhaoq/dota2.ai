#!/usr/bin/env node
/**
 * Training data for the win-probability model (packages/review-engine/src/value): public matches OpenDota has
 * parsed, one compact row each. No model call, no key: OpenDota's public API, at its free rate.
 *
 *   node scripts/wp-collect.mjs --out <dir> [--games 1500] [--reserve 600]
 *
 * Why OpenDota and not STRATZ: the review's tools read the gold lead as gold EARNED (the match record's
 * radiant_gold_adv, or the same thing summed from the replay's combat log — goldLead in trace/tools.js).
 * STRATZ's radiantNetworthLeads is net worth, about 1,100 a minute away from it on the game compared; a model
 * must be trained on the quantity it will be given.
 *
 * What is kept per game (<dir>/games.jsonl, appended; a rerun skips ids already there):
 *   id, win (Radiant won), dur (s), patch, mode, lobby, rank (mean rank_tier of the players who have one, or null),
 *   leaver (any player left), gold (radiant_gold_adv), xp (radiant_xp_adv),
 *   xp_t ([radiant players' xp by minute], [dire players']), b ([[time s, building name]…] in order),
 *   rosh ([[time s, side that killed it: 2 Radiant, 3 Dire, or null]…]).
 * What is skipped, and counted in <dir>/skipped.json: not 10 humans, not a ranked lobby, not Ranked All Pick,
 * under 15 minutes, no gold or xp series, or the two series not as long as the game. The record itself is
 * checked: with or without the STRATZ pre-filter below, only ranked All Pick games are kept.
 *
 * --reserve: stop when OpenDota says fewer than this many calls are left for the day from this address.
 *
 * Most matches OpenDota lists as parsed are Turbo (9 kept of the first 50 fetched), and each fetch is one of
 * about 2,800 a day. With STRATZ_API_TOKEN in the environment the ids are first asked of STRATZ, fifty to a
 * request (one unit of its quota): only ranked All Pick games of 15 minutes or more are then fetched. The token
 * is read from the environment and never printed. Without it every listed id is fetched, and the same games
 * are kept — it only costs more of the quota.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The cohort: ranked matchmaking (lobby_type 7), Ranked All Pick (game_mode 22). Checked on the fetched record itself, whoever filtered the ids. */
const RANKED_LOBBY = 7; const RANKED_ALL_PICK = 22;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let left = { minute: 60, day: Infinity };
async function get(path) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (left.minute <= 2) await sleep(20_000);
    let res; try { res = await fetch(`https://api.opendota.com/api${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(40_000) }); } catch { await sleep(5000 * (attempt + 1)); continue; }
    const m = Number(res.headers.get('x-rate-limit-remaining-minute')); const d = Number(res.headers.get('x-rate-limit-remaining-day'));
    if (Number.isFinite(m)) left.minute = m; if (Number.isFinite(d)) left.day = d;
    if (res.status === 429) { await sleep(30_000); continue; }
    if (res.status === 404) return null;
    if (!res.ok) { await sleep(5000 * (attempt + 1)); continue; }
    try { return await res.json(); } catch { return null; }
  }
  return undefined; // gave up: not the same as "no such match"
}

/** Of these ids, the ranked All Pick games of 15 minutes or more, as STRATZ knows them; null when it cannot be asked. */
async function rankedOf(ids, token) {
  const keep = [];
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    const query = `{ ${part.map((id, k) => `m${k}: match(id: ${id}) { id lobbyType gameMode durationSeconds }`).join(' ')} }`;
    let body = null;
    for (let attempt = 0; attempt < 3 && !body; attempt += 1) {
      try {
        const res = await fetch('https://api.stratz.com/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'user-agent': 'STRATZ_API' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(40_000) });
        if (res.status === 401 || res.status === 403) return null;
        if (res.ok) body = await res.json(); else await sleep(4000 * (attempt + 1));
      } catch { await sleep(4000 * (attempt + 1)); }
    }
    if (!body?.data) return null;
    for (const m of Object.values(body.data)) if (m && m.lobbyType === 'RANKED' && m.gameMode === 'ALL_PICK_RANKED' && m.durationSeconds >= 900) keep.push(Number(m.id));
    await sleep(400);
  }
  return keep;
}

/** One parsed match → the row kept, or the reason it is not. */
export function rowOf(m) {
  if (!m || typeof m.radiant_win !== 'boolean') return { skip: 'no_result' };
  if (m.human_players !== 10 || !Array.isArray(m.players) || m.players.length !== 10) return { skip: 'not_ten_players' };
  if (m.lobby_type !== RANKED_LOBBY) return { skip: 'not_ranked' };
  if (m.game_mode !== RANKED_ALL_PICK) return { skip: 'game_mode' };
  if (!(m.duration >= 900)) return { skip: 'under_15_minutes' };
  const gold = m.radiant_gold_adv; const xp = m.radiant_xp_adv;
  if (!Array.isArray(gold) || !Array.isArray(xp) || !gold.every(Number.isFinite) || !xp.every(Number.isFinite)) return { skip: 'no_series' };
  const minutes = Math.floor(m.duration / 60);
  if (gold.length < minutes || xp.length < minutes) return { skip: 'series_shorter_than_the_game' };
  const side = (radiant) => m.players.filter((p) => (p.isRadiant ?? p.player_slot < 128) === radiant).map((p) => (Array.isArray(p.xp_t) ? p.xp_t : null));
  const xpT = [side(true), side(false)];
  if (xpT.some((s) => s.length !== 5 || s.some((a) => !a))) return { skip: 'no_player_xp' };
  const ranks = m.players.map((p) => p.rank_tier).filter(Number.isInteger);
  const objectives = Array.isArray(m.objectives) ? m.objectives : [];
  return {
    id: m.match_id, win: m.radiant_win, dur: m.duration, patch: m.patch ?? null, mode: m.game_mode, lobby: m.lobby_type ?? null,
    rank: ranks.length ? Math.round((ranks.reduce((a, b) => a + b, 0) / ranks.length) * 10) / 10 : null,
    leaver: m.players.some((p) => (p.leaver_status ?? 0) > 1),
    gold, xp, xp_t: xpT,
    b: objectives.filter((o) => o.type === 'building_kill' && typeof o.key === 'string' && Number.isFinite(o.time)).map((o) => [o.time, o.key]),
    rosh: objectives.filter((o) => o.type === 'CHAT_MESSAGE_ROSHAN_KILL' && Number.isFinite(o.time)).map((o) => [o.time, o.team === 2 || o.team === 3 ? o.team : null]),
  };
}

import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (name, d = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] != null ? args[i + 1] : d; };
  const out = flag('--out');
  const want = Number(flag('--games', '1500'));
  const reserve = Number(flag('--reserve', '600'));
  if (!out || !Number.isInteger(want) || want < 1 || !Number.isInteger(reserve) || reserve < 0) { console.error('usage: node scripts/wp-collect.mjs --out <dir> [--games N] [--reserve N]'); process.exit(2); }
  mkdirSync(out, { recursive: true });
  const file = join(out, 'games.jsonl'); const skippedFile = join(out, 'skipped.json');
  const have = new Set(existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id) : []);
  const skipped = existsSync(skippedFile) ? JSON.parse(readFileSync(skippedFile, 'utf8')) : { ids: [], why: {} };
  const seen = new Set([...have, ...skipped.ids]);
  let cursor = null; let pages = 0;
  const token = process.env.STRATZ_API_TOKEN || null;
  const saveSkipped = () => writeFileSync(skippedFile, `${JSON.stringify(skipped)}\n`);
  while (have.size < want) {
    if (left.day < reserve) { console.log(`stopping: ${left.day} calls left today, reserve ${reserve}`); break; }
    const page = await get(`/parsedMatches${cursor ? `?less_than_match_id=${cursor}` : ''}`);
    if (!Array.isArray(page) || !page.length) { console.log('no more parsed matches listed'); break; }
    pages += 1; cursor = page.at(-1).match_id;
    let ids = page.map((r) => r.match_id).filter((id) => !seen.has(id));
    if (token && ids.length) {
      const ranked = await rankedOf(ids, token);
      if (ranked) { const set = new Set(ranked); for (const id of ids) if (!set.has(id)) { seen.add(id); skipped.ids.push(id); skipped.why.not_ranked_all_pick_by_stratz = (skipped.why.not_ranked_all_pick_by_stratz ?? 0) + 1; } ids = ranked; }
      else console.log('STRATZ could not be asked: fetching every listed id');
    }
    for (const id of ids) {
      if (seen.has(id)) continue;
      if (have.size >= want || left.day < reserve) break;
      const m = await get(`/matches/${id}`);
      await sleep(1100);
      if (m === undefined) continue; // not read: try it on another run
      seen.add(id);
      const row = rowOf(m);
      if (row.skip) { skipped.ids.push(id); skipped.why[row.skip] = (skipped.why[row.skip] ?? 0) + 1; continue; }
      appendFileSync(file, `${JSON.stringify(row)}\n`); have.add(id);
      if (have.size % 50 === 0) { saveSkipped(); console.log(`${new Date().toISOString().slice(11, 19)} kept ${have.size}/${want}, skipped ${skipped.ids.length} ${JSON.stringify(skipped.why)}, calls left today ${left.day}`); }
    }
    saveSkipped();
  }
  saveSkipped();
  console.log(`done: ${have.size} games in ${file}; skipped ${skipped.ids.length} ${JSON.stringify(skipped.why)}; pages ${pages}; calls left today ${left.day}`);
}
