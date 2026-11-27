#!/usr/bin/env node
/**
 * Calibrate replay-based 1–5 role inference (lib/agent/roleFromReplay.js) against parsed OpenDota match records
 * (lib/coach/analyze.js's lane-based role assignment) on games that have both.
 *
 *   node scripts/calibrate-role.mjs <traces dir> <match records dir> [--json]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { linkHeroNames } from '../packages/review-engine/src/trace/index.js';
import { heroByKey } from '../packages/review-engine/src/staticHeroes.js';
import { buildCoachReport } from '../lib/coach/analyze.js';
import { inferTeamRolesFromReplay } from '../lib/agent/roleFromReplay.js';

const [dir, od] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!dir || !od) { console.error('usage: calibrate-role.mjs <traces dir> <match records dir> [--json]'); process.exit(2); }

let games = 0;
let heroes = 0;
let decided = 0;
let kindAgree = 0;
let posAgree = 0;
let gpmFallbackKindAgree = 0;
const mismatches = [];

for (const f of readdirSync(dir).filter((x) => x.endsWith('.trace.json.gz')).sort()) {
  const id = f.split('.')[0];
  const mp = join(od, `${id}.json`);
  if (!existsSync(mp)) continue;
  const match = JSON.parse(readFileSync(mp, 'utf8'));
  const report = buildCoachReport(match);
  // Only compare against teams where OpenDota parsed lanes cleanly produced a 1–5 assignment (`source === 'lanes'`).
  const trace = linkHeroNames(JSON.parse(gunzipSync(readFileSync(join(dir, f)))));
  // Also build an unparsed version of the same scoreboard (strip lane_role/gold_t) to measure how often
  // unparsed GPM-only fallback gets core/support wrong vs replay-based inference.
  const unparsed = {
    ...match,
    players: (match.players ?? []).map(({ lane_role, lane, is_roaming, gold_t, lh_t, dn_t, purchase_log, kills_log, ...rest }) => rest),
  };
  const fallbackReport = buildCoachReport(unparsed);
  let gameCounted = false;
  for (const team of [2, 3]) {
    const teamHeroes = trace.heroes.map((h, i) => ({ h, i })).filter(({ h }) => h.team === team);
    const ground = teamHeroes.map(({ h, i }) => {
      const hid = heroByKey(h.key)?.id;
      const p = report.players.find((x) => x.hero?.id === hid);
      const role = p ? report.reviews?.[p.slot]?.role : null;
      const fp = fallbackReport.players.find((x) => x.hero?.id === hid);
      const frole = fp ? fallbackReport.reviews?.[fp.slot]?.role : null;
      return { h, i, role, frole };
    });
    if (ground.some((g) => g.role?.source !== 'lanes')) continue;
    gameCounted = true;
    // Replay-only inference (no match record passed).
    const inferred = inferTeamRolesFromReplay(trace, team, null);
    for (const g of ground) {
      heroes += 1;
      if (g.frole?.kind === g.role.kind) gpmFallbackKindAgree += 1;
      const r = inferred.roles?.get(g.i);
      if (!r) continue;
      decided += 1;
      if (r.kind === g.role.kind) kindAgree += 1;
      if (r.pos === g.role.pos) posAgree += 1;
      else mismatches.push({ match: id, hero: g.h.key, expected: g.role.pos, got: r.pos, expectedKind: g.role.kind, gotKind: r.kind });
    }
  }
  if (gameCounted) games += 1;
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const out = {
  games,
  heroes,
  decided,
  core_support_agree: kindAgree,
  core_support_rate: pct(kindAgree, decided),
  exact_pos_agree: posAgree,
  exact_pos_rate: pct(posAgree, decided),
  unparsed_gpm_fallback_core_support_agree: gpmFallbackKindAgree,
  unparsed_gpm_fallback_core_support_rate: pct(gpmFallbackKindAgree, heroes),
  mismatches: mismatches.slice(0, 20),
};
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`${games} games (${heroes} heroes with parsed OpenDota 1–5 roles)`);
  console.log(`replay-only decided: ${decided}/${heroes}`);
  console.log(`core/support agree:  ${kindAgree}/${decided} (${out.core_support_rate}%)  [vs unparsed GPM-only fallback: ${gpmFallbackKindAgree}/${heroes} (${out.unparsed_gpm_fallback_core_support_rate}%)]`);
  console.log(`exact pos 1–5 agree: ${posAgree}/${decided} (${out.exact_pos_rate}%)`);
  if (mismatches.length) console.log('sample mismatches:', mismatches.slice(0, 10));
}
