#!/usr/bin/env node
/**
 * Which calibration rates moved: compare a new run of scripts/calibrate.mjs --json with the last one kept in the
 * repo (data/calibration.v1.json), or any two runs (lib/agent/calibrationDiff.js says how rows are read and judged).
 *
 *   node scripts/calibrate.mjs <dir with *.trace.json.gz> --json > new.json
 *   node scripts/calibrate-diff.mjs new.json                    # against data/calibration.v1.json
 *   node scripts/calibrate-diff.mjs old.json new.json [--json]
 *
 * A listed rate is one the prompt or docs/GAME_UNDERSTANDING.md may quote: check it there, and when the new
 * corpus is the one to keep, copy new.json over data/calibration.v1.json in the same pull request.
 * Exit status: 0 nothing moved · 1 a rate moved · 2 usage or unreadable input.
 */
import { readFileSync } from 'node:fs';
import { compareCalibration } from '../lib/agent/calibrationDiff.js';

const KEPT = new URL('../data/calibration.v1.json', import.meta.url);

function main(argv) {
  const json = argv.includes('--json');
  const files = argv.filter((a) => a !== '--json');
  if (files.length < 1 || files.length > 2 || files.some((f) => f.startsWith('--'))) { console.error('Usage: node scripts/calibrate-diff.mjs [old.json] new.json [--json]'); return 2; }
  let before; let after;
  try { before = JSON.parse(readFileSync(files.length === 2 ? files[0] : KEPT, 'utf8')); after = JSON.parse(readFileSync(files[files.length - 1], 'utf8')); } catch { console.error('Could not read the calibration files.'); return 2; }
  const r = compareCalibration(before, after);
  if (json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`Games: ${r.games.before} → ${r.games.after}. ${r.shifted.length} rate(s) moved beyond noise, ${r.held} held, ${r.too_few} with too few cases to call.`);
    for (const s of r.shifted) console.log(`  ${s.row} · ${s.outcome}: ${s.before.rate}% of ${s.before.of} → ${s.after.rate}% of ${s.after.of} (z ${s.z})`);
    if (r.new_rows.length) console.log(`New rows: ${r.new_rows.length}\n${r.new_rows.map((x) => `  ${x}`).join('\n')}`);
    if (r.gone_rows.length) console.log(`Rows no longer there: ${r.gone_rows.length}\n${r.gone_rows.map((x) => `  ${x}`).join('\n')}`);
  }
  return r.shifted.length ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
