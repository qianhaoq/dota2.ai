#!/usr/bin/env node
/**
 * Check the STRATZ fallback against OpenDota on a real match, once a token
 * exists (run it yourself; the token is read from the environment, never
 * printed or written):
 *
 *   STRATZ_API_TOKEN=... node scripts/stratz-check.mjs [matchId=9091400302]
 *
 * 1. Fetches the match from STRATZ through lib/upstream/stratz.js and from
 *    OpenDota, and lists every mapped field that disagrees.
 * 2. Prints a short sample of the STRATZ fields that are NOT mapped yet
 *    (per-minute arrays, kill/death events with positions) next to their
 *    OpenDota counterparts, to decide how to map them.
 * Exit code 1 when a mapped field disagrees.
 */
import { createStratzClient, STRATZ_URL } from '../lib/upstream/stratz.js';

const token = process.env.STRATZ_API_TOKEN;
if (!token) { console.error('set STRATZ_API_TOKEN'); process.exit(2); }
const id = Number(process.argv[2] || 9091400302);

const stratz = await createStratzClient({ token }).fetchMatch(id);
const odRes = await fetch(`https://api.opendota.com/api/matches/${id}`);
if (!odRes.ok) { console.error(`OpenDota HTTP ${odRes.status}`); process.exit(2); }
const od = await odRes.json();

const diffs = [];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
for (const k of ['match_id', 'radiant_win', 'radiant_score', 'dire_score', 'duration', 'start_time', 'game_mode', 'lobby_type', 'cluster', 'patch']) {
  if (!same(stratz[k], od[k])) diffs.push(`match.${k}: stratz=${stratz[k]} opendota=${od[k]}`);
}
const lead = (a, b) => (Array.isArray(a) && Array.isArray(b) ? Math.max(...a.slice(0, b.length).map((v, i) => Math.abs(v - b[i]))) : null);
console.log(`radiant lead, max |STRATZ networth − OpenDota gold| per minute: ${lead(stratz.radiant_gold_adv, od.radiant_gold_adv)}`);
for (const p of stratz.players) {
  const o = od.players.find((x) => x.player_slot === p.player_slot);
  if (!o) { diffs.push(`slot ${p.player_slot}: missing in OpenDota`); continue; }
  for (const k of ['hero_id', 'kills', 'deaths', 'assists', 'last_hits', 'denies', 'gold_per_min', 'xp_per_min', 'net_worth', 'level', 'item_0', 'item_1', 'item_2', 'item_3', 'item_4', 'item_5', 'lane', 'is_roaming']) {
    if (!same(p[k], o[k])) diffs.push(`slot ${p.player_slot} ${k}: stratz=${p[k]} opendota=${o[k]}`);
  }
  if (Array.isArray(o.purchase_log)) {
    const a = p.purchase_log?.length ?? 0; const b = o.purchase_log.length;
    if (Math.abs(a - b) > 2) diffs.push(`slot ${p.player_slot} purchase_log: stratz=${a} opendota=${b} entries`);
  }
}

// Unmapped fields, side by side, for the next mapping step.
const probe = await fetch(STRATZ_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'user-agent': 'STRATZ_API' },
  body: JSON.stringify({ query: `query ($id: Long!) { match(id: $id) { players { playerSlot isRadiant heroId stats {
    goldPerMinute networthPerMinute lastHitsPerMinute experiencePerMinute
    killEvents { time target positionX positionY } deathEvents { time attacker positionX positionY timeDead } } } } }`, variables: { id } }),
}).then((r) => r.json()).catch(() => null);
const sp = probe?.data?.match?.players?.find((p) => p.isRadiant) ?? null;
const op = od.players.find((p) => p.hero_id === sp?.heroId);
if (sp && op) {
  console.log(`\nunmapped sample, ${op.hero_id}:`);
  console.log(`  STRATZ goldPerMinute[0..11]      ${JSON.stringify(sp.stats?.goldPerMinute?.slice(0, 12))}`);
  console.log(`  STRATZ networthPerMinute[0..11]  ${JSON.stringify(sp.stats?.networthPerMinute?.slice(0, 12))}`);
  console.log(`  OpenDota gold_t[0..11]           ${JSON.stringify(op.gold_t?.slice(0, 12))}`);
  console.log(`  STRATZ lastHitsPerMinute[0..11]  ${JSON.stringify(sp.stats?.lastHitsPerMinute?.slice(0, 12))}`);
  console.log(`  OpenDota lh_t[0..11]             ${JSON.stringify(op.lh_t?.slice(0, 12))}`);
  console.log(`  STRATZ deathEvents[0..2]         ${JSON.stringify(sp.stats?.deathEvents?.slice(0, 3))}`);
  console.log(`  OpenDota deaths (kills_log of enemies) — compare times`);
}

if (diffs.length) {
  console.error(`\n${diffs.length} mapped field(s) disagree:\n${diffs.join('\n')}`);
  process.exit(1);
}
console.log('\nmapped fields agree with OpenDota');
